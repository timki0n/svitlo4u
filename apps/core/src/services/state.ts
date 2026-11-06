/**
 * Current state of every site, in memory — what /status, the API and SSE answer from instantly.
 */
import {
  type DaySchedule,
  DEFAULT_BEHAVIOR,
  nearestOutageMessage,
  nearestRestoreMessage,
  type PlanContext,
  type PowerState,
} from "@svitlo/domain";
import type { SiteConfig } from "../sites-config.ts";

export type SiteSchedule = {
  today: DaySchedule;
  tomorrow: DaySchedule;
  /** From history: lets windows crossing midnight stay whole. */
  yesterday: DaySchedule | null;
  updatedOn: string | null;
  fetchedAt: number | null;
};

export type SiteState = {
  siteId: string;
  power: PowerState;
  /** Start of the current power state (null when unknown). */
  since: number | null;
  schedule: SiteSchedule | null;
  lastEspAt: number | null;
  lastPlugAt: number | null;
  lastVoltage: number | null;
};

export class SiteStateStore {
  private readonly sites = new Map<string, SiteConfig>();
  private readonly states = new Map<string, SiteState>();

  constructor(sites: readonly SiteConfig[]) {
    for (const site of sites) {
      this.sites.set(site.id, site);
      this.states.set(site.id, {
        siteId: site.id,
        power: "unknown",
        since: null,
        schedule: null,
        lastEspAt: null,
        lastPlugAt: null,
        lastVoltage: null,
      });
    }
  }

  get(siteId: string): SiteState {
    const state = this.states.get(siteId);
    if (!state) throw new Error(`unknown site ${siteId}`);
    return state;
  }

  site(siteId: string): SiteConfig {
    const site = this.sites.get(siteId);
    if (!site) throw new Error(`unknown site ${siteId}`);
    return site;
  }

  all(): SiteState[] {
    return [...this.states.values()];
  }

  update(siteId: string, patch: Partial<Omit<SiteState, "siteId">>): void {
    Object.assign(this.get(siteId), patch);
  }

  /** The schedule as the plan texts see it (production behaviour), or null before Yasno answered. */
  planContext(siteId: string): PlanContext | null {
    const state = this.get(siteId);
    if (!state.schedule) return null;
    const site = this.site(siteId);
    return {
      tz: site.tz,
      linkUrl: site.linkUrl,
      behavior: DEFAULT_BEHAVIOR,
      today: state.schedule.today,
      tomorrow: state.schedule.tomorrow,
      yesterday: state.schedule.yesterday,
    };
  }

  /** "When will power come back" / "next outage" for the current moment. */
  planTexts(siteId: string, now: number): { restore: string; outage: string } | null {
    const ctx = this.planContext(siteId);
    if (!ctx) return null;
    return { restore: nearestRestoreMessage(ctx, now), outage: nearestOutageMessage(ctx, now) };
  }
}
