// USB console (115200, any terminal): factory provisioning and diagnostics, one command per line.
//   status                     what the hub knows
//   provision <dev> <secret>   identity, as in config/sites.yaml and deploy/.env (set when flashed)
//   server <url|default>       report URL (default https://svitlo4u.info/iot/hub)
//   wifi <ssid> <password>     home Wi-Fi without the setup page (no spaces in the name)
//   wifi-forget | portal | pair | plug-forget | reboot
#include <stdarg.h>
#include <stdio.h>
#include <string.h>

#include "driver/usb_serial_jtag.h"
#include "driver/usb_serial_jtag_vfs.h"
#include "esp_system.h"
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
    outf("wifi: %s%s%s (reason %u)%s\r\n", ws[net_wifi_state()], g_cfg.ssid[0] ? " to " : "", g_cfg.ssid,
         net_wifi_reason(), net_portal_active() ? ", setup page ON" : "");
    outf("server: %s (last HTTP %d) %s\r\n", ss[report_server_state()], report_last_status(), g_cfg.server);
    outf("zigbee: %s%s; plug %s, mains %s", p.network_up ? "up" : "starting",
         p.pairing_open ? ", pairing open" : "", p.paired ? "paired" : "not paired",
         p.mains == MAINS_ON ? "ON" : p.mains == MAINS_OFF ? "OFF" : "unknown");
    if (p.has_voltage) outf(", %.0f V", p.voltage);
    if (p.has_rssi) outf(", %d dBm", p.rssi);
    mains_event_t ev[HUB_MAX_EVENTS];
    outf(", %d events unsent\r\n", events_peek(ev, HUB_MAX_EVENTS));
    static char diag[600];
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
        vTaskDelay(pdMS_TO_TICKS(200));
        esp_restart();
    } else {
        out("\r\ncommands: status | provision <dev> <secret> | server <url|default> | wifi <ssid> <pass> |"
            " wifi-forget | portal | pair | plug-forget | reboot\r\n");
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
