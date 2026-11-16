// Updates over the air (docs/hub-protocol.md → Updates).
//
// The core offers a version in its reply to a report: URL, size, SHA-256 and an HMAC of them with
// the hub's secret, bound to that report's boot and seq. The hub downloads the image into the other
// app slot, checks size, hash, the image itself and its version, and restarts into it when nothing
// is waiting to be sent and the light is on. The new image has to prove itself: an acknowledged
// report with Zigbee up within 10 minutes, or the hub goes back to the old one (and so does the
// bootloader if it crashes before that). A version that failed this way is never taken again.
#include <stdio.h>
#include <string.h>

#include "cJSON.h"
#include "esp_app_desc.h"
#include "esp_crt_bundle.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "hub.h"
#include "mbedtls/md.h"
#include "mbedtls/sha256.h"

static const char *TAG = "ota";

#define CONFIRM_WITHIN_MS (10 * 60 * 1000)
#define RETRY_AFTER_MS (10 * 60 * 1000)
#define PROJECT "svitlo4u_hub"

static volatile ota_state_t state = OTA_IDLE;
static char target[32];   // version being downloaded / ready / failed
static char error[48];
static char rejected[32]; // a version that did not confirm itself and was rolled back
static char url[768];
static char sha_hex[65];
static uint32_t size;
static uint32_t failed_at;
static volatile bool pending_verify;

const char *hub_fw_version(void) { return esp_app_get_description()->version; }
ota_state_t ota_state(void) { return state; }

static void fail(const char *why) {
    snprintf(error, sizeof(error), "%s", why);
    failed_at = hub_ms();
    state = OTA_FAILED;
    ESP_LOGW(TAG, "update to %s failed: %s", target, error);
    report_kick();
}

static void rollback_task(void *arg) {
    vTaskDelay(pdMS_TO_TICKS(CONFIRM_WITHIN_MS));
    if (pending_verify) {
        ESP_LOGE(TAG, "%s did not confirm itself in time, going back", hub_fw_version());
        esp_ota_mark_app_invalid_rollback_and_reboot();
    }
    vTaskDelete(NULL);
}

void ota_init(bool setup) {
    esp_ota_img_states_t st;
    const esp_partition_t *running = esp_ota_get_running_partition();
    if (esp_ota_get_state_partition(running, &st) == ESP_OK && st == ESP_OTA_IMG_PENDING_VERIFY) {
        if (setup) {
            // The setup page came up: alive enough (there are no reports in this mode).
            esp_ota_mark_app_valid_cancel_rollback();
        } else {
            pending_verify = true;
            ESP_LOGI(TAG, "%s is new: waiting for a report and Zigbee to keep it", hub_fw_version());
            xTaskCreate(rollback_task, "ota_rb", 3072, NULL, 2, NULL);
        }
    }
    const esp_partition_t *bad = esp_ota_get_last_invalid_partition();
    esp_app_desc_t d;
    if (bad && esp_ota_get_partition_description(bad, &d) == ESP_OK &&
        strcmp(d.version, hub_fw_version()) != 0) {
        snprintf(rejected, sizeof(rejected), "%s", d.version);
        ESP_LOGW(TAG, "%s was rolled back earlier, it will not be taken again", rejected);
    }
}

void ota_confirm(bool zigbee_up) {
    if (!pending_verify || !zigbee_up) return;
    if (esp_ota_mark_app_valid_cancel_rollback() == ESP_OK) {
        pending_verify = false;
        ESP_LOGI(TAG, "%s confirmed", hub_fw_version());
    }
}

static bool hex_ok(const char *s, size_t n) {
    if (strlen(s) != n) return false;
    for (size_t i = 0; i < n; i++)
        if (!((s[i] >= '0' && s[i] <= '9') || (s[i] >= 'a' && s[i] <= 'f'))) return false;
    return true;
}

static const char *str(const cJSON *o, const char *key, size_t max) {
    const cJSON *v = cJSON_GetObjectItem(o, key);
    return cJSON_IsString(v) && strlen(v->valuestring) < max ? v->valuestring : NULL;
}

static void ota_task(void *arg) {
    const esp_partition_t *part = esp_ota_get_next_update_partition(NULL);
    esp_ota_handle_t h = 0;
    esp_http_client_handle_t c = NULL;
    static uint8_t buf[4096];
    mbedtls_sha256_context sha;
    mbedtls_sha256_init(&sha);
    uint32_t started = hub_ms();
    // Slow on purpose: Zigbee keeps the radio priority (the plug is read every second), so a
    // 1.5 MB image takes a few minutes.
    ESP_LOGI(TAG, "downloading %s (%lu bytes) into %s", target, (unsigned long)size, part ? part->label : "?");

    esp_http_client_config_t cfg = {
        .url = url,
        .timeout_ms = 20000,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .buffer_size = 2048,
        .buffer_size_tx = 1536, // presigned URLs are long
    };
    if (!part || size > part->size) {
        fail("no room");
        goto done;
    }
    c = esp_http_client_init(&cfg);
    if (!c || esp_http_client_open(c, 0) != ESP_OK) {
        fail("connect");
        goto done;
    }
    int64_t length = esp_http_client_fetch_headers(c);
    int status = esp_http_client_get_status_code(c);
    if (status != 200) {
        char why[24];
        snprintf(why, sizeof(why), "http %d", status);
        fail(why);
        goto done;
    }
    if (length > 0 && length != size) {
        fail("size");
        goto done;
    }
    // Erase as the data comes, not all at once (the radios keep running meanwhile).
    if (esp_ota_begin(part, OTA_WITH_SEQUENTIAL_WRITES, &h) != ESP_OK) {
        h = 0;
        fail("ota begin");
        goto done;
    }
    mbedtls_sha256_starts(&sha, 0);
    uint32_t total = 0;
    for (;;) {
        int n = esp_http_client_read(c, (char *)buf, sizeof(buf));
        if (n < 0) {
            fail("read");
            goto done;
        }
        if (n == 0) {
            if (esp_http_client_is_complete_data_received(c) || total == size) break;
            fail("read");
            goto done;
        }
        if (total + n > size) {
            fail("size");
            goto done;
        }
        mbedtls_sha256_update(&sha, buf, n);
        if (esp_ota_write(h, buf, n) != ESP_OK) {
            fail("write");
            goto done;
        }
        total += n;
    }
    if (total != size) {
        fail("size");
        goto done;
    }
    uint8_t digest[32];
    char hex[65];
    mbedtls_sha256_finish(&sha, digest);
    for (int i = 0; i < 32; i++) sprintf(hex + i * 2, "%02x", digest[i]);
    if (strcmp(hex, sha_hex) != 0) {
        fail("sha256");
        goto done;
    }
    esp_err_t err = esp_ota_end(h);
    h = 0;
    if (err != ESP_OK) {
        fail("image");
        goto done;
    }
    esp_app_desc_t d;
    if (esp_ota_get_partition_description(part, &d) != ESP_OK || strcmp(d.project_name, PROJECT) != 0 ||
        strcmp(d.version, target) != 0) {
        fail("version");
        goto done;
    }
    if (esp_ota_set_boot_partition(part) != ESP_OK) {
        fail("boot");
        goto done;
    }
    ESP_LOGI(TAG, "%s is ready (downloaded in %lu s), restarting when nothing is waiting", target,
             (unsigned long)((hub_ms() - started) / 1000));
    error[0] = 0;
    state = OTA_READY;
    report_kick();

done:
    if (h) esp_ota_abort(h);
    if (c) esp_http_client_cleanup(c);
    mbedtls_sha256_free(&sha);
    vTaskDelete(NULL);
}

void ota_offer(const cJSON *o, const char *boot, uint32_t seq, bool idle) {
    if (!cJSON_IsObject(o) || state == OTA_DOWNLOADING || state == OTA_READY || pending_verify) return;
    const char *version = str(o, "version", sizeof(target));
    const char *u = str(o, "url", sizeof(url) - 160);
    const char *sha = str(o, "sha256", sizeof(sha_hex));
    const char *sig = str(o, "sig", 65);
    const cJSON *sz = cJSON_GetObjectItem(o, "size");
    if (!version || !u || !sha || !sig || !cJSON_IsNumber(sz) || sz->valuedouble < 1024 ||
        sz->valuedouble > 4 * 1024 * 1024 || !hex_ok(sha, 64) || !hex_ok(sig, 64)) {
        ESP_LOGW(TAG, "unreadable offer");
        return;
    }
    uint32_t sz_bytes = (uint32_t)sz->valuedouble;

    // The offer is the core's: HMAC of what matters, bound to the report it answers.
    char msg[256], mac_hex[65];
    int len = snprintf(msg, sizeof(msg), "ota\n%s\n%s\n%lu\n%s\n%lu\n%s", g_cfg.dev, boot, (unsigned long)seq,
                       version, (unsigned long)sz_bytes, sha);
    uint8_t mac[32];
    mbedtls_md_hmac(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), (const uint8_t *)g_cfg.secret,
                    strlen(g_cfg.secret), (const uint8_t *)msg, len, mac);
    for (int i = 0; i < 32; i++) sprintf(mac_hex + i * 2, "%02x", mac[i]);
    if (strcmp(mac_hex, sig) != 0) {
        ESP_LOGW(TAG, "offer of %s with a wrong signature, ignored", version);
        return;
    }

    if (!strcmp(version, hub_fw_version()) || !strcmp(version, rejected)) return;
    if (state == OTA_FAILED && !strcmp(version, target) && hub_ms() - failed_at < RETRY_AFTER_MS) return;
    if (!idle) return; // events waiting or the light is off: not now

    // A path is on the report server.
    if (u[0] == '/') {
        const char *host = strstr(g_cfg.server, "://");
        const char *path = host ? strchr(host + 3, '/') : NULL;
        int base = path ? (int)(path - g_cfg.server) : (int)strlen(g_cfg.server);
        snprintf(url, sizeof(url), "%.*s%s", base, g_cfg.server, u);
    } else if (!strncmp(u, "https://", 8) || !strncmp(u, "http://", 7)) {
        snprintf(url, sizeof(url), "%s", u);
    } else {
        return;
    }
    snprintf(target, sizeof(target), "%s", version);
    snprintf(sha_hex, sizeof(sha_hex), "%s", sha);
    size = sz_bytes;
    error[0] = 0;
    state = OTA_DOWNLOADING;
    if (xTaskCreate(ota_task, "ota", 8192, NULL, 3, NULL) != pdPASS) fail("no memory");
}

size_t ota_json(char *buf, size_t room) {
    const char *names[] = {"idle", "downloading", "ready", "failed"};
    bool has_target = state != OTA_IDLE && target[0];
    int n = snprintf(buf, room, ",\"ota\":{\"state\":\"%s\",\"version\":%s%s%s,\"error\":%s%s%s,\"rejected\":%s%s%s}",
                     names[state], has_target ? "\"" : "", has_target ? target : "null", has_target ? "\"" : "",
                     error[0] ? "\"" : "", error[0] ? error : "null", error[0] ? "\"" : "", rejected[0] ? "\"" : "",
                     rejected[0] ? rejected : "null", rejected[0] ? "\"" : "");
    return n > 0 && (size_t)n < room ? (size_t)n : 0;
}

void ota_describe(char *out, size_t room) {
    const char *names[] = {"idle", "downloading", "ready", "failed"};
    const esp_partition_t *running = esp_ota_get_running_partition();
    snprintf(out, room, "update: %s%s%s%s%s, running %s%s%s%s", names[state], target[0] ? " " : "", target,
             error[0] ? ", " : "", error, running ? running->label : "?", pending_verify ? " (not confirmed yet)" : "",
             rejected[0] ? ", rejected " : "", rejected);
}
