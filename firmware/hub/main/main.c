// svitlo4u hub: a Zigbee coordinator with one smart plug that tells the svitlo4u core when the mains
// goes and comes back. Meant to sit on the router's UPS. Protocol: docs/hub-protocol.md.
//
// Two modes, switched by a restart (hub_restart_into): setup (access point «Svitlo4U-XXXX» with
// the setup page, no Zigbee) and normal (home Wi-Fi + Zigbee + reports).
// BOOT button: a short press opens Zigbee pairing for 180 s, holding it 5 s restarts into setup.
// LED: blue blinking = setup page, cyan blinking = pairing, purple = not provisioned or no plug,
// yellow = no Wi-Fi or no answer from the server, green = light on, red = light off.
#include <string.h>

#include "driver/gpio.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "hub.h"
#include "led_strip.h"
#include "nvs_flash.h"

static const char *TAG = "hub";

#define STATUS_LED GPIO_NUM_15
#define RGB_LED GPIO_NUM_8
#define BOOT_BUTTON GPIO_NUM_9
#define LONG_PRESS_MS 5000

uint32_t hub_ms(void) { return (uint32_t)(esp_timer_get_time() / 1000); }
double hub_up(void) { return esp_timer_get_time() / 1e6; }

const char *hub_reset_reason(void) {
    switch (esp_reset_reason()) {
    case ESP_RST_POWERON: return "poweron";
    case ESP_RST_BROWNOUT: return "brownout";
    case ESP_RST_SW: return "sw";
    case ESP_RST_PANIC: return "panic";
    case ESP_RST_INT_WDT:
    case ESP_RST_TASK_WDT:
    case ESP_RST_WDT: return "wdt";
    case ESP_RST_EXT: return "ext";
    case ESP_RST_USB: return "usb";
    case ESP_RST_DEEPSLEEP: return "deepsleep";
    case ESP_RST_UNKNOWN: return "unknown";
    default: return "other";
    }
}

static led_strip_handle_t rgb;

static void rgb_set(uint8_t r, uint8_t g, uint8_t b) {
    if (!rgb) return;
    led_strip_set_pixel(rgb, 0, r, g, b);
    led_strip_refresh(rgb);
}

static void ui_task(void *arg) {
    uint32_t pressed_at = 0;
    bool long_done = false;
    for (uint32_t tick = 0;; tick++) {
        vTaskDelay(pdMS_TO_TICKS(50));
        // Button: act on release (short) or after 5 s held (long).
        bool down = gpio_get_level(BOOT_BUTTON) == 0;
        uint32_t now = hub_ms();
        if (down && !pressed_at) {
            pressed_at = now;
            long_done = false;
        } else if (down && !long_done && now - pressed_at >= LONG_PRESS_MS) {
            long_done = true;
            ESP_LOGI(TAG, "long press: setup page");
            hub_restart_into(true, false);
        } else if (!down && pressed_at) {
            if (!long_done && now - pressed_at >= 50) {
                ESP_LOGI(TAG, "short press: pairing");
                zb_open_pairing();
            }
            pressed_at = 0;
        }

        if (tick % 4) continue; // LED at 5 Hz
        bool blink = (tick / 10) % 2;
        plug_status_t p;
        zb_status(&p);
        if (net_portal_active())
            rgb_set(0, 0, blink ? 28 : 2);
        else if (p.pairing_open)
            rgb_set(0, (tick / 4) % 2 ? 20 : 0, (tick / 4) % 2 ? 20 : 0);
        else if (!config_provisioned() || !p.paired)
            rgb_set(14, 0, 14);
        else if (net_wifi_state() != WIFI_CONNECTED || report_server_state() == SERVER_FAILING ||
                 report_server_state() == SERVER_REJECTED)
            rgb_set(18, 12, 0);
        else if (p.mains == MAINS_ON)
            rgb_set(0, 18, 0);
        else if (p.mains == MAINS_OFF)
            rgb_set(24, 0, 0);
        else
            rgb_set(6, 6, 6);
        gpio_set_level(STATUS_LED, report_server_state() == SERVER_OK && blink);
    }
}

void hub_restart_into(bool setup, bool pair) {
    config_set_next_boot(setup, pair);
    ESP_LOGI(TAG, "restarting into the %s mode%s", setup ? "setup" : "normal", pair ? " with pairing" : "");
    vTaskDelay(pdMS_TO_TICKS(200));
    esp_restart();
}

void app_main(void) {
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    ESP_ERROR_CHECK(err);
    config_load();

    gpio_reset_pin(STATUS_LED);
    gpio_set_direction(STATUS_LED, GPIO_MODE_OUTPUT);
    gpio_set_direction(BOOT_BUTTON, GPIO_MODE_INPUT);
    gpio_set_pull_mode(BOOT_BUTTON, GPIO_PULLUP_ONLY);
    led_strip_config_t strip = {
        .strip_gpio_num = RGB_LED,
        .max_leds = 1,
        .led_model = LED_MODEL_WS2812,
        .color_component_format = LED_STRIP_COLOR_COMPONENT_FMT_GRB,
    };
    led_strip_rmt_config_t rmt = {.resolution_hz = 10 * 1000 * 1000};
    if (led_strip_new_rmt_device(&strip, &rmt, &rgb) != ESP_OK) rgb = NULL;
    rgb_set(4, 4, 4);

    // Setup mode when asked for, or when there is no home Wi-Fi to work with (hub_restart_into).
    bool setup = g_cfg.setup_mode || !g_cfg.ssid[0];
    ESP_LOGI(TAG, "hub %s, %s, reset %s, %s mode", hub_fw_version(), g_cfg.dev[0] ? g_cfg.dev : "not provisioned",
             hub_reset_reason(), setup ? "setup" : "normal");
    console_start();
    ota_init(setup);
    // Wi-Fi first: radio sharing has to be on before the 802.15.4 radio starts.
    net_start(setup);
    if (!setup) {
        if (g_cfg.pair_on_boot) config_set_next_boot(false, false); // pair once, not on every boot
        zb_start();
        report_start();
    }
    watch_start(!setup);
    xTaskCreate(ui_task, "ui", 4096, NULL, 3, NULL);
}
