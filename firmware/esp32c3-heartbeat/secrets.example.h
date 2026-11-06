// Copy to secrets.h (git-ignored) and fill in.
#pragma once

#define WIFI_SSID "your-ssid"
#define WIFI_PASS "your-password"

// Must match a device in config/sites.yaml; DEVICE_SECRET = that device's secretEnv value on the server.
#define DEVICE_ID "esp-4u"
#define DEVICE_SECRET "change-me"

#define SERVER_IP "192.168.0.142"
#define SERVER_PORT 5005

// Optional: a fixed address instead of DHCP (a DHCP reservation in the router is usually simpler).
// #define STATIC_IP 192, 168, 0, 225
// #define STATIC_GATEWAY 192, 168, 0, 1
// #define STATIC_SUBNET 255, 255, 255, 0
// #define STATIC_DNS 192, 168, 0, 1
