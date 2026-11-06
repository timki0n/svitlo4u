/**
 * Time source with absolute-time timers. Services never poll: they ask to be woken at an exact
 * instant. SystemClock uses real timers; ManualClock lets tests jump through time deterministically.
 */

export type Timer = { readonly id: number };

export type Clock = {
  now(): number;
  /** Run `fn` at instant `at` (immediately if `at` is in the past). */
  setTimer(at: number, fn: () => void): Timer;
  clearTimer(timer: Timer | null | undefined): void;
};

export class SystemClock implements Clock {
  private next = 1;
  private readonly handles = new Map<number, ReturnType<typeof setTimeout>>();

  now(): number {
    return Date.now();
  }

  setTimer(at: number, fn: () => void): Timer {
    const id = this.next++;
    const handle = setTimeout(
      () => {
        this.handles.delete(id);
        fn();
      },
      Math.max(0, at - Date.now()),
    );
    this.handles.set(id, handle);
    return { id };
  }

  clearTimer(timer: Timer | null | undefined): void {
    if (!timer) return;
    const handle = this.handles.get(timer.id);
    if (handle) clearTimeout(handle);
    this.handles.delete(timer.id);
  }
}

export class ManualClock implements Clock {
  private current: number;
  private next = 1;
  private timers: { id: number; at: number; fn: () => void }[] = [];

  constructor(start: number) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  setTimer(at: number, fn: () => void): Timer {
    const id = this.next++;
    this.timers.push({ id, at: Math.max(at, this.current), fn });
    return { id };
  }

  clearTimer(timer: Timer | null | undefined): void {
    if (!timer) return;
    this.timers = this.timers.filter((t) => t.id !== timer.id);
  }

  /** Move to `t`, firing due timers in time order (timers may schedule more timers). */
  advanceTo(t: number): void {
    for (;;) {
      const due = this.timers
        .filter((x) => x.at <= t)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.timers = this.timers.filter((x) => x.id !== due.id);
      this.current = Math.max(this.current, due.at);
      due.fn();
    }
    this.current = Math.max(this.current, t);
  }

  advanceBy(ms: number): void {
    this.advanceTo(this.current + ms);
  }

  pending(): number {
    return this.timers.length;
  }
}
