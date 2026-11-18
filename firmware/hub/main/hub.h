// svitlo4u hub firmware: shared declarations. Protocol: docs/hub-protocol.md.
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define HUB_DEFAULT_SERVER "https://svitlo4u.info/iot/hub"

// ---------------------------------------------------------------------------------------------
// Time

/** Milliseconds since boot. */
uint32_t hub_ms(void);
/** Seconds since boot with milliseconds (the protocol's `up`). */
double hub_up(void);

// ---------------------------------------------------------------------------------------------
// Settings kept in NVS (config.c)

typedef struct {
    char dev[32];       // device id, e.g. hub-2a4c11
    char secret[96];    // HMAC key (hex text as on the server)
    char server[160];   // report URL
    char ssid[33];
    char pass[65];
    bool plug_paired;
    uint16_t plug_short;
    uint64_t plug_ieee;
    bool setup_mode;    // boot into the setup page (requested, or no Wi-Fi yet)
    bool pair_on_boot;  // open Zigbee pairing right after this boot
} hub_config_t;

extern hub_config_t g_cfg;

void config_load(void);
void config_save_identity(const char *dev, const char *secret);
void config_save_server(const char *url);
void config_save_wifi(const char *ssid, const char *pass);
void config_forget_wifi(void);
void config_save_plug(uint16_t short_addr, uint64_t ieee);
void config_forget_plug(void);
bool config_provisioned(void);
/** Persist the mode of the next boot: the setup page, and/or pairing right after the start. */
void config_set_next_boot(bool setup, bool pair);

/**
 * One radio cannot serve an access point and a Zigbee network at once (the access point misses
 * the phone, Zigbee misses the plug), so the hub runs one of two modes and restarts to switch:
 * setup (access point + page, no Zigbee) or normal (home Wi-Fi + Zigbee).
 */
void hub_restart_into(bool setup, bool pair);

// ---------------------------------------------------------------------------------------------
// Zigbee: the plug and the mains verdict (zb.c)

typedef enum { MAINS_UNKNOWN = 0, MAINS_ON, MAINS_OFF } mains_t;

typedef struct {
    bool paired;
    mains_t mains;
    double mains_since;     // hub uptime (s) when the verdict began, < 0 = unknown
    bool has_voltage;
    float voltage;
    bool has_rssi;
    int8_t rssi;
    bool network_up;
    uint32_t link_gaps;      // silences of the plug shorter than the alert delay: the radio link
    uint32_t longest_gap_ms;
    uint32_t confirm_ms;     // the alert delay: this long a silence is an outage
    bool has_rssi_avg;
    float rssi_avg;          // the plug's signal, averaged
    bool pairing_open;
    uint16_t pairing_left_s;
} plug_status_t;

void zb_start(void);
void zb_status(plug_status_t *out);
/** Open the network for a new plug (the next device that joins becomes the plug). */
void zb_open_pairing(void);
void zb_forget_plug(void);
/** Radio-level read results and the neighbor table, for the console. */
void zb_diag(char *out, size_t size);
/**
 * Wi-Fi needs the radio for up to `ms` (a connect, the router's check after lost beacons): no reads
 * of the plug meanwhile, and its silence in that time says nothing about the mains. 0: over.
 */
void zb_hold(uint32_t ms);

/** Mains changes waiting for the core's acknowledgement. */
typedef struct {
    double up;
    bool on;
} mains_event_t;

#define HUB_MAX_EVENTS 32
/** Copies up to `max` pending events (oldest first); returns how many. */
int events_peek(mains_event_t *out, int max);
/** Drops the `n` oldest events (the core acknowledged them). */
void events_drop(int n);
void events_push(double up, bool on);

// ---------------------------------------------------------------------------------------------
// Wi-Fi and the setup page (net.c)

typedef enum { WIFI_NONE = 0, WIFI_CONNECTING, WIFI_CONNECTED, WIFI_FAILED } wifi_state_t;

/** Home Wi-Fi; in setup mode also the access point «Svitlo4U-XXXX» with the setup page. */
void net_start(bool setup);
wifi_state_t net_wifi_state(void);
/** Last disconnect reason (esp_wifi codes), 0 if none. */
uint16_t net_wifi_reason(void);
bool net_portal_active(void);
/** Apply new credentials: save, connect. */
void net_wifi_set(const char *ssid, const char *pass);
/** hub_ms() of the last Wi-Fi or IP event the hub handled, and of the last address it got. */
uint32_t net_wifi_event_ms(void);
uint32_t net_wifi_up_ms(void);
/** Reconnect from scratch, even if the hub missed the drop (the watchdog). Blocks for up to 3 s. */
void net_wifi_kick(void);
/** Console test: drop Wi-Fi and lose the event about it, as on 2026-11-17. */
void net_test_lose_disconnect(void);
/** Console test: the same, after the driver's «beacon timeout» warning (how it really goes). */
void net_test_beacon_lost(void);

/** Wi-Fi as the reports and the console tell it (the report's `wifi`). */
typedef struct {
    bool has_router;       // connected: `rssi` and `channel` are the router's
    int8_t rssi;           // dBm
    uint8_t channel;
    uint32_t drops;        // times a working Wi-Fi was lost since the boot
    uint16_t reason;       // of the last drop (esp_wifi codes), 0 if none
    uint32_t last_down_ms; // how long the last drop lasted, until the address was back
} wifi_info_t;
void net_wifi_info(wifi_info_t *out);
/** Console: Wi-Fi sleeping between the router's beacons (the default) or always listening. */
bool net_wifi_sleep(bool on);

// ---------------------------------------------------------------------------------------------
// Reports to the core (report.c)

typedef enum { SERVER_UNKNOWN = 0, SERVER_OK, SERVER_FAILING, SERVER_REJECTED } server_state_t;

void report_start(void);
/** Send a report soon (a mains change). */
void report_kick(void);
server_state_t report_server_state(void);
int report_last_status(void);
/** hub_ms() of the last report that got any HTTP answer (from the start of reporting). */
uint32_t report_last_reply_ms(void);
/** Reports that got no answer even on a new connection, and those the second try saved. */
uint32_t report_lost(void);
uint32_t report_redone(void);
/** Console test: kill the kept connection under the next report (as the internet does). */
void report_test_dead_connection(void);

// ---------------------------------------------------------------------------------------------
// Watchdog: the hub must not stay silent while it could talk (watch.c)

void watch_start(bool normal);
/** Restart now, remembering why (the next boot shows it in the console). */
void watch_restart(const char *why);
/** Status line for the console. */
void watch_describe(char *out, size_t room);
/** Console tests: "loop-stuck", "wifi-lost", "kick-stuck", "beacon-lost", "conn-dead"; false for an unknown one. */
bool watch_test(const char *what);
/** Reconnects the watchdog had to force since the boot. */
uint32_t watch_kicks(void);

// ---------------------------------------------------------------------------------------------
// Updates over the air (ota.c)

typedef enum { OTA_IDLE = 0, OTA_DOWNLOADING, OTA_READY, OTA_FAILED } ota_state_t;

/** This image's version (firmware/hub/version.txt). */
const char *hub_fw_version(void);
/** At boot: a new image waits for its proof (or is kept at once in setup mode). */
void ota_init(bool setup);
/** After an acknowledged report: keeps a new image once Zigbee is up too. */
void ota_confirm(bool zigbee_up);
/** The core's offer from a reply to report `seq` of `boot`; `idle`: safe to update now. */
struct cJSON;
void ota_offer(const struct cJSON *offer, const char *boot, uint32_t seq, bool idle);
ota_state_t ota_state(void);
/** The report's `,"ota":{...}` part; returns its length. */
size_t ota_json(char *buf, size_t room);
void ota_describe(char *out, size_t room);

// ---------------------------------------------------------------------------------------------
// USB console (console.c) and status LED (main.c)

void console_start(void);
const char *hub_reset_reason(void);
