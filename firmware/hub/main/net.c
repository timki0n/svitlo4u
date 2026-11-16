// Wi-Fi: the home network (station) and the setup page (access point «Svitlo4U-XXXX» with a captive
// portal: every DNS name points at the hub, every unknown URL redirects to the page).
#include <stdio.h>
#include <string.h>

#include "cJSON.h"
#include "esp_coexist.h"
#include "esp_event.h"
#include "esp_ieee802154.h"
#include "esp_http_server.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "hub.h"
#include "lwip/sockets.h"

static const char *TAG = "net";

extern const char portal_html_start[] asm("_binary_portal_html_start");
extern const char portal_html_end[] asm("_binary_portal_html_end");

#define PORTAL_IP "192.168.4.1"
#define PORTAL_AUTO_STOP_MS (15 * 60 * 1000) // once the home Wi-Fi works

static volatile wifi_state_t wifi_state = WIFI_NONE;
static volatile uint16_t wifi_reason;
static volatile bool portal_on;
static volatile uint32_t portal_started_ms;
static uint32_t backoff_ms = 1000;
static esp_timer_handle_t reconnect_timer, portal_timer;
static httpd_handle_t httpd;
static int dns_sock = -1;
static TaskHandle_t dns_task_handle;
static esp_netif_t *sta_netif;
static char ap_ssid[32];

wifi_state_t net_wifi_state(void) { return wifi_state; }
uint16_t net_wifi_reason(void) { return wifi_reason; }
bool net_portal_active(void) { return portal_on; }

// ---------------------------------------------------------------------------------------------
// Station

static void connect_now(void *arg) {
    if (!g_cfg.ssid[0]) return;
    wifi_state = WIFI_CONNECTING;
    esp_wifi_connect();
}

static void apply_sta_config(void) {
    wifi_config_t wc = {0};
    strncpy((char *)wc.sta.ssid, g_cfg.ssid, sizeof(wc.sta.ssid));
    strncpy((char *)wc.sta.password, g_cfg.pass, sizeof(wc.sta.password));
    wc.sta.pmf_cfg.capable = true;
    wc.sta.sae_pwe_h2e = WPA3_SAE_PWE_BOTH;
    wc.sta.scan_method = WIFI_ALL_CHANNEL_SCAN;
    esp_wifi_set_config(WIFI_IF_STA, &wc);
}

static bool zigbee_mode; // normal mode: Zigbee shares the radio

/**
 * Radio sharing in the normal mode. By default Zigbee frames are low priority and Wi-Fi swallows
 * many of the plug's answers; with Zigbee on top Wi-Fi cannot even scan. So: defaults while Wi-Fi
 * connects, then Zigbee frames in the middle and their acknowledgements on top (measured
 * 2026-11-15: the plug answers ~46 times a second, Wi-Fi stays up).
 */
static void coex_for(bool wifi_connected) {
    if (!zigbee_mode) return;
    esp_ieee802154_coex_config_t c = {.idle = IEEE802154_IDLE, .txrx = IEEE802154_LOW, .txrx_at = IEEE802154_MIDDLE};
    if (wifi_connected) {
        c.txrx = IEEE802154_MIDDLE;
        c.txrx_at = IEEE802154_HIGH;
    }
    esp_ieee802154_set_coex_config(c);
}

static void wifi_event(void *arg, esp_event_base_t base, int32_t id, void *data) {
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        connect_now(NULL);
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        coex_for(false);
        wifi_reason = ((wifi_event_sta_disconnected_t *)data)->reason;
        if (!g_cfg.ssid[0]) {
            wifi_state = WIFI_NONE;
            return;
        }
        wifi_state = backoff_ms >= 8000 ? WIFI_FAILED : WIFI_CONNECTING;
        // Never block: retry later, slower each time (the legacy ESP blocked its loop for 10 s).
        esp_timer_stop(reconnect_timer);
        esp_timer_start_once(reconnect_timer, (uint64_t)backoff_ms * 1000);
        backoff_ms = backoff_ms < 30000 ? backoff_ms * 2 : 30000;
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        wifi_state = WIFI_CONNECTED;
        wifi_reason = 0;
        backoff_ms = 1000;
        coex_for(true);
        ESP_LOGI(TAG, "Wi-Fi connected");
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_AP_STACONNECTED) {
        portal_started_ms = hub_ms(); // someone is on the page: keep it up
    }
}

void net_wifi_set(const char *ssid, const char *pass) {
    config_save_wifi(ssid, pass);
    backoff_ms = 1000;
    wifi_reason = 0; // the page must not show the previous network's failure
    apply_sta_config();
    esp_wifi_disconnect();
    connect_now(NULL);
}

// ---------------------------------------------------------------------------------------------
// Captive DNS: answer every A query with the hub's address

static void dns_task(void *arg) {
    uint8_t buf[512];
    for (;;) {
        struct sockaddr_in from;
        socklen_t from_len = sizeof(from);
        int n = recvfrom(dns_sock, buf, sizeof(buf) - 16, 0, (struct sockaddr *)&from, &from_len);
        if (n < 0) break; // socket closed: the portal stopped
        if (n < 12) continue;
        // Find the end of the question (name, type, class).
        int q = 12;
        while (q < n && buf[q]) q += buf[q] + 1;
        q += 5;
        if (q > n) continue;
        uint16_t qtype = (buf[q - 4] << 8) | buf[q - 3];
        buf[2] = 0x84; // response, authoritative
        buf[3] = 0x00;
        buf[6] = 0;
        buf[7] = qtype == 1 ? 1 : 0; // one answer for A queries
        buf[8] = buf[9] = buf[10] = buf[11] = 0;
        int len = q;
        if (qtype == 1) {
            const uint8_t answer[] = {0xC0, 0x0C, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 192, 168, 4, 1};
            memcpy(buf + len, answer, sizeof(answer));
            len += sizeof(answer);
        }
        sendto(dns_sock, buf, len, 0, (struct sockaddr *)&from, from_len);
    }
    dns_task_handle = NULL;
    vTaskDelete(NULL);
}

static void dns_start(void) {
    dns_sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    struct sockaddr_in addr = {.sin_family = AF_INET, .sin_port = htons(53), .sin_addr.s_addr = htonl(INADDR_ANY)};
    if (bind(dns_sock, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
        ESP_LOGE(TAG, "dns bind failed");
        close(dns_sock);
        dns_sock = -1;
        return;
    }
    xTaskCreate(dns_task, "dns", 3072, NULL, 4, &dns_task_handle);
}

// ---------------------------------------------------------------------------------------------
// Setup page

static esp_err_t send_json(httpd_req_t *req, cJSON *json) {
    char *text = cJSON_PrintUnformatted(json);
    cJSON_Delete(json);
    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    esp_err_t err = httpd_resp_sendstr(req, text ? text : "{}");
    free(text);
    return err;
}

static esp_err_t page_get(httpd_req_t *req) {
    httpd_resp_set_type(req, "text/html; charset=utf-8");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    return httpd_resp_send(req, portal_html_start, portal_html_end - portal_html_start);
}

static const char *mains_name(mains_t m) { return m == MAINS_ON ? "on" : m == MAINS_OFF ? "off" : "unknown"; }

static esp_err_t status_get(httpd_req_t *req) {
    portal_started_ms = hub_ms();
    plug_status_t plug;
    zb_status(&plug);
    cJSON *j = cJSON_CreateObject();
    cJSON_AddStringToObject(j, "dev", g_cfg.dev[0] ? g_cfg.dev : ap_ssid);
    cJSON_AddStringToObject(j, "fw", hub_fw_version());
    cJSON_AddBoolToObject(j, "provisioned", config_provisioned());
    cJSON *w = cJSON_AddObjectToObject(j, "wifi");
    const char *ws[] = {"none", "connecting", "connected", "failed"};
    cJSON_AddStringToObject(w, "state", ws[wifi_state]);
    cJSON_AddStringToObject(w, "ssid", g_cfg.ssid);
    cJSON_AddNumberToObject(w, "reason", wifi_reason);
    cJSON *p = cJSON_AddObjectToObject(j, "plug");
    cJSON_AddBoolToObject(p, "paired", plug.paired);
    cJSON_AddStringToObject(p, "mains", mains_name(plug.mains));
    if (plug.has_voltage) cJSON_AddNumberToObject(p, "voltage", (int)(plug.voltage + 0.5f));
    cJSON_AddBoolToObject(p, "pairing", plug.pairing_open);
    cJSON_AddNumberToObject(p, "pairingLeft", plug.pairing_left_s);
    const char *ss[] = {"unknown", "ok", "failing", "rejected"};
    cJSON *s = cJSON_AddObjectToObject(j, "server");
    cJSON_AddStringToObject(s, "state", ss[report_server_state()]);
    return send_json(req, j);
}

static esp_err_t scan_get(httpd_req_t *req) {
    wifi_scan_config_t sc = {.show_hidden = false};
    cJSON *list = cJSON_CreateArray();
    // A station still trying a wrong password blocks scans: pause it for the scan.
    bool paused = g_cfg.ssid[0] && wifi_state != WIFI_CONNECTED;
    if (paused) {
        esp_timer_stop(reconnect_timer);
        esp_wifi_disconnect();
    }
    esp_err_t scanned = esp_wifi_scan_start(&sc, true);
    if (paused) connect_now(NULL);
    if (scanned == ESP_OK) {
        static wifi_ap_record_t aps[24];
        uint16_t n = sizeof(aps) / sizeof(aps[0]);
        esp_wifi_scan_get_ap_records(&n, aps);
        for (int i = 0; i < n; i++) {
            const char *name = (const char *)aps[i].ssid;
            if (!name[0]) continue;
            bool dup = false;
            for (int k = 0; k < i && !dup; k++) dup = strcmp(name, (const char *)aps[k].ssid) == 0;
            if (dup) continue;
            cJSON *ap = cJSON_CreateObject();
            cJSON_AddStringToObject(ap, "ssid", name);
            cJSON_AddNumberToObject(ap, "rssi", aps[i].rssi);
            cJSON_AddBoolToObject(ap, "secure", aps[i].authmode != WIFI_AUTH_OPEN);
            cJSON_AddItemToArray(list, ap);
        }
    }
    cJSON *j = cJSON_CreateObject();
    cJSON_AddItemToObject(j, "networks", list);
    return send_json(req, j);
}

static cJSON *read_body(httpd_req_t *req) {
    char buf[256];
    int len = req->content_len < sizeof(buf) - 1 ? req->content_len : sizeof(buf) - 1;
    int got = 0;
    while (got < len) {
        int r = httpd_req_recv(req, buf + got, len - got);
        if (r <= 0) return NULL;
        got += r;
    }
    buf[got] = 0;
    return cJSON_Parse(buf);
}

static esp_err_t wifi_post(httpd_req_t *req) {
    cJSON *body = read_body(req);
    const cJSON *ssid = cJSON_GetObjectItem(body, "ssid");
    const cJSON *pass = cJSON_GetObjectItem(body, "pass");
    bool ok = cJSON_IsString(ssid) && ssid->valuestring[0] && strlen(ssid->valuestring) <= 32 &&
              (!pass || (cJSON_IsString(pass) && strlen(pass->valuestring) <= 64));
    if (ok) net_wifi_set(ssid->valuestring, pass ? pass->valuestring : "");
    cJSON_Delete(body);
    cJSON *j = cJSON_CreateObject();
    cJSON_AddBoolToObject(j, "ok", ok);
    return send_json(req, j);
}

static volatile bool pair_after_restart;

static void leave_setup_cb(void *arg) { hub_restart_into(false, pair_after_restart); }

/** Leave the setup page for the normal mode (pairing right away or not), once Wi-Fi works. */
static esp_err_t leave_setup(httpd_req_t *req, bool pair) {
    bool ok = wifi_state == WIFI_CONNECTED;
    cJSON *j = cJSON_CreateObject();
    cJSON_AddBoolToObject(j, "ok", ok);
    esp_err_t err = send_json(req, j);
    if (ok) {
        pair_after_restart = pair;
        esp_timer_stop(portal_timer);
        esp_timer_start_once(portal_timer, 1500 * 1000); // let the answer reach the phone first
    }
    return err;
}

static esp_err_t pair_post(httpd_req_t *req) { return leave_setup(req, true); }
static esp_err_t done_post(httpd_req_t *req) { return leave_setup(req, false); }

/** Phones probe a known URL to detect a captive portal: send them to the page. */
static esp_err_t redirect(httpd_req_t *req, httpd_err_code_t err) {
    httpd_resp_set_status(req, "302 Found");
    httpd_resp_set_hdr(req, "Location", "http://" PORTAL_IP "/");
    httpd_resp_send(req, NULL, 0);
    return ESP_OK;
}

static void httpd_begin(void) {
    httpd_config_t cfg = HTTPD_DEFAULT_CONFIG();
    cfg.max_open_sockets = 5;
    cfg.lru_purge_enable = true;
    cfg.stack_size = 6144;
    if (httpd_start(&httpd, &cfg) != ESP_OK) {
        ESP_LOGE(TAG, "http server failed");
        return;
    }
    const httpd_uri_t routes[] = {
        {.uri = "/", .method = HTTP_GET, .handler = page_get},
        {.uri = "/api/status", .method = HTTP_GET, .handler = status_get},
        {.uri = "/api/scan", .method = HTTP_GET, .handler = scan_get},
        {.uri = "/api/wifi", .method = HTTP_POST, .handler = wifi_post},
        {.uri = "/api/pair", .method = HTTP_POST, .handler = pair_post},
        {.uri = "/api/done", .method = HTTP_POST, .handler = done_post},
    };
    for (size_t i = 0; i < sizeof(routes) / sizeof(routes[0]); i++) httpd_register_uri_handler(httpd, &routes[i]);
    httpd_register_err_handler(httpd, HTTPD_404_NOT_FOUND, redirect);
}

// ---------------------------------------------------------------------------------------------
// The setup page (setup mode only: see hub_restart_into)

static void portal_start(void) {
    if (portal_on) return;
    wifi_config_t ap = {0};
    strncpy((char *)ap.ap.ssid, ap_ssid, sizeof(ap.ap.ssid));
    ap.ap.ssid_len = strlen(ap_ssid);
    ap.ap.channel = 1;
    ap.ap.max_connection = 3;
    ap.ap.authmode = WIFI_AUTH_OPEN;
    esp_wifi_set_mode(WIFI_MODE_APSTA);
    esp_wifi_set_config(WIFI_IF_AP, &ap);
    portal_on = true;
    portal_started_ms = hub_ms();
    dns_start();
    httpd_begin();
    ESP_LOGI(TAG, "setup page on: Wi-Fi «%s», http://" PORTAL_IP "/", ap_ssid);
}

static void portal_watch_task(void *arg) {
    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(5000));
        // Forgotten on the page with a working home Wi-Fi: back to the normal mode.
        if (portal_on && wifi_state == WIFI_CONNECTED && hub_ms() - portal_started_ms > PORTAL_AUTO_STOP_MS)
            hub_restart_into(false, false);
    }
}

void net_start(bool setup) {
    uint8_t mac[6];
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    snprintf(ap_ssid, sizeof(ap_ssid), "Svitlo4U-%02X%02X", mac[4], mac[5]);

    ESP_ERROR_CHECK(esp_netif_init());
    esp_err_t err = esp_event_loop_create_default();
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) ESP_ERROR_CHECK(err);
    // Wi-Fi and Zigbee share one radio: without this the 802.15.4 side keeps it all. Setup mode has
    // no Zigbee, and sharing with a radio nobody uses only costs the access point its replies.
    zigbee_mode = !setup;
    if (zigbee_mode) esp_coex_wifi_i154_enable();
    sta_netif = esp_netif_create_default_wifi_sta();
    esp_netif_create_default_wifi_ap();
    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));
    ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_RAM));
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, wifi_event, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, wifi_event, NULL));

    const esp_timer_create_args_t rt = {.callback = connect_now, .name = "wifi_retry"};
    esp_timer_create(&rt, &reconnect_timer);
    const esp_timer_create_args_t pt = {.callback = leave_setup_cb, .name = "leave_setup"};
    esp_timer_create(&pt, &portal_timer);

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    apply_sta_config();
    ESP_ERROR_CHECK(esp_wifi_start());
    if (setup) {
        portal_start();
        xTaskCreate(portal_watch_task, "portal_watch", 3072, NULL, 3, NULL);
    }
}
