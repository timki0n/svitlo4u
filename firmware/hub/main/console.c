// USB console (115200, any terminal): factory provisioning and diagnostics, one command per line.
//   status                     what the hub knows
//   provision <dev> <secret>   identity, as in config/sites.yaml and deploy/.env (set when flashed)
//   server <url|default>       report URL (default https://svitlo4u.info/iot/hub)
//   wifi <ssid> <password>     home Wi-Fi without the setup page (no spaces in the name)
//   wifi-forget | portal | pair | plug-forget | reboot
//   test loop-stuck|wifi-lost|kick-stuck   break the hub the way the watchdog (watch.c) must fix
//   test beacon-lost|conn-dead             lose the router as it really goes; kill the kept connection
//   sleep on|off               Wi-Fi sleeping between beacons (the default) or always listening
#include <stdarg.h>
#include <stdio.h>
#include <string.h>

#include "driver/usb_serial_jtag.h"
#include "driver/usb_serial_jtag_vfs.h"
#include "esp_system.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "hub.h"

static void out(const char *s) { usb_serial_jtag_write_bytes(s, strlen(s), pdMS_TO_TICKS(500)); }

static void outf(const char *fmt, ...) {
    char buf[256];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    out(buf);
}

static void status(void) {
    plug_status_t p;
    zb_status(&p);
    const char *ws[] = {"not set", "connecting", "connected", "failing"};
    const char *ss[] = {"no report yet", "ok", "failing", "rejected (check id/secret)"};
    outf("\r\n%s fw %s, up %.0f s, reset %s\r\n", g_cfg.dev[0] ? g_cfg.dev : "(not provisioned)", hub_fw_version(),
         hub_up(), hub_reset_reason());
    wifi_ap_record_t ap;
    bool has_ap = esp_wifi_sta_get_ap_info(&ap) == ESP_OK;
    outf("wifi: %s%s%s (reason %u)%s", ws[net_wifi_state()], g_cfg.ssid[0] ? " to " : "", g_cfg.ssid,
         net_wifi_reason(), net_portal_active() ? ", setup page ON" : "");
    if (has_ap) outf(", %d dBm, channel %u", ap.rssi, ap.primary);
    wifi_info_t w;
    net_wifi_info(&w);
    outf("; lost %lu times (last: reason %u, back in %.1f s)\r\n", (unsigned long)w.drops, w.reason,
         w.last_down_ms / 1000.0);
    outf("server: %s (last HTTP %d) %s; reports without an answer %lu, saved by a second try %lu\r\n",
         ss[report_server_state()], report_last_status(), g_cfg.server, (unsigned long)report_lost(),
         (unsigned long)report_redone());
    outf("zigbee: %s%s; plug %s, mains %s", p.network_up ? "up" : "starting",
         p.pairing_open ? ", pairing open" : "", p.paired ? "paired" : "not paired",
         p.mains == MAINS_ON ? "ON" : p.mains == MAINS_OFF ? "OFF" : "unknown");
    if (p.has_voltage) outf(", %.0f V", p.voltage);
    if (p.has_rssi) outf(", %d dBm", p.rssi);
    mains_event_t ev[HUB_MAX_EVENTS];
    int unsent = events_peek(ev, HUB_MAX_EVENTS), carried = 0;
    for (int i = 0; i < unsent; i++) carried += ev[i].up < 0;
    outf(", %d events unsent (%d from before the restart)\r\n", unsent, carried);
    outf("radio gaps (the link, not the mains): %lu, longest %.1f s; off after %lu s of silence (signal %.0f dBm)\r\n",
         (unsigned long)p.link_gaps, p.longest_gap_ms / 1000.0, (unsigned long)(p.confirm_ms / 1000),
         p.has_rssi_avg ? p.rssi_avg : 0.0f);
    static char diag[600];
    watch_describe(diag, sizeof(diag));
    out(diag);
    out("\r\n");
    ota_describe(diag, sizeof(diag));
    out(diag);
    out("\r\n");
    zb_diag(diag, sizeof(diag));
    out(diag);
    out("\r\n");
}

static void run(char *line) {
    char *cmd = strtok(line, " \t");
    if (!cmd) return;
    char *a = strtok(NULL, " \t");
    char *b = strtok(NULL, " \t");
    if (!strcmp(cmd, "status")) {
        status();
    } else if (!strcmp(cmd, "provision") && a && b && strlen(a) < sizeof(g_cfg.dev) &&
               strlen(b) < sizeof(g_cfg.secret)) {
        config_save_identity(a, b);
        out("\r\nidentity saved\r\n");
        report_kick();
    } else if (!strcmp(cmd, "server") && a) {
        config_save_server(strcmp(a, "default") ? a : "");
        outf("\r\nserver: %s\r\n", g_cfg.server);
        report_kick();
    } else if (!strcmp(cmd, "wifi") && a) {
        net_wifi_set(a, b ? b : "");
        out("\r\nwifi saved, connecting\r\n");
    } else if (!strcmp(cmd, "wifi-forget")) {
        config_forget_wifi();
        out("\r\nwifi forgotten, restarting into the setup page\r\n");
        hub_restart_into(true, false);
    } else if (!strcmp(cmd, "portal")) {
        out("\r\nrestarting into the setup page\r\n");
        hub_restart_into(true, false);
    } else if (!strcmp(cmd, "pair")) {
        zb_open_pairing();
        out("\r\npairing open for 180 s\r\n");
    } else if (!strcmp(cmd, "plug-forget")) {
        zb_forget_plug();
        out("\r\nplug forgotten\r\n");
    } else if (!strcmp(cmd, "reboot")) {
        out("\r\nrebooting\r\n");
        hub_note_restart("console");
        vTaskDelay(pdMS_TO_TICKS(200));
        esp_restart();
    } else if (!strcmp(cmd, "test") && a && watch_test(a)) {
        outf("\r\ntest %s: watch the log\r\n", a);
    } else if (!strcmp(cmd, "sleep") && a && (!strcmp(a, "on") || !strcmp(a, "off"))) {
        outf("\r\nWi-Fi sleep %s: %s (until the restart)\r\n", a, net_wifi_sleep(!strcmp(a, "on")) ? "ok" : "refused");
    } else {
        out("\r\ncommands: status | provision <dev> <secret> | server <url|default> | wifi <ssid> <pass> |"
            " wifi-forget | portal | pair | plug-forget | reboot | sleep on|off |"
            " test loop-stuck|wifi-lost|kick-stuck|beacon-lost|conn-dead\r\n");
    }
}

static void console_task(void *arg) {
    char line[200];
    size_t len = 0;
    for (;;) {
        uint8_t c;
        if (usb_serial_jtag_read_bytes(&c, 1, portMAX_DELAY) != 1) continue;
        if (c == '\r' || c == '\n') {
            if (len) {
                line[len] = 0;
                run(line);
                len = 0;
            }
        } else if (len < sizeof(line) - 1) {
            line[len++] = c;
        }
    }
}

void console_start(void) {
    usb_serial_jtag_driver_config_t cfg = {.tx_buffer_size = 2048, .rx_buffer_size = 512};
    if (usb_serial_jtag_driver_install(&cfg) != ESP_OK) return;
    usb_serial_jtag_vfs_use_driver(); // logs go through the driver too (never blocks without a PC)
    xTaskCreate(console_task, "console", 4096, NULL, 3, NULL);
}
