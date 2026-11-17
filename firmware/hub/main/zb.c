// Zigbee: a coordinator with one mains-powered plug. Every second the hub reads the plug's
// voltage; any answer means the plug — so the mains — is alive, silence for 3 s means the mains is
// gone. The verdict and the moments it changed (by hub uptime) go to the core (report.c).
#include <inttypes.h>
#include <string.h>

#include "esp_log.h"
#include "esp_zigbee.h"
#include "ezbee/zha.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "hub.h"

static const char *TAG = "zb";

#define HUB_EP 1
#define PLUG_EP 1
#define READ_EVERY_MS 1000
// Silence of the plug (it has no battery): 5 s → maybe the mains is gone; the alert delay → it is,
// since the last answer. A shorter silence is taken as a gap of the radio link, not the mains
// (they last up to ~15 s, a router renews its links every 15 s: two false «off» of 15 s at
// -79 dBm, 2026-11-16). A blink of the power shorter than the delay looks the same — the TS011F
// does not announce itself when it starts again — and is not counted as an outage on purpose.
// A plug that does announce makes it a cut. The delay follows the plug's signal (its average):
// gaps come with a weak link.
#define SUSPECT_MS 5000
#define CONFIRM_MAX_MS 22000
#define ANNOUNCE_GRACE_MS 3000   // the plug's announce may come just after its first answer
#define UNKNOWN_TO_OFF_MS 10000  // after a boot: never answered this long → off (since unknown)
#define SCALE_EVERY_MS (10 * 60 * 1000)
#define PAIRING_S 180

// Primary channels away from the busy Wi-Fi channels 1/6 (15, 20, 25); any channel if all are busy.
#define PRIMARY_CHANNELS ((1UL << 15) | (1UL << 20) | (1UL << 25))
#define SECONDARY_CHANNELS 0x07FFF800UL

static volatile bool network_up;
static volatile bool pairing_requested;
static volatile bool pairing_open;
/** Until when the hub itself wants the network open (anything else opening it gets closed). */
static volatile uint32_t pairing_wanted_until;
static volatile uint32_t pairing_until_ms;
static volatile bool need_basic_read;
// After the start, a new plug and an outage: the plug is told to come on with the power, and on.
static volatile bool need_power_on = true;
// Messages of the plug just after a silence, logged to learn what it sends when it restarts.
static volatile uint32_t watch_after_gap_until;
static volatile bool need_scale_read;
static volatile uint32_t retry_mode, retry_at_ms;

// Mains verdict (written by the Zigbee task and the poll task; reads tolerate a torn update).
static portMUX_TYPE lock = portMUX_INITIALIZER_UNLOCKED;
static mains_t mains = MAINS_UNKNOWN;
static double mains_since = -1;
static volatile uint32_t verdict_at_ms;
static volatile uint32_t last_answer_ms;
static volatile uint32_t answers_during_read; // the race fixed in poll_task, counted for `status`
static bool answered;
static float voltage;
static bool has_voltage;
static int8_t rssi;
static bool has_rssi;
static uint16_t v_mult = 1, v_div = 1;
static volatile uint32_t sent_ok, sent_failed; // radio-level results of the reads to the plug
// A silence being judged, and the last one that ended without the plug rebooting.
static bool suspect;
static uint32_t gap_from_ms;
static bool gap_pending;
static uint32_t gap_end_ms, gap_start_ms;
static volatile uint32_t link_gaps, longest_gap_ms;
static float rssi_avg; // the plug's signal, averaged over about a minute of answers
static bool has_rssi_avg;

/** How long the plug must be silent to call it an outage: shorter when it is heard well. */
static uint32_t confirm_ms(void) {
    if (!has_rssi_avg) return CONFIRM_MAX_MS;
    if (rssi_avg >= -70) return 15000; // 10 s at ≥ -60 dBm was too eager (2026-11-17)
    if (rssi_avg >= -78) return 18000;
    return CONFIRM_MAX_MS;
}

// ---------------------------------------------------------------------------------------------
// Events waiting for the core

static mains_event_t events[HUB_MAX_EVENTS];
static int events_n;

void events_push(double up, bool on) {
    portENTER_CRITICAL(&lock);
    if (events_n == HUB_MAX_EVENTS) {
        memmove(events, events + 1, sizeof(events[0]) * (HUB_MAX_EVENTS - 1));
        events_n--;
    }
    events[events_n++] = (mains_event_t){.up = up, .on = on};
    portEXIT_CRITICAL(&lock);
}

int events_peek(mains_event_t *out, int max) {
    portENTER_CRITICAL(&lock);
    int n = events_n < max ? events_n : max;
    memcpy(out, events, sizeof(events[0]) * n);
    portEXIT_CRITICAL(&lock);
    return n;
}

void events_drop(int n) {
    portENTER_CRITICAL(&lock);
    if (n > events_n) n = events_n;
    memmove(events, events + n, sizeof(events[0]) * (events_n - n));
    events_n -= n;
    portEXIT_CRITICAL(&lock);
}

// ---------------------------------------------------------------------------------------------
// Verdict

static void set_mains(mains_t to, double since, bool event) {
    portENTER_CRITICAL(&lock);
    mains = to;
    mains_since = since;
    verdict_at_ms = hub_ms();
    portEXIT_CRITICAL(&lock);
    if (event) events_push(since, to == MAINS_ON);
    ESP_LOGI(TAG, "mains %s since %.3f s", to == MAINS_ON ? "ON" : to == MAINS_OFF ? "OFF" : "unknown", since);
    report_kick();
}

/** The mains was gone from `from` to `to` (both known only now): both changes, in order. */
static void past_cut(uint32_t from, uint32_t to) {
    ESP_LOGW(TAG, "the plug rebooted: the mains was gone %.1f s", (to - from) / 1000.0);
    set_mains(MAINS_OFF, from / 1000.0, true);
    set_mains(MAINS_ON, to / 1000.0, true);
}

/** Any message from the plug: it is alive, so is the mains. `announce`: it has just (re)started. */
static void plug_alive(int8_t signal, bool announce) {
    uint32_t now = hub_ms();
    if (announce && gap_pending && now - gap_end_ms < ANNOUNCE_GRACE_MS) {
        // The gap that has just ended was the plug starting again: a power cut after all.
        gap_pending = false;
        if (link_gaps) link_gaps--;
        past_cut(gap_start_ms, gap_end_ms);
    }
    if (suspect) {
        suspect = false;
        uint32_t gap = now - gap_from_ms;
        watch_after_gap_until = now + 10000;
        need_power_on = true; // if it was the power, the plug may come back off
        if (announce) {
            past_cut(gap_from_ms, now);
        } else {
            link_gaps++;
            if (gap > longest_gap_ms) longest_gap_ms = gap;
            gap_pending = true;
            gap_start_ms = gap_from_ms;
            gap_end_ms = now;
            ESP_LOGW(TAG, "radio gap: the plug was silent %.1f s (the link, not the mains)", gap / 1000.0);
        }
    }
    last_answer_ms = now;
    if (!announce) {
        rssi = signal;
        has_rssi = true;
        rssi_avg = has_rssi_avg ? rssi_avg + (signal - rssi_avg) * 0.02f : signal;
        has_rssi_avg = true;
    }
    if (!answered) {
        answered = true;
        need_scale_read = true;
    }
    if (mains == MAINS_OFF) need_power_on = true; // back after an outage
    if (mains != MAINS_ON) set_mains(MAINS_ON, now / 1000.0, true);
}

/** The plug's relay: on whenever the power returns (Tuya 0x8002 and ZCL StartUpOnOff), and on now. */
static void plug_power_on(void) {
    static uint8_t on = 1; // Tuya: 0 off, 1 on, 2 previous; ZCL: 0 off, 1 on, 0xff previous
    ezb_zcl_attribute_t attrs[] = {
        {.id = 0x8002, .data = {.type = EZB_ZCL_ATTR_TYPE_ENUM8, .size = 1, .value = &on}},
        {.id = EZB_ZCL_ATTR_ON_OFF_START_UP_ON_OFF_ID,
         .data = {.type = EZB_ZCL_ATTR_TYPE_ENUM8, .size = 1, .value = &on}},
    };
    ezb_address_t dst = {.addr_mode = EZB_ADDR_MODE_SHORT, .u.short_addr = g_cfg.plug_short};
    ezb_zcl_write_attr_cmd_t write = {
        .cmd_ctrl = {.dst_addr = dst, .dst_ep = PLUG_EP, .src_ep = HUB_EP, .cluster_id = EZB_ZCL_CLUSTER_ID_ON_OFF},
        .payload = {.attr_number = 2, .attr_field = attrs},
    };
    ezb_zcl_on_off_cmd_t turn_on = {.cmd_ctrl = {.dst_addr = dst, .dst_ep = PLUG_EP, .src_ep = HUB_EP}};
    esp_zigbee_lock_acquire(portMAX_DELAY);
    ezb_zcl_write_attr_cmd_req(&write);
    ezb_zcl_on_off_on_cmd_req(&turn_on);
    esp_zigbee_lock_release();
    ESP_LOGI(TAG, "plug: on whenever the power returns, and on now");
}

static void take_voltage(uint16_t attr, uint8_t type, const void *value) {
    if (!value || type != EZB_ZCL_ATTR_TYPE_UINT16) return;
    uint16_t raw;
    memcpy(&raw, value, sizeof(raw));
    if (attr == 0x0505 && raw != 0xFFFF) {
        voltage = (float)raw * v_mult / (v_div ? v_div : 1);
        has_voltage = true;
    } else if (attr == 0x0600 && raw) {
        v_mult = raw;
    } else if (attr == 0x0601 && raw) {
        v_div = raw;
    }
}

void zb_status(plug_status_t *out) {
    memset(out, 0, sizeof(*out));
    portENTER_CRITICAL(&lock);
    out->mains = mains;
    out->mains_since = mains_since;
    portEXIT_CRITICAL(&lock);
    out->paired = g_cfg.plug_paired;
    out->has_voltage = has_voltage && mains == MAINS_ON;
    out->voltage = voltage;
    out->has_rssi = has_rssi;
    out->rssi = rssi;
    out->network_up = network_up;
    out->link_gaps = link_gaps;
    out->longest_gap_ms = longest_gap_ms;
    out->confirm_ms = confirm_ms();
    out->has_rssi_avg = has_rssi_avg;
    out->rssi_avg = rssi_avg;
    uint32_t now = hub_ms();
    out->pairing_open = pairing_open && now < pairing_until_ms;
    out->pairing_left_s = out->pairing_open ? (pairing_until_ms - now) / 1000 : 0;
}

void zb_open_pairing(void) { pairing_requested = true; }

void zb_diag(char *out, size_t size) {
    uint32_t last = last_answer_ms;
    size_t len = snprintf(out, size,
                          "reads sent ok %lu, failed %lu, last answer %lu ms ago, answers during a read %lu; neighbors:",
                          (unsigned long)sent_ok, (unsigned long)sent_failed,
                          (unsigned long)(answered ? hub_ms() - last : 0), (unsigned long)answers_during_read);
    if (!network_up) return;
    esp_zigbee_lock_acquire(portMAX_DELAY);
    ezb_nwk_info_iterator_t it = EZB_NWK_INFO_ITERATOR_INIT;
    ezb_nwk_neighbor_info_t nb;
    while (len < size - 64 && ezb_nwk_get_next_neighbor(&it, &nb) == EZB_ERR_NONE)
        len += snprintf(out + len, size - len, " [0x%04x %016" PRIx64 " lqi %u rssi %d age %u]", nb.short_addr,
                        nb.ieee_addr.u64, nb.lqi, nb.rssi, nb.age);
    esp_zigbee_lock_release();
}

void zb_forget_plug(void) {
    config_forget_plug();
    answered = false;
    suspect = false;
    gap_pending = false;
    has_voltage = false;
    set_mains(MAINS_UNKNOWN, -1, false);
}

// ---------------------------------------------------------------------------------------------
// ZCL

static uint8_t sender(const ezb_zcl_cmd_hdr_t *h) {
    if (!h || h->src_addr.addr_mode != EZB_ADDR_MODE_SHORT) return 0;
    return g_cfg.plug_paired && h->src_addr.u.short_addr == g_cfg.plug_short;
}

static void zcl_action(ezb_zcl_core_action_callback_id_t id, void *message) {
    switch (id) {
    case EZB_ZCL_CORE_READ_ATTR_RSP_CB_ID: {
        ezb_zcl_cmd_read_attr_rsp_message_t *m = message;
        if (!sender(m->in.header)) return;
        plug_alive(m->in.header->rssi, false);
        for (ezb_zcl_read_attr_rsp_variable_t *v = m->in.variables; v; v = v->next) {
            if (v->status != 0) continue;
            if (m->info.cluster_id == EZB_ZCL_CLUSTER_ID_ELECTRICAL_MEASUREMENT)
                take_voltage(v->attr_id, v->attr_type, v->attr_value);
            if (m->info.cluster_id == EZB_ZCL_CLUSTER_ID_BASIC && v->attr_type == 0x42 && v->attr_value &&
                (v->attr_id == 0x0004 || v->attr_id == 0x0005)) {
                const uint8_t *p = v->attr_value;
                ESP_LOGI(TAG, "plug %s: %.*s", v->attr_id == 4 ? "maker" : "model", p[0] < 60 ? p[0] : 60,
                         (const char *)p + 1);
            }
        }
    } break;
    case EZB_ZCL_CORE_WRITE_ATTR_RSP_CB_ID: {
        ezb_zcl_cmd_write_attr_rsp_message_t *m = message;
        if (!sender(m->in.header)) return;
        for (ezb_zcl_write_attr_rsp_variable_t *v = m->in.variables; v; v = v->next)
            ESP_LOGI(TAG, "plug wrote cluster 0x%04x attr 0x%04x: status 0x%02x", m->info.cluster_id, v->attr_id,
                     v->status);
    } break;
    case EZB_ZCL_CORE_REPORT_ATTR_CB_ID: {
        ezb_zcl_cmd_report_attr_message_t *m = message;
        if (!sender(m->in.header)) return;
        if (hub_ms() < watch_after_gap_until)
            for (ezb_zcl_report_attr_variable_t *v = m->in.variables; v; v = v->next)
                ESP_LOGI(TAG, "after the silence the plug reported cluster 0x%04x attr 0x%04x", m->info.cluster_id,
                         v->attr_id);
        plug_alive(m->in.header->rssi, false);
        if (m->info.cluster_id == EZB_ZCL_CLUSTER_ID_ELECTRICAL_MEASUREMENT)
            for (ezb_zcl_report_attr_variable_t *v = m->in.variables; v; v = v->next)
                take_voltage(v->attr_id, v->attr_type, v->attr_value);
    } break;
    case EZB_ZCL_CORE_DEFAULT_RSP_CB_ID: {
        ezb_zcl_cmd_default_rsp_message_t *m = message;
        if (sender(m->in.header)) plug_alive(m->in.header->rssi, false);
    } break;
    default:
        break;
    }
}

static void read_sent(ezb_zcl_cmd_cnf_t *cnf, void *ctx) {
    if (cnf->status == 0)
        sent_ok++;
    else
        sent_failed++;
}

static void read_attrs(uint16_t cluster, uint16_t *attrs, uint8_t n) {
    ezb_zcl_read_attr_cmd_t req = {
        .cmd_ctrl =
            {
                .dst_addr = {.addr_mode = EZB_ADDR_MODE_SHORT, .u.short_addr = g_cfg.plug_short},
                .dst_ep = PLUG_EP,
                .src_ep = HUB_EP,
                .cluster_id = cluster,
                .fc = {.direction = 0, .dis_default_rsp = 1},
                .cnf_ctx = {.cb = read_sent, .user_ctx = NULL},
            },
        .payload = {.attr_number = n, .attr_field = attrs},
    };
    esp_zigbee_lock_acquire(portMAX_DELAY);
    ezb_zcl_read_attr_cmd_req(&req);
    esp_zigbee_lock_release();
}

// ---------------------------------------------------------------------------------------------
// Network signals

/** Open the network for a plug (Zigbee context or under the lock). */
static void open_pairing(void) {
    pairing_wanted_until = hub_ms() + PAIRING_S * 1000U;
    ezb_bdb_open_network(PAIRING_S);
}

static bool zb_signal(const ezb_app_signal_t *sig) {
    ezb_app_signal_type_t type = ezb_app_signal_get_type(sig);
    switch (type) {
    case EZB_ZDO_SIGNAL_SKIP_STARTUP:
        ezb_bdb_start_top_level_commissioning(EZB_BDB_MODE_INITIALIZATION);
        break;
    case EZB_BDB_SIGNAL_DEVICE_FIRST_START:
    case EZB_BDB_SIGNAL_DEVICE_REBOOT: {
        ezb_bdb_comm_status_t status = *(ezb_bdb_comm_status_t *)ezb_app_signal_get_params(sig);
        if (status != EZB_BDB_STATUS_SUCCESS) {
            ESP_LOGW(TAG, "start failed (0x%02x), retrying", status);
            retry_mode = EZB_BDB_MODE_INITIALIZATION;
            retry_at_ms = hub_ms() + 1000;
        } else if (ezb_bdb_is_factory_new()) {
            ezb_bdb_start_top_level_commissioning(EZB_BDB_MODE_NETWORK_FORMATION);
        } else {
            network_up = true;
            ESP_LOGI(TAG, "network restored: PAN 0x%04x, channel %d", ezb_nwk_get_panid(),
                     ezb_nwk_get_current_channel());
            if (!g_cfg.plug_paired || g_cfg.pair_on_boot) open_pairing();
        }
    } break;
    case EZB_BDB_SIGNAL_FORMATION: {
        ezb_bdb_comm_status_t status = *(ezb_bdb_comm_status_t *)ezb_app_signal_get_params(sig);
        if (status == EZB_BDB_STATUS_SUCCESS) {
            ESP_LOGI(TAG, "network formed: PAN 0x%04x, channel %d", ezb_nwk_get_panid(),
                     ezb_nwk_get_current_channel());
            network_up = true;
            if (!g_cfg.plug_paired || g_cfg.pair_on_boot) open_pairing();
        } else {
            ESP_LOGW(TAG, "network formation failed (0x%02x), retrying", status);
            retry_mode = EZB_BDB_MODE_NETWORK_FORMATION;
            retry_at_ms = hub_ms() + 1000;
        }
    } break;
    case EZB_ZDO_SIGNAL_DEVICE_ANNCE: {
        const ezb_zdo_signal_device_annce_params_t *p = ezb_app_signal_get_params(sig);
        bool known = g_cfg.plug_paired && p->device_addr.u64 == g_cfg.plug_ieee;
        if (known) {
            if (p->short_addr != g_cfg.plug_short) config_save_plug(p->short_addr, g_cfg.plug_ieee);
            ESP_LOGI(TAG, "plug announced itself (started again): 0x%04x", p->short_addr);
            need_power_on = true;
            plug_alive(0, true);
        } else if (pairing_open || !g_cfg.plug_paired) {
            // The device that joins while pairing is open becomes the plug (replacing the old one).
            config_save_plug(p->short_addr, p->device_addr.u64);
            answered = false;
            has_voltage = false;
            v_mult = v_div = 1;
            set_mains(MAINS_UNKNOWN, -1, false);
            need_basic_read = true;
            need_power_on = true;
            pairing_wanted_until = 0;
            ezb_bdb_close_network();
            ESP_LOGI(TAG, "plug paired: 0x%04x %016" PRIx64, p->short_addr, p->device_addr.u64);
        } else {
            ESP_LOGW(TAG, "ignoring device 0x%04x: one plug per hub", p->short_addr);
        }
    } break;
    case EZB_NWK_SIGNAL_PERMIT_JOIN_STATUS: {
        uint8_t seconds = *(uint8_t *)ezb_app_signal_get_params(sig);
        pairing_open = seconds > 0;
        pairing_until_ms = hub_ms() + seconds * 1000U;
        ESP_LOGI(TAG, "pairing %s (%u s)", seconds ? "open" : "closed", seconds);
        // The stack reopens it on its own after a device joins (seen 2026-11-15): one plug per hub.
        if (seconds && hub_ms() > pairing_wanted_until) {
            ESP_LOGI(TAG, "closing pairing nobody asked for");
            ezb_bdb_close_network();
        }
    } break;
    default:
        ESP_LOGI(TAG, "signal %s", ezb_app_signal_to_string(type));
        break;
    }
    return true;
}

// ---------------------------------------------------------------------------------------------
// Tasks

static void zigbee_task(void *arg) {
    esp_zigbee_config_t config = {
        .device_config =
            {
                .device_type = EZB_NWK_DEVICE_TYPE_COORDINATOR,
                .install_code_policy = false,
                .zczr_config = {.max_children = 10},
            },
        .platform_config =
            {
                .storage_partition_name = "nvs",
                .radio_config = {.radio_mode = ESP_ZIGBEE_RADIO_MODE_NATIVE},
            },
    };
    ESP_ERROR_CHECK(esp_zigbee_init(&config));
    ezb_aps_secur_enable_distributed_security(false);
    ESP_ERROR_CHECK(ezb_bdb_set_primary_channel_set(PRIMARY_CHANNELS));
    ESP_ERROR_CHECK(ezb_bdb_set_secondary_channel_set(SECONDARY_CHANNELS));
    ESP_ERROR_CHECK(ezb_app_signal_add_handler(zb_signal));

    ezb_af_device_desc_t dev = ezb_af_create_device_desc();
    ezb_zha_on_off_switch_config_t cfg = EZB_ZHA_ON_OFF_SWITCH_CONFIG();
    ezb_af_ep_desc_t ep = ezb_zha_create_on_off_switch(HUB_EP, &cfg);
    ezb_zcl_cluster_desc_t basic = ezb_af_endpoint_get_cluster_desc(ep, EZB_ZCL_CLUSTER_ID_BASIC, EZB_ZCL_CLUSTER_SERVER);
    ezb_zcl_basic_cluster_desc_add_attr(basic, EZB_ZCL_ATTR_BASIC_MANUFACTURER_NAME_ID, (void *)"\x08svitlo4u");
    ezb_zcl_basic_cluster_desc_add_attr(basic, EZB_ZCL_ATTR_BASIC_MODEL_IDENTIFIER_ID, (void *)"\x03hub");
    // The stack sends ZCL commands only for clusters the endpoint has: without these client roles
    // the voltage and Basic reads were dropped silently (2026-11-15).
    ESP_ERROR_CHECK(ezb_af_endpoint_add_cluster_desc(
        ep, ezb_zcl_electrical_measurement_create_cluster_desc(NULL, EZB_ZCL_CLUSTER_CLIENT)));
    ESP_ERROR_CHECK(ezb_af_endpoint_add_cluster_desc(ep, ezb_zcl_basic_create_cluster_desc(NULL, EZB_ZCL_CLUSTER_CLIENT)));
    ESP_ERROR_CHECK(ezb_af_device_add_endpoint_desc(dev, ep));
    ESP_ERROR_CHECK(ezb_af_device_desc_register(dev));
    ezb_zcl_core_action_handler_register(zcl_action);

    ESP_ERROR_CHECK(esp_zigbee_start(false));
    esp_zigbee_launch_mainloop();
    vTaskDelete(NULL);
}

static void poll_task(void *arg) {
    // The read Tuya devices expect from a coordinator before they work normally.
    static uint16_t basic_attrs[] = {0x0004, 0x0000, 0x0001, 0x0005, 0x0007, 0xFFFE};
    static uint16_t voltage_attr[] = {0x0505};
    static uint16_t scale_attrs[] = {0x0600, 0x0601};
    uint32_t last_read = 0, last_scale = 0;
    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(100));
        uint32_t now = hub_ms();
        if (retry_mode && now >= retry_at_ms) {
            uint32_t mode = retry_mode;
            retry_mode = 0;
            esp_zigbee_lock_acquire(portMAX_DELAY);
            ezb_bdb_start_top_level_commissioning(mode);
            esp_zigbee_lock_release();
        }
        if (!network_up) continue;
        if (pairing_requested) {
            pairing_requested = false;
            esp_zigbee_lock_acquire(portMAX_DELAY);
            open_pairing();
            esp_zigbee_lock_release();
        }
        if (!g_cfg.plug_paired) continue;
        if (need_basic_read) {
            need_basic_read = false;
            read_attrs(EZB_ZCL_CLUSTER_ID_BASIC, basic_attrs, 6);
            continue;
        }
        if (need_power_on && answered && mains == MAINS_ON) {
            need_power_on = false;
            plug_power_on();
            continue;
        }
        if (need_scale_read || (answered && now - last_scale >= SCALE_EVERY_MS)) {
            need_scale_read = false;
            last_scale = now;
            read_attrs(EZB_ZCL_CLUSTER_ID_ELECTRICAL_MEASUREMENT, scale_attrs, 2);
            continue;
        }
        if (now - last_read >= READ_EVERY_MS) {
            last_read = now;
            read_attrs(EZB_ZCL_CLUSTER_ID_ELECTRICAL_MEASUREMENT, voltage_attr, 1);
        }
        // The verdict: a long silence means no mains (the plug has no battery). The answer first, then
        // the clock: the reads above wait for the Zigbee task, which may take an answer meanwhile, and
        // against the clock from the top of the loop that answer was 49 days old (uint32 wrap): a
        // false «off» and «on» at once on 2026-11-17 at 17:05.
        uint32_t last = last_answer_ms, verdict_at = verdict_at_ms;
        if ((int32_t)(last - now) > 0) answers_during_read++;
        now = hub_ms();
        if (mains == MAINS_ON) {
            uint32_t silent = now - last;
            if (!suspect && silent >= SUSPECT_MS) {
                suspect = true;
                gap_from_ms = last;
                ESP_LOGI(TAG, "the plug is silent %lu ms: waiting before calling it off", (unsigned long)silent);
            }
            if (suspect && silent >= confirm_ms()) {
                suspect = false;
                set_mains(MAINS_OFF, last / 1000.0, true);
            }
        } else if (mains == MAINS_UNKNOWN && !answered && now - verdict_at >= UNKNOWN_TO_OFF_MS) {
            set_mains(MAINS_OFF, -1, false); // when it went is unknown: no event
        }
    }
}

void zb_start(void) {
    xTaskCreate(zigbee_task, "zigbee", 6144, NULL, 5, NULL);
    xTaskCreate(poll_task, "zb_poll", 3072, NULL, 6, NULL);
}
