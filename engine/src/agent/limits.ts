// Rate limits for the agent API, in memory: a sliding window per client and kind of call. Small and exact enough
// for one engine process; a restart forgets them, which only ever lets a caller in, never locks one out.

export class Limiter {
  private readonly hits = new Map<string, number[]>();
  private lastSweep = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** Counts one call; false (with the seconds to wait) when the client is over `limit` in the window. */
  take(key: string, limit: number, windowMs: number): { ok: true } | { ok: false; retryAfter: number } {
    const now = this.now();
    this.sweep(now);
    const list = (this.hits.get(key) ?? []).filter((t) => t > now - windowMs);
    if (list.length >= limit) {
      this.hits.set(key, list);
      return { ok: false, retryAfter: Math.max(1, Math.ceil((list[0] + windowMs - now) / 1000)) };
    }
    list.push(now);
    this.hits.set(key, list);
    return { ok: true };
  }

  private sweep(now: number) {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [k, v] of this.hits) if (!v.length || v[v.length - 1] < now - 3_600_000) this.hits.delete(k);
  }
}

/** One at a time, with a short line behind it; anything past the line is refused at once. */
export class Gate {
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(
    private readonly max = 1,
    private readonly line = 4,
  ) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.max) {
      if (this.waiting.length >= this.line) throw new Error("busy");
      await new Promise<void>((r) => this.waiting.push(r));
    }
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }
}
