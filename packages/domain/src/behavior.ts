/**
 * Behaviour switches for schedule logic.
 *
 * LEGACY_BEHAVIOR reproduces the old Python bot exactly (golden parity tests).
 * DEFAULT_BEHAVIOR is what production runs — see packages/domain/test/golden/REVIEW.md.
 */

export type GracePolicy =
  | {
      kind: "fixed";
      /** Power lost this long before a planned start counts as that outage. */
      earlyStartMin: number;
      /** Legacy extra branch: next window starts within this → show its end. */
      futureSoonMin: number;
      /** Power still on this long after a planned start → "мало відбутися". */
      missedStartMin: number;
      /** Power still off this long after a planned end → "мало відновитися". */
      restoreDelayMin: number;
    }
  | {
      kind: "proportional";
      /** Share of the light-on window before the outage. */
      earlyStartRatio: number;
      /** Share of the outage window. */
      missedStartRatio: number;
      /** Share of the light-on window after the outage. */
      restoreDelayRatio: number;
      minMinutes: number;
      /** Upper bound for every tolerance: long light-on windows must not stretch them for hours. */
      maxMinutes: number;
    };

export type TomorrowMonitorMode =
  /** Legacy: notify only when tomorrow goes from WaitingForSchedule to published. */
  | "published-only"
  /** R8: notify on every meaningful change of tomorrow. */
  | "all-changes";

export type ScheduleBehavior = {
  /** R1/R2: merge adjacent windows (incl. across midnight) before any calculation. */
  mergeAdjacentWindows: boolean;
  /** R14: fixed 45/90-minute tolerances or proportional ones. */
  grace: GracePolicy;
  /** R3: power on during a planned window → talk about that window, not the next one. */
  inWindowAwareness: boolean;
  tomorrowMonitor: TomorrowMonitorMode;
};

export const LEGACY_BEHAVIOR: ScheduleBehavior = {
  mergeAdjacentWindows: false,
  grace: {
    kind: "fixed",
    earlyStartMin: 45,
    futureSoonMin: 90,
    missedStartMin: 90,
    restoreDelayMin: 90,
  },
  inWindowAwareness: false,
  tomorrowMonitor: "published-only",
};

export const DEFAULT_BEHAVIOR: ScheduleBehavior = {
  mergeAdjacentWindows: true,
  grace: {
    kind: "proportional",
    earlyStartRatio: 0.25,
    missedStartRatio: 0.5,
    restoreDelayRatio: 0.5,
    minMinutes: 15,
    maxMinutes: 180,
  },
  inWindowAwareness: true,
  tomorrowMonitor: "all-changes",
};
