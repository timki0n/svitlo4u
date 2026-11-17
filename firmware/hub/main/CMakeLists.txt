idf_component_register(
    SRCS "main.c" "config.c" "zb.c" "net.c" "report.c" "console.c" "ota.c" "watch.c"
    INCLUDE_DIRS "."
    EMBED_TXTFILES "portal.html"
    PRIV_REQUIRES nvs_flash esp_driver_gpio esp_driver_usb_serial_jtag esp_timer esp_wifi esp_netif
                  esp_event esp_coex ieee802154 esp_http_server esp_http_client esp-tls mbedtls json lwip
                  app_update esp_app_format
)
