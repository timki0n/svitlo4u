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

// ---------------------------------------------------------------------------------------------
// Reports to the core (report.c)

typedef enum { SERVER_UNKNOWN = 0, SERVER_OK, SERVER_FAILING, SERVER_REJECTED } server_state_t;

void report_start(void);
/** Send a report soon (a mains change). */
void report_kick(void);
server_state_t report_server_state(void);
int report_last_status(void);

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
