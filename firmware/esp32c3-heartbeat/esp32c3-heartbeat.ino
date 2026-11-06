/*
 * svitlo4u heartbeat — ESP32-C3 SuperMini
 *
 * Sends a signed UDP v2 heartbeat every second while there is mains power (docs/esp-protocol.md):
 *   {"v":2,"dev":"esp-4u","boot":"9f3a1c2e","seq":12,"up":34,"rst":"poweron","sig":"…"}
 *
 * - uptime is 64-bit (esp_timer), so it never wraps like millis() after 49.7 days;
 * - Wi-Fi reconnects in the background: the loop never blocks, heartbeats resume the moment the
 *   link is back (the legacy firmware blocked up to 10 s per attempt);
 * - "rst" tells the server why this boot happened, so an ESP crash is not mistaken for an outage.
 *
 * Board: "ESP32C3 Dev Module", USB CDC On Boot: Enabled. Copy secrets.example.h to secrets.h.
 */
#include <WiFi.h>
#include <WiFiUdp.h>
#include <esp_system.h>
#include <esp_timer.h>
#include <mbedtls/md.h>

#include "secrets.h"

#ifndef SEND_INTERVAL_MS
#define SEND_INTERVAL_MS 1000
#endif
#ifndef RECONNECT_NUDGE_MS
#define RECONNECT_NUDGE_MS 5000
#endif
#ifndef WIFI_TX_POWER
// The SuperMini's antenna is unreliable at full power; 8.5 dBm is the well-known stable value.
#define WIFI_TX_POWER WIFI_POWER_8_5dBm
#endif
#ifndef LED_PIN
#define LED_PIN 8  // onboard blue LED, active LOW; set to -1 to disable
#endif

static WiFiUDP udp;
static bool udpReady = false;
static char bootId[9];
static const char* resetReason = "unknown";
static uint32_t seq = 0;
static uint32_t lastSend = 0;
static uint32_t lastNudge = 0;
static uint32_t ledOffAt = 0;
static bool wasConnected = false;

static const char* resetReasonName(esp_reset_reason_t reason) {
  switch (reason) {
    case ESP_RST_POWERON:
      return "poweron";
    case ESP_RST_BROWNOUT:
      return "brownout";
    case ESP_RST_EXT:
      return "ext";
    case ESP_RST_SW:
      return "sw";
    case ESP_RST_PANIC:
      return "panic";
    case ESP_RST_INT_WDT:
    case ESP_RST_TASK_WDT:
    case ESP_RST_WDT:
      return "wdt";
    case ESP_RST_DEEPSLEEP:
      return "deepsleep";
    case ESP_RST_USB:
      return "usb";
    case ESP_RST_UNKNOWN:
      return "unknown";
    default:
      return "other";
  }
}

// First 16 bytes of HMAC-SHA256(key, message) as lowercase hex.
static void hmacHex16(const char* key, const char* message, char out[33]) {
  uint8_t mac[32];
  const mbedtls_md_info_t* sha256 = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  mbedtls_md_hmac(sha256, reinterpret_cast<const uint8_t*>(key), strlen(key),
                  reinterpret_cast<const uint8_t*>(message), strlen(message), mac);
  static const char hex[] = "0123456789abcdef";
  for (int i = 0; i < 16; i++) {
    out[2 * i] = hex[mac[i] >> 4];
    out[2 * i + 1] = hex[mac[i] & 0x0f];
  }
  out[32] = '\0';
}

static void ledPulse(uint32_t now) {
  if (LED_PIN < 0) return;
  digitalWrite(LED_PIN, LOW);
  ledOffAt = now + 30;
}

static void sendHeartbeat(uint32_t now) {
  const unsigned long long up = esp_timer_get_time() / 1000000ULL;
  char toSign[160];
  snprintf(toSign, sizeof toSign, "2|%s|%s|%lu|%llu|%s", DEVICE_ID, bootId,
           static_cast<unsigned long>(seq), up, resetReason);
  char sig[33];
  hmacHex16(DEVICE_SECRET, toSign, sig);

  char packet[256];
  const int length = snprintf(
      packet, sizeof packet,
      "{\"v\":2,\"dev\":\"%s\",\"boot\":\"%s\",\"seq\":%lu,\"up\":%llu,\"rst\":\"%s\",\"sig\":\"%s\"}",
      DEVICE_ID, bootId, static_cast<unsigned long>(seq), up, resetReason, sig);
  if (length <= 0 || length >= static_cast<int>(sizeof packet)) return;

  if (udp.beginPacket(SERVER_IP, SERVER_PORT)) {
    udp.write(reinterpret_cast<const uint8_t*>(packet), length);
    udp.endPacket();
  }
  seq++;
  ledPulse(now);
}

void setup() {
  Serial.begin(115200);
  if (LED_PIN >= 0) {
    pinMode(LED_PIN, OUTPUT);
    digitalWrite(LED_PIN, HIGH);
  }
  resetReason = resetReasonName(esp_reset_reason());
  snprintf(bootId, sizeof bootId, "%08lx", static_cast<unsigned long>(esp_random()));

  WiFi.mode(WIFI_STA);
  WiFi.persistent(false);
  WiFi.setSleep(false);
  WiFi.setAutoReconnect(true);
#ifdef STATIC_IP
  WiFi.config(IPAddress(STATIC_IP), IPAddress(STATIC_GATEWAY), IPAddress(STATIC_SUBNET),
              IPAddress(STATIC_DNS));
#endif
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  WiFi.setTxPower(WIFI_TX_POWER);

  Serial.printf("svitlo4u heartbeat: dev=%s boot=%s rst=%s\n", DEVICE_ID, bootId, resetReason);
}

void loop() {
  const uint32_t now = millis();

  if (WiFi.status() == WL_CONNECTED) {
    if (!wasConnected) {
      wasConnected = true;
      Serial.printf("Wi-Fi connected, IP %s\n", WiFi.localIP().toString().c_str());
    }
    if (!udpReady) udpReady = udp.begin(0);
    if (now - lastSend >= SEND_INTERVAL_MS) {
      lastSend = now;
      sendHeartbeat(now);
    }
  } else {
    if (wasConnected) {
      wasConnected = false;
      Serial.println("Wi-Fi lost, reconnecting in background");
    }
    // Auto-reconnect normally handles it; nudge occasionally in case the driver gave up.
    if (now - lastNudge >= RECONNECT_NUDGE_MS) {
      lastNudge = now;
      WiFi.reconnect();
    }
  }

  if (LED_PIN >= 0 && ledOffAt != 0 && static_cast<int32_t>(now - ledOffAt) >= 0) {
    digitalWrite(LED_PIN, HIGH);
    ledOffAt = 0;
  }
  delay(5);
}
