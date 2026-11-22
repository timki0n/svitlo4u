// Watchdog: the hub must not stay silent while it could talk. On 2026-11-17 a beacon timeout took
// the hub off Wi-Fi and the firmware never heard of it: no reconnect, no reports for 9 hours, until
// a power cut restarted it. The same day it happened again when the router moved from channel 8 to
// 6: the Wi-Fi driver (sharing the radio with Zigbee) dropped the router and posted the event only
// when poked 3 minutes later. So:
//  - the default event loop (every Wi-Fi and IP event goes through it) answers a ping every 5 s;
//    a minute without an answer → restart;
//  - the driver is asked every 5 s whether it still has the router; the firmware thinks it is
//    connected, the driver has not had the router for 10 s → reconnect Wi-Fi; a driver that stops
//    answering for a minute → restart (since 0.2.5 net.c looks itself 3 s after the driver's
//    «beacon timeout» and usually gets there first: this stays for a drop without that warning);
//  - Wi-Fi looks connected, yet no report got any answer for 3 minutes → reconnect Wi-Fi from
//    scratch; again after 3, 6, 12… up to 30 minutes (the internet behind a working router can be
//    down for hours, and that is not the hub's to fix);
//  - a reconnect that hangs (a stuck Wi-Fi driver) or brings no Wi-Fi event in a minute → restart;
//  - Wi-Fi not connected and not a single Wi-Fi event for 5 minutes (retries come every ≤ 30 s and
//    each ends in an event) → restart.
// The events not yet sent outlive a restart (zb.c keeps them in RTC memory), and the next boot
// tells the core why the hub restarted itself (the report's `why`): on 2026-11-20 it did so 85
// minutes into a morning without internet and nothing recorded which of the rules above it was.
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "esp_attr.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_private/system_internal.h"
#include "esp_system.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "hub.h"

static const char *TAG = "watch";

#define TICK_MS 5000
#define LOOP_DEAD_MS (60 * 1000)
#define PROBE_EVERY_MS 5000
#define ROUTER_LOST_MS (10 * 1000)
#define PROBE_DEAD_MS (60 * 1000)
#define QUIET_MS (3 * 60 * 1000)
#define KICK_EVERY_MAX_MS (30 * 60 * 1000)
#define KICK_HANG_MS (30 * 1000)
#define KICK_ANSWER_MS (60 * 1000)
#define WIFI_SILENT_MS (5 * 60 * 1000)

ESP_EVENT_DEFINE_BASE(HUB_WATCH_EVENT);
enum { WATCH_PING, WATCH_TEST_HANG };

static volatile uint32_t loop_seen_at;
static volatile bool kick_running, kick_hang_test;
static volatile uint32_t kick_started_at, kicks;
// What the driver says (probe_task): the last answer, the last time it had the router.
static volatile uint32_t probe_at, router_at;
static volatile bool has_router;

// Why the hub restarted itself (the watchdog, an update, the setup page), kept in RTC memory over
// the restart.
#define NOTE_MAGIC 0x57A7C4EDu
static RTC_NOINIT_ATTR uint32_t note_magic;
static RTC_NOINIT_ATTR char note[48];
static char last_restart[48];
static bool noted; // this boot has said why it will restart

/** a is later than b (hub_ms() wraps after 49 days). */
static bool later(uint32_t a, uint32_t b) { return (int32_t)(a - b) > 0; }

static void on_event(void *arg, esp_event_base_t base, int32_t id, void *data) {
    loop_seen_at = hub_ms();
    if (id == WATCH_TEST_HANG) {
        ESP_LOGW(TAG, "test: the event loop hangs now");
        for (;;) vTaskDelay(portMAX_DELAY);
    }
}

void hub_note_restart(const char *why) {
    if (noted) return;
    noted = true;
    strlcpy(note, why, sizeof(note));
    note_magic = NOTE_MAGIC;
}

const char *watch_last_restart(void) { return last_restart; }

void watch_restart(const char *why) {
    ESP_LOGE(TAG, "restarting: %s", why);
    hub_note_restart(why);
    vTaskDelay(pdMS_TO_TICKS(300)); // let the log out
    // Not esp_restart(): its shutdown handlers stop Wi-Fi, and that waits for the event loop, so a
    // stuck loop hangs the restart too (seen in `test loop-stuck`). Skip them, like a panic does.
    vTaskSuspendAll();
    esp_restart_noos();
}

static void kick_task(void *arg) {
    if (kick_hang_test) {
        ESP_LOGW(TAG, "test: the reconnect hangs now");
        for (;;) vTaskDelay(portMAX_DELAY);
    }
    net_wifi_kick();
    kick_running = false;
    vTaskDelete(NULL);
}

/** Asks the driver apart from the watchdog: a stuck driver must not stop the watchdog too. */
static void probe_task(void *arg) {
    for (;;) {
        wifi_ap_record_t ap;
        bool up = esp_wifi_sta_get_ap_info(&ap) == ESP_OK;
        uint32_t now = hub_ms();
        has_router = up;
        if (up) router_at = now;
        probe_at = now;
        vTaskDelay(pdMS_TO_TICKS(PROBE_EVERY_MS));
    }
}

static void start_kick(uint32_t now) {
    kicks++;
    kick_started_at = now;
    kick_running = true;
    if (xTaskCreate(kick_task, "wifi_kick", 3072, NULL, 5, NULL) != pdPASS) kick_running = false;
}

static void watch_task(void *arg) {
    bool normal = arg != NULL;
    uint32_t last_kick = 0, kick_every = QUIET_MS;
    bool awaiting = false; // the last reconnect has not produced a Wi-Fi event yet
    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(TICK_MS));
        uint32_t now = hub_ms();
        if (now - loop_seen_at > LOOP_DEAD_MS) watch_restart("the event loop stopped");
        // Never wait here: a full queue means a stuck loop as well.
        esp_event_post(HUB_WATCH_EVENT, WATCH_PING, NULL, 0, 0);
        if (!normal) continue; // the setup page: no reports to watch

        if (kick_running) {
            if (now - kick_started_at > KICK_HANG_MS) watch_restart("the Wi-Fi reconnect hung");
            continue;
        }
        if (now - probe_at > PROBE_DEAD_MS) watch_restart("the Wi-Fi driver stopped answering");
        uint32_t heard = net_wifi_event_ms();
        if (awaiting && !later(kick_started_at, heard)) awaiting = false;
        if (awaiting && now - kick_started_at > KICK_ANSWER_MS) watch_restart("no Wi-Fi events after a reconnect");
        wifi_state_t ws = net_wifi_state();
        if ((ws == WIFI_CONNECTING || ws == WIFI_FAILED) && now - heard > WIFI_SILENT_MS)
            watch_restart("Wi-Fi went silent");

        // The driver lost the router and said nothing (the hub would wait for the 3 minutes below).
        uint32_t had_router = later(router_at, net_wifi_up_ms()) ? router_at : net_wifi_up_ms();
        if (ws == WIFI_CONNECTED && !has_router && now - had_router > ROUTER_LOST_MS) {
            ESP_LOGW(TAG, "the driver lost the router %lu s ago without an event: reconnecting",
                     (unsigned long)((now - had_router) / 1000));
            awaiting = true;
            start_kick(now);
            continue;
        }
        if (!config_provisioned() || ws != WIFI_CONNECTED || ota_state() == OTA_DOWNLOADING) continue;

        uint32_t reply = report_last_reply_ms();
        if (last_kick && later(reply, last_kick)) { // the server answers again
            last_kick = 0;
            kick_every = QUIET_MS;
        }
        uint32_t since = later(net_wifi_up_ms(), reply) ? net_wifi_up_ms() : reply; // a fresh link gets its 3 min
        if (now - since < QUIET_MS) continue;
        if (last_kick) {
            if (now - last_kick < kick_every) continue;
            kick_every = kick_every * 2 < KICK_EVERY_MAX_MS ? kick_every * 2 : KICK_EVERY_MAX_MS;
        }
        ESP_LOGW(TAG, "no answer from the server for %lu s while Wi-Fi looks connected: reconnecting",
                 (unsigned long)((now - reply) / 1000));
        last_kick = now;
        awaiting = true;
        start_kick(now);
    }
}

void watch_start(bool normal) {
    if (note_magic == NOTE_MAGIC && esp_reset_reason() == ESP_RST_SW) {
        note[sizeof(note) - 1] = 0;
        strlcpy(last_restart, note, sizeof(last_restart));
        // It goes into the report's JSON as it is: plain text only.
        for (char *c = last_restart; *c; c++)
            if (*c < 0x20 || *c > 0x7e || *c == '"' || *c == '\\') *c = '?';
        ESP_LOGW(TAG, "the hub restarted itself: %s", last_restart);
    }
    note_magic = 0;
    loop_seen_at = probe_at = hub_ms();
    esp_event_handler_register(HUB_WATCH_EVENT, ESP_EVENT_ANY_ID, on_event, NULL);
    // Above the hub's other tasks: they have to run when the others hang.
    if (normal) xTaskCreate(probe_task, "wifi_probe", 3072, NULL, 7, NULL);
    xTaskCreate(watch_task, "watch", 3072, normal ? (void *)1 : NULL, 8, NULL);
}

uint32_t watch_kicks(void) { return kicks; }

void watch_describe(char *out, size_t room) {
    uint32_t now = hub_ms();
    snprintf(out, room,
             "watchdog: %lu Wi-Fi reconnects; driver has the router: %s; last Wi-Fi event %lu s ago, last server "
             "answer %lu s ago%s%s",
             (unsigned long)kicks, has_router ? "yes" : "no", (unsigned long)((now - net_wifi_event_ms()) / 1000),
             (unsigned long)((now - report_last_reply_ms()) / 1000), last_restart[0] ? "; restarted the hub: " : "",
             last_restart);
}

bool watch_test(const char *what) {
    if (!strcmp(what, "loop-stuck")) {
        esp_event_post(HUB_WATCH_EVENT, WATCH_TEST_HANG, NULL, 0, 0);
    } else if (!strcmp(what, "wifi-lost")) {
        net_test_lose_disconnect();
    } else if (!strcmp(what, "kick-stuck")) {
        kick_hang_test = true;
        net_test_lose_disconnect();
    } else if (!strcmp(what, "beacon-lost")) {
        net_test_beacon_lost();
    } else if (!strcmp(what, "conn-dead")) {
        report_test_dead_connection();
    } else {
        return false;
    }
    return true;
}
