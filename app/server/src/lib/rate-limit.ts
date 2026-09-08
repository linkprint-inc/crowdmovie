// In-process fixed-window counting, shared by every §3.3 rate limit (guest
// claim, register, login, password reset). The plan rules out Redis and any
// queue/cache middleware, so the state lives in the process — good enough for a
// single web process, and the limits it enforces are anti-abuse floors rather
// than quotas that must be exact across a fleet.
//
// The counter deliberately does not know the limit: each caller compares the
// count itself, because login needs to *read* the count before deciding whether
// to serve the request and *record* only afterwards, while the other endpoints
// count every request as it arrives.
export const RATE_WINDOW_MS = 60_000;

interface Window {
  count: number;
  resetAt: number;
}

export class FixedWindowCounter {
  private readonly windows = new Map<string, Window>();
  private readonly windowMs: number;
  private nextSweepAt: number;

  constructor(windowMs: number = RATE_WINDOW_MS) {
    this.windowMs = windowMs;
    this.nextSweepAt = Date.now() + windowMs;
  }

  /**
   * Drop expired entries once per window rather than per request, so a flood of
   * distinct keys cannot turn the bookkeeping itself into the attack.
   */
  private sweep(now: number): void {
    if (now < this.nextSweepAt) return;
    for (const [key, window] of this.windows) {
      if (now >= window.resetAt) this.windows.delete(key);
    }
    this.nextSweepAt = now + this.windowMs;
  }

  /** Count one event against `key` and return the new count in this window. */
  record(key: string): number {
    const now = Date.now();
    this.sweep(now);

    const current = this.windows.get(key);
    if (current !== undefined && now < current.resetAt) {
      current.count += 1;
      return current.count;
    }
    this.windows.set(key, { count: 1, resetAt: now + this.windowMs });
    return 1;
  }

  /** The count for `key` in this window, without recording anything. */
  count(key: string): number {
    const current = this.windows.get(key);
    if (current === undefined || Date.now() >= current.resetAt) return 0;
    return current.count;
  }

  /** Forget `key` — a proven login clears its own account's failure budget. */
  clear(key: string): void {
    this.windows.delete(key);
  }
}
