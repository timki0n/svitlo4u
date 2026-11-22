// Reports to the core (docs/hub-protocol.md): POST every 30 s, at once after a mains change and when
// Wi-Fi is back, and again every few seconds while they fail. The connection is kept between
// reports; the internet drops such connections whenever it likes (several times an hour at a home
// with a busy line, 2026-11-18: a PC next to the hub lost its own at the same moments), so a report
// that got no answer goes once more at once, on a new connection.
#include <stdio.h>
#include <string.h>

#include "cJSON.h"
#include "esp_crt_bundle.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_random.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "hub.h"
#include "lwip/sockets.h"
#include "mbedtls/md.h"

static const char *TAG = "report";

#define EVERY_MS 30000
#define RETRY_MIN_MS 3000
#define RETRY_MAX_MS 30000

static TaskHandle_t task;
static char boot_id[9];
static uint32_t seq;
static volatile server_state_t server_state = SERVER_UNKNOWN;
static volatile int last_status;
static volatile uint32_t last_reply_at; // any HTTP answer: the network works
static volatile uint32_t lost, redone;  // no answer on either connection; saved by the second try
// For the journal of the plug's silences (zb.c): requests started, those that had to open a
// connection, and when the last one started.
static volatile uint32_t starts, conns, started_at;
static bool connected; // the kept connection carried the last request through
static esp_http_client_handle_t client;
static char response[1536]; // an update offer carries a long URL
static int response_len;

server_state_t report_server_state(void) { return server_state; }
int report_last_status(void) { return last_status; }
uint32_t report_last_reply_ms(void) { return last_reply_at; }
uint32_t report_lost(void) { return lost; }
uint32_t report_redone(void) { return redone; }
uint32_t report_starts(void) { return starts; }
uint32_t report_conns(void) { return conns; }
uint32_t report_started_ms(void) { return started_at; }

void report_test_dead_connection(void) {
    int fd = client ? esp_http_client_get_socket(client) : -1;
    if (fd >= 0) shutdown(fd, SHUT_RDWR);
}

void report_kick(void) {
    if (task) xTaskNotifyGive(task);
}

static esp_err_t on_http(esp_http_client_event_t *e) {
    if (e->event_id == HTTP_EVENT_ON_DATA && e->data_len > 0) {
        int room = sizeof(response) - 1 - response_len;
        int n = e->data_len < room ? e->data_len : room;
        memcpy(response + response_len, e->data, n);
        response_len += n;
        response[response_len] = 0;
    }
    return ESP_OK;
}

static void hmac_hex(const char *key, const char *msg, size_t len, char out[65]) {
    uint8_t mac[32];
    mbedtls_md_hmac(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), (const uint8_t *)key, strlen(key),
                    (const uint8_t *)msg, len, mac);
    for (int i = 0; i < 32; i++) sprintf(out + i * 2, "%02x", mac[i]);
}

static void add_num(char *buf, size_t size, size_t *len, const char *fmt, double v, bool has) {
    if (has)
        *len += snprintf(buf + *len, size - *len, fmt, v);
    else
        *len += snprintf(buf + *len, size - *len, "null");
}

#define SILENCES_PER_REPORT 6
#define SILENCE_ROOM 240 // one of them in the body, at its longest

/** Builds the report; tells how many pending events and silences it carries. */
static void build(char *buf, size_t size, size_t *out_len, int *out_events, int *out_silences) {
    plug_status_t p;
    zb_status(&p);
    mains_event_t ev[HUB_MAX_EVENTS];
    int n = events_peek(ev, HUB_MAX_EVENTS);
    size_t len = snprintf(buf, size, "{\"v\":1,\"dev\":\"%s\",\"boot\":\"%s\",\"seq\":%lu,\"up\":%.3f,\"rst\":\"%s\",",
                          g_cfg.dev, boot_id, (unsigned long)seq, hub_up(), hub_reset_reason());
    // The hub's own word on why it restarted itself (the watchdog, an update, the setup page).
    if (watch_last_restart()[0]) len += snprintf(buf + len, size - len, "\"why\":\"%s\",", watch_last_restart());
    len += snprintf(buf + len, size - len, "\"fw\":\"%s\",\"plug\":{\"paired\":%s,\"mains\":\"%s\",\"since\":",
                    hub_fw_version(), p.paired ? "true" : "false",
                    p.mains == MAINS_ON ? "on" : p.mains == MAINS_OFF ? "off" : "unknown");
    add_num(buf, size, &len, "%.3f", p.mains_since, p.mains_since >= 0);
    len += snprintf(buf + len, size - len, ",\"voltage\":");
    add_num(buf, size, &len, "%.1f", p.voltage, p.has_voltage);
    len += snprintf(buf + len, size - len, ",\"rssi\":");
    add_num(buf, size, &len, "%.0f", p.rssi, p.has_rssi);
    len += snprintf(buf + len, size - len, ",\"gaps\":%lu,\"longestGap\":%.1f,\"delay\":%.0f,\"rssiAvg\":",
                    (unsigned long)p.link_gaps, p.longest_gap_ms / 1000.0, p.confirm_ms / 1000.0);
    add_num(buf, size, &len, "%.0f", p.rssi_avg, p.has_rssi_avg);
    len += snprintf(buf + len, size - len, "},\"events\":[");
    for (int i = 0; i < n; i++)
        len += snprintf(buf + len, size - len, "%s{\"up\":%.3f,\"mains\":\"%s\"}", i ? "," : "", ev[i].up,
                        ev[i].on ? "on" : "off");
    len += snprintf(buf + len, size - len, "]");
    wifi_info_t w;
    net_wifi_info(&w);
    len += snprintf(buf + len, size - len, ",\"wifi\":{\"rssi\":");
    add_num(buf, size, &len, "%.0f", w.rssi, w.has_router);
    len += snprintf(buf + len, size - len, ",\"ch\":");
    add_num(buf, size, &len, "%.0f", w.channel, w.has_router);
    len += snprintf(buf + len, size - len,
                    ",\"drops\":%lu,\"reason\":%u,\"down\":%.1f,\"kicks\":%lu,\"lost\":%lu,\"redone\":%lu}",
                    (unsigned long)w.drops, w.reason, w.last_down_ms / 1000.0, (unsigned long)watch_kicks(),
                    (unsigned long)lost, (unsigned long)redone);
    len += ota_json(buf + len, size - len);
    // The plug's silences of 3 s and more since the last acknowledged report (zb.c).
    static const char *const ends[] = {"read", "report", "default", "announce"};
    silence_t q[SILENCES_PER_REPORT];
    int m = silences_peek(q, SILENCES_PER_REPORT), told = 0;
    if (m > 0 && len + SILENCE_ROOM < size) {
        len += snprintf(buf + len, size - len, ",\"silences\":[");
        for (; told < m && len + SILENCE_ROOM < size; told++) {
            const silence_t *s = &q[told];
            len += snprintf(buf + len, size - len,
                            "%s{\"up\":%.3f,\"len\":%.2f,\"ok\":%u,\"fail\":%u,\"held\":%.1f,\"reports\":%u,\"conns\":%u,"
                            "\"drops\":%u,\"sinceReport\":",
                            told ? "," : "", s->up, s->len_ms / 1000.0, s->ok, s->failed, s->held_ms / 1000.0,
                            s->reports, s->conns, s->drops);
            add_num(buf, size, &len, "%.1f", s->since_report_ms / 1000.0, s->since_report_ms >= 0);
            len += snprintf(buf + len, size - len, ",\"endSinceReport\":");
            add_num(buf, size, &len, "%.1f", s->end_since_report_ms / 1000.0, s->end_since_report_ms >= 0);
            len += snprintf(buf + len, size - len, ",\"end\":\"%s\",\"off\":%s,\"saved\":%s,\"rssi\":%d}",
                            ends[s->end < 4 ? s->end : 0], s->off ? "true" : "false", s->saved ? "true" : "false",
                            s->rssi);
        }
        len += snprintf(buf + len, size - len, "]");
    }
    len += snprintf(buf + len, size - len, "}");
    *out_len = len;
    *out_events = n;
    *out_silences = told;
}

static esp_http_client_handle_t client_for(const char *url) {
    static char current[sizeof(g_cfg.server)];
    if (client && strcmp(current, url) == 0) return client;
    if (client) esp_http_client_cleanup(client);
    connected = false;
    strcpy(current, url);
    esp_http_client_config_t cfg = {
        .url = url,
        .method = HTTP_METHOD_POST,
        .timeout_ms = 10000,
        .event_handler = on_http,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .keep_alive_enable = true,
    };
    client = esp_http_client_init(&cfg);
    return client;
}

typedef enum { SENT_ACKED, SENT_REFUSED, SENT_DEAD } sent_t;

/** One request: acknowledged, answered otherwise, or no answer at all (the connection). */
static sent_t send_once(void) {
    // 32 events, 6 silences and the rest at their longest come to about 3.3 kB.
    static char body[4096];
    size_t len;
    int n, told;
    build(body, sizeof(body), &len, &n, &told);
    char sig[65];
    hmac_hex(g_cfg.secret, body, len, sig);

    esp_http_client_handle_t c = client_for(g_cfg.server);
    if (!c) return SENT_DEAD;
    esp_http_client_set_header(c, "Content-Type", "application/json");
    esp_http_client_set_header(c, "X-Signature", sig);
    esp_http_client_set_post_field(c, body, len);
    response_len = 0;
    response[0] = 0;
    uint32_t sent_seq = seq++;
    started_at = hub_ms();
    starts++;
    if (!connected) conns++;
    esp_err_t err = esp_http_client_perform(c);
    connected = err == ESP_OK;
    int status = err == ESP_OK ? esp_http_client_get_status_code(c) : -1;
    last_status = status;
    if (err == ESP_OK) last_reply_at = hub_ms();
    if (status != 200) {
        server_state = (status == 401 || status == 403) ? SERVER_REJECTED : SERVER_FAILING;
        ESP_LOGW(TAG, "report %lu: %s, status %d", (unsigned long)sent_seq, esp_err_to_name(err), status);
        if (err != ESP_OK) {
            // A broken keep-alive connection: start over next time.
            esp_http_client_close(c);
            return SENT_DEAD;
        }
        // A core from before 0.2.6 cannot read an event from before this boot (a negative `up`) and
        // would refuse every report that carries one: better to lose those than to stay unheard.
        if (status == 400 && events_drop_carried() > 0)
            ESP_LOGW(TAG, "the core refuses the events from before the restart: dropped");
        return SENT_REFUSED;
    }
    cJSON *j = cJSON_Parse(response);
    const cJSON *ack = cJSON_GetObjectItem(j, "ack");
    bool acked = cJSON_IsNumber(ack) && (uint32_t)ack->valuedouble == sent_seq;
    if (acked) {
        events_drop(n);
        silences_drop(told);
        server_state = SERVER_OK;
        plug_status_t p;
        zb_status(&p);
        mains_event_t probe;
        // Updates only when nothing is waiting to be sent, the light is on and nobody is pairing.
        bool idle = events_peek(&probe, 1) == 0 && p.mains != MAINS_OFF && !p.pairing_open;
        ota_confirm(p.network_up);
        const cJSON *offer = cJSON_GetObjectItem(j, "ota");
        if (offer) ota_offer(offer, boot_id, sent_seq, idle);
        if (ota_state() == OTA_READY && idle) {
            hub_note_restart("update");
            hub_restart_into(false, false); // into the new image
        }
    } else {
        server_state = SERVER_FAILING;
    }
    cJSON_Delete(j);
    return acked ? SENT_ACKED : SENT_REFUSED;
}

/** One report; true when the core acknowledged it. */
static bool send_report(void) {
    sent_t sent = send_once();
    if (sent != SENT_DEAD) return sent == SENT_ACKED;
    // No answer at all: most often the kept connection was dead. Once more, on a new one.
    if (net_wifi_state() == WIFI_CONNECTED) sent = send_once();
    if (sent == SENT_DEAD) {
        lost++;
        return false;
    }
    redone++;
    ESP_LOGI(TAG, "the report went through on a new connection");
    return sent == SENT_ACKED;
}

static void report_task(void *arg) {
    uint32_t retry_ms = RETRY_MIN_MS;
    bool failing = false;
    for (;;) {
        // After a failure soon again, slower each time, with events to tell or without (the core
        // must not wait 30 s to hear that the hub is fine).
        ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(failing ? retry_ms : EVERY_MS));
        if (!config_provisioned() || net_wifi_state() != WIFI_CONNECTED) continue;
        if (send_report()) {
            failing = false;
            retry_ms = RETRY_MIN_MS;
            // More events may have come while sending: go again at once.
            mains_event_t probe;
            if (events_peek(&probe, 1) > 0) xTaskNotifyGive(task);
        } else {
            if (failing) retry_ms = retry_ms * 2 < RETRY_MAX_MS ? retry_ms * 2 : RETRY_MAX_MS;
            failing = true;
        }
    }
}

void report_start(void) {
    snprintf(boot_id, sizeof(boot_id), "%08lx", (unsigned long)esp_random());
    last_reply_at = hub_ms();
    xTaskCreate(report_task, "report", 8192, NULL, 4, &task);
}
