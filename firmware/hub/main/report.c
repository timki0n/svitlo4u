// Reports to the core (docs/hub-protocol.md): POST every 30 s, at once after a mains change, and
// again every few seconds until the core acknowledges the events.
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
static char response[1536]; // an update offer carries a long URL
static int response_len;

server_state_t report_server_state(void) { return server_state; }
int report_last_status(void) { return last_status; }

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

/** Builds the report; returns how many pending events it carries. */
static int build(char *buf, size_t size, size_t *out_len) {
    plug_status_t p;
    zb_status(&p);
    mains_event_t ev[HUB_MAX_EVENTS];
    int n = events_peek(ev, HUB_MAX_EVENTS);
    size_t len = snprintf(buf, size,
                          "{\"v\":1,\"dev\":\"%s\",\"boot\":\"%s\",\"seq\":%lu,\"up\":%.3f,\"rst\":\"%s\",\"fw\":\"%s\","
                          "\"plug\":{\"paired\":%s,\"mains\":\"%s\",\"since\":",
                          g_cfg.dev, boot_id, (unsigned long)seq, hub_up(), hub_reset_reason(), hub_fw_version(),
                          p.paired ? "true" : "false",
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
    len += ota_json(buf + len, size - len);
    len += snprintf(buf + len, size - len, "}");
    *out_len = len;
    return n;
}

static esp_http_client_handle_t client_for(const char *url) {
    static char current[sizeof(g_cfg.server)];
    static esp_http_client_handle_t client;
    if (client && strcmp(current, url) == 0) return client;
    if (client) esp_http_client_cleanup(client);
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

/** One report; true when the core acknowledged it. */
static bool send_report(void) {
    static char body[2048];
    size_t len;
    int n = build(body, sizeof(body), &len);
    char sig[65];
    hmac_hex(g_cfg.secret, body, len, sig);

    esp_http_client_handle_t c = client_for(g_cfg.server);
    if (!c) return false;
    esp_http_client_set_header(c, "Content-Type", "application/json");
    esp_http_client_set_header(c, "X-Signature", sig);
    esp_http_client_set_post_field(c, body, len);
    response_len = 0;
    response[0] = 0;
    uint32_t sent_seq = seq++;
    esp_err_t err = esp_http_client_perform(c);
    int status = err == ESP_OK ? esp_http_client_get_status_code(c) : -1;
    last_status = status;
    if (status != 200) {
        server_state = (status == 401 || status == 403) ? SERVER_REJECTED : SERVER_FAILING;
        ESP_LOGW(TAG, "report %lu: %s, status %d", (unsigned long)sent_seq, esp_err_to_name(err), status);
        if (err != ESP_OK) {
            // A broken keep-alive connection: start over next time.
            esp_http_client_close(c);
        }
        return false;
    }
    cJSON *j = cJSON_Parse(response);
    const cJSON *ack = cJSON_GetObjectItem(j, "ack");
    bool acked = cJSON_IsNumber(ack) && (uint32_t)ack->valuedouble == sent_seq;
    if (acked) {
        events_drop(n);
        server_state = SERVER_OK;
        plug_status_t p;
        zb_status(&p);
        mains_event_t probe;
        // Updates only when nothing is waiting to be sent, the light is on and nobody is pairing.
        bool idle = events_peek(&probe, 1) == 0 && p.mains != MAINS_OFF && !p.pairing_open;
        ota_confirm(p.network_up);
        const cJSON *offer = cJSON_GetObjectItem(j, "ota");
        if (offer) ota_offer(offer, boot_id, sent_seq, idle);
        if (ota_state() == OTA_READY && idle) hub_restart_into(false, false); // into the new image
    } else {
        server_state = SERVER_FAILING;
    }
    cJSON_Delete(j);
    return acked;
}

static void report_task(void *arg) {
    uint32_t retry_ms = RETRY_MIN_MS;
    for (;;) {
        mains_event_t probe;
        bool pending = events_peek(&probe, 1) > 0;
        uint32_t wait = pending && server_state != SERVER_OK ? retry_ms : EVERY_MS;
        ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(wait));
        if (!config_provisioned() || net_wifi_state() != WIFI_CONNECTED) continue;
        if (send_report()) {
            retry_ms = RETRY_MIN_MS;
            // More events may have come while sending: go again at once.
            if (events_peek(&probe, 1) > 0) xTaskNotifyGive(task);
        } else {
            retry_ms = retry_ms * 2 < RETRY_MAX_MS ? retry_ms * 2 : RETRY_MAX_MS;
        }
    }
}

void report_start(void) {
    snprintf(boot_id, sizeof(boot_id), "%08lx", (unsigned long)esp_random());
    xTaskCreate(report_task, "report", 8192, NULL, 4, &task);
}
