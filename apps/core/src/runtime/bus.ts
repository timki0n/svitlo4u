/**
 * In-process event bus. Synchronous fan-out: a handler runs the moment an event is emitted, so a
 * power event reaches every channel in the same tick. One failing handler never affects others.
 */
import type {
  DetectorEffect,
  PowerReason,
  PowerState,
  ReminderEvent,
  ScheduleNotification,
} from "@svitlo/domain";
import type { RejectReason } from "../adapters/heartbeat.ts";

export type CoreEvents = {
  "power.changed": {
    siteId: string;
    state: "on" | "off";
    at: number;
    detectedAt: number;
    reason: PowerReason;
    approximate: boolean;
    /** The state that just ended ("unknown" right after a first start). */
    previous: PowerState;
    /** Start of the state that just ended (null when unknown). */
    previousSince: number | null;
  };
  "power.false-alarm": { siteId: string; outageStartedAt: number; detectedAt: number };
  "power.blip": { siteId: string; from: number; to: number };
  "power.network-gap": {
    siteId: string;
    from: number;
    to: number;
    confirmedBy: "zigbee" | "uptime";
  };
  "schedule.updated": { siteId: string };
  "schedule.notification": { siteId: string; notification: ScheduleNotification };
  "reminder.due": { siteId: string; event: ReminderEvent; power: "on" | "off" | "unknown" };
  "voltage.sample": { siteId: string; t: number; voltage: number };
  /** Low or high voltage confirmed: average of the check (V), when it began. */
  "voltage.alert": { siteId: string; kind: "low" | "high"; voltage: number; since: number };
  /** Back to normal for 2 minutes: their average (V). */
  "voltage.stabilized": {
    siteId: string;
    kind: "low" | "high";
    voltage: number;
    since: number;
    at: number;
  };
  "heartbeat.rejected": { reason: RejectReason; remote: string; deviceId?: string };
  "zigbee.bridge": { online: boolean };
  "yasno.error": { error: string; failures: number };
  "yasno.recovered": { failures: number };
};

export type DetectorEffectEvent = Exclude<DetectorEffect, { type: "probe" }>;

type Handler<T> = (payload: T) => void | Promise<void>;

export class EventBus<E extends Record<string, unknown> = CoreEvents> {
  private readonly handlers = new Map<keyof E, Set<Handler<never>>>();
  private readonly onError: (type: keyof E, error: unknown) => void;

  constructor(onError: (type: keyof E, error: unknown) => void = () => {}) {
    this.onError = onError;
  }

  on<K extends keyof E>(type: K, handler: Handler<E[K]>): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler as Handler<never>);
    return () => set.delete(handler as Handler<never>);
  }

  emit<K extends keyof E>(type: K, payload: E[K]): void {
    for (const handler of this.handlers.get(type) ?? []) {
      try {
        const result = (handler as Handler<E[K]>)(payload);
        if (result instanceof Promise) result.catch((error: unknown) => this.onError(type, error));
      } catch (error) {
        this.onError(type, error);
      }
    }
  }
}

export type Bus = EventBus<CoreEvents>;
