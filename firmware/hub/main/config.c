// Settings in NVS: identity (set when flashed), report URL, Wi-Fi, the paired plug.
#include <string.h>

#include "esp_log.h"
#include "hub.h"
#include "nvs.h"

static const char *TAG = "config";
static const char *NS = "hub";

hub_config_t g_cfg;

static void get_str(nvs_handle_t h, const char *key, char *out, size_t size) {
    size_t len = size;
    if (nvs_get_str(h, key, out, &len) != ESP_OK) out[0] = 0;
}

void config_load(void) {
    memset(&g_cfg, 0, sizeof(g_cfg));
    strncpy(g_cfg.server, HUB_DEFAULT_SERVER, sizeof(g_cfg.server) - 1);
    nvs_handle_t h;
    if (nvs_open(NS, NVS_READONLY, &h) != ESP_OK) return;
    get_str(h, "dev", g_cfg.dev, sizeof(g_cfg.dev));
    get_str(h, "secret", g_cfg.secret, sizeof(g_cfg.secret));
    char server[sizeof(g_cfg.server)];
    get_str(h, "server", server, sizeof(server));
    if (server[0]) strcpy(g_cfg.server, server);
    get_str(h, "ssid", g_cfg.ssid, sizeof(g_cfg.ssid));
    get_str(h, "pass", g_cfg.pass, sizeof(g_cfg.pass));
    uint8_t flag = 0;
    if (nvs_get_u8(h, "setup", &flag) == ESP_OK) g_cfg.setup_mode = flag;
    flag = 0;
    if (nvs_get_u8(h, "pair", &flag) == ESP_OK) g_cfg.pair_on_boot = flag;
    uint8_t paired = 0;
    nvs_get_u8(h, "plug", &paired);
    if (paired && nvs_get_u16(h, "plug_short", &g_cfg.plug_short) == ESP_OK &&
        nvs_get_u64(h, "plug_ieee", &g_cfg.plug_ieee) == ESP_OK)
        g_cfg.plug_paired = true;
    nvs_close(h);
}

static void with_nvs(void (*fn)(nvs_handle_t h, const void *arg), const void *arg) {
    nvs_handle_t h;
    if (nvs_open(NS, NVS_READWRITE, &h) != ESP_OK) {
        ESP_LOGE(TAG, "nvs open failed");
        return;
    }
    fn(h, arg);
    nvs_commit(h);
    nvs_close(h);
}

static void save_identity(nvs_handle_t h, const void *arg) {
    nvs_set_str(h, "dev", g_cfg.dev);
    nvs_set_str(h, "secret", g_cfg.secret);
}
void config_save_identity(const char *dev, const char *secret) {
    strncpy(g_cfg.dev, dev, sizeof(g_cfg.dev) - 1);
    strncpy(g_cfg.secret, secret, sizeof(g_cfg.secret) - 1);
    with_nvs(save_identity, NULL);
}

static void save_server(nvs_handle_t h, const void *arg) { nvs_set_str(h, "server", g_cfg.server); }
void config_save_server(const char *url) {
    strncpy(g_cfg.server, url[0] ? url : HUB_DEFAULT_SERVER, sizeof(g_cfg.server) - 1);
    g_cfg.server[sizeof(g_cfg.server) - 1] = 0;
    with_nvs(save_server, NULL);
}

static void save_wifi(nvs_handle_t h, const void *arg) {
    nvs_set_str(h, "ssid", g_cfg.ssid);
    nvs_set_str(h, "pass", g_cfg.pass);
}
void config_save_wifi(const char *ssid, const char *pass) {
    memset(g_cfg.ssid, 0, sizeof(g_cfg.ssid));
    memset(g_cfg.pass, 0, sizeof(g_cfg.pass));
    strncpy(g_cfg.ssid, ssid, sizeof(g_cfg.ssid) - 1);
    strncpy(g_cfg.pass, pass, sizeof(g_cfg.pass) - 1);
    with_nvs(save_wifi, NULL);
}

static void forget_wifi(nvs_handle_t h, const void *arg) {
    nvs_erase_key(h, "ssid");
    nvs_erase_key(h, "pass");
}
void config_forget_wifi(void) {
    g_cfg.ssid[0] = 0;
    g_cfg.pass[0] = 0;
    with_nvs(forget_wifi, NULL);
}

static void save_plug(nvs_handle_t h, const void *arg) {
    nvs_set_u8(h, "plug", 1);
    nvs_set_u16(h, "plug_short", g_cfg.plug_short);
    nvs_set_u64(h, "plug_ieee", g_cfg.plug_ieee);
}
void config_save_plug(uint16_t short_addr, uint64_t ieee) {
    g_cfg.plug_short = short_addr;
    g_cfg.plug_ieee = ieee;
    g_cfg.plug_paired = true;
    with_nvs(save_plug, NULL);
}

static void forget_plug(nvs_handle_t h, const void *arg) { nvs_set_u8(h, "plug", 0); }
void config_forget_plug(void) {
    g_cfg.plug_paired = false;
    with_nvs(forget_plug, NULL);
}

bool config_provisioned(void) { return g_cfg.dev[0] && g_cfg.secret[0]; }

static void save_next_boot(nvs_handle_t h, const void *arg) {
    const bool *flags = arg;
    nvs_set_u8(h, "setup", flags[0]);
    nvs_set_u8(h, "pair", flags[1]);
}
void config_set_next_boot(bool setup, bool pair) {
    const bool flags[2] = {setup, pair};
    with_nvs(save_next_boot, flags);
}
