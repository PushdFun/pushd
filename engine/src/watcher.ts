// The watcher: polls each watched account's public activity in turn, spread over time so the rate limit lasts.
// Per account: the events (conditional, so an unchanged list is a cheap 304), the repo list when the events hint at a
// new or newly public repo (and every few polls anyway), and public gists every few polls. It records two times for
// every line: githubAt (when GitHub says it happened) and seenAt (when the watcher saw it). It never claims instant:
// GitHub's own event lists run from seconds to minutes behind, and the watcher adds up to one poll interval.
import { account, setMeta, updateAccount, type DB } from "./db.ts";
import type { GhEvent, GhGist, GhRepo, GitHub } from "./github.ts";
import type { MediaQueue } from "./media.ts";
import { extraMinutes, shareRoom, sharesFor, tierMinutes, tierOf } from "./plan.ts";
import { fromEvents, fromGists, fromRepos, Pipeline, type Outcome } from "./pipeline.ts";
import type { Candidate, WatchEntry } from "./types.ts";

const DAY = 86_400_000;

export type WatcherOptions = {
  db: DB;
  gh: GitHub;
  accounts: WatchEntry[];
  openRouterKey?: string | null;
  openRouterModel?: string;
  backfillHours?: number;
  log?: (msg: string) => void;
  now?: () => number;
  /** the gap between polls, instead of the budget's spacing (for a short local check; the rate limit still holds) */
  minGapMs?: number;
  /** every new line about a repo queues that repo's preview picture here */
  media?: MediaQueue | null;
  /**
   * Accounts holders added to their own lists (src/holderwatch.ts): read at a lower priority, only when no watched
   * project is due, within their own share of the hour, into their own store (never the public feed).
   */
  extras?: { db: DB; gh: GitHub; list: () => WatchEntry[] } | null;
  /** keep each part inside its share of the hour (src/plan.ts); off for short local checks */
  shares?: boolean;
};

type Target = { db: DB; gh: GitHub; pipeline: Pipeline; extra: boolean };

export type PollResult = { handle: string; requests: number; newEvents: number; outcomes: Outcome[] };

export class Watcher {
  readonly pipeline: Pipeline;
  private readonly extraPipeline: Pipeline | null;
  private stopped = false;
  private wake: (() => void) | null = null;
  private readonly log: (msg: string) => void;
  private readonly now: () => number;

  constructor(private readonly o: WatcherOptions) {
    this.log = o.log ?? (() => {});
    this.now = o.now ?? Date.now;
    this.pipeline = new Pipeline({
      db: o.db,
      gh: o.gh,
      openRouterKey: o.openRouterKey,
      openRouterModel: o.openRouterModel,
      now: this.now,
      log: this.log,
      readCommits: o.gh.authenticated,
      onItem: o.media ? (it) => o.media?.enqueueItem(it) : undefined,
    });
    this.extraPipeline = o.extras
      ? new Pipeline({ db: o.extras.db, gh: o.extras.gh, openRouterKey: null, now: this.now, log: this.log, readCommits: false })
      : null;
  }

  private get main(): Target {
    return { db: this.o.db, gh: this.o.gh, pipeline: this.pipeline, extra: false };
  }

  /** How often each part is read: with a token, gists and the repo list every other poll; without, every fourth. */
  private get every() {
    return this.o.gh.authenticated ? { repos: 4, gists: 2 } : { repos: 6, gists: 4 };
  }

  /** One look at one watched account. */
  poll(entry: WatchEntry): Promise<PollResult> {
    return this.pollWith(entry, this.main);
  }

  /** One look at one holder-added account, into the extras store. */
  pollExtra(entry: WatchEntry): Promise<PollResult> {
    if (!this.o.extras || !this.extraPipeline) throw new Error("no extras store");
    return this.pollWith(entry, { db: this.o.extras.db, gh: this.o.extras.gh, pipeline: this.extraPipeline, extra: true });
  }

  private async pollWith(entry: WatchEntry, t: Target): Promise<PollResult> {
    const db = t.db;
    const gh = t.gh;
    const h = entry.handle;
    const acc = account(db, h);
    const first = !acc.baseline_at;
    const nowIso = new Date(this.now()).toISOString();
    const before = gh.requests;
    const backfillFrom = new Date(this.now() - (this.o.backfillHours ?? 48) * 3_600_000).toISOString();

    const eventsPath = entry.type === "org" ? `/orgs/${h}/events?per_page=100` : `/users/${h}/events/public?per_page=100`;
    const ev = await gh.get<GhEvent[]>(eventsPath);
    const events = Array.isArray(ev.data) ? ev.data : [];
    const { candidates: evCands, activity } = fromEvents(entry, events);

    // how far back the store's knowledge reaches: the oldest event in the list (GitHub keeps at most 90 days and
    // cuts long lists short, so only what the list shows counts as known; an empty list means 90 quiet days)
    let historySince = acc.history_since;
    if (first) historySince = events.length ? events.reduce((m, e) => (e.created_at < m ? e.created_at : m), nowIso) : new Date(this.now() - 90 * DAY).toISOString();

    const hint = evCands.some((c) => c.sub === "new-repo" || c.sub === "made-public");
    const cands: Candidate[] = [...evCands];
    if (first || hint || acc.polls % this.every.repos === 0) {
      const rl = await gh.get<GhRepo[]>(`/users/${h}/repos?sort=created&direction=desc&per_page=30&type=owner`);
      if (Array.isArray(rl.data)) {
        const known = (id: number) => !!db.prepare("SELECT 1 FROM repos WHERE id = ?").get(id);
        // on the first look every repo is unknown: only the ones created inside the backfill window are news
        const since = first ? backfillFrom : (acc.baseline_at ?? backfillFrom);
        const found = fromRepos(entry, rl.data, known, since, nowIso).filter((c) => !first || c.sub === "new-repo");
        cands.push(...found);
        t.pipeline.rememberRepos(h, rl.data);
      }
    }
    if (entry.type === "user" && (first || acc.polls % this.every.gists === 0)) {
      const gl = await gh.get<GhGist[]>(`/users/${h}/gists?per_page=10`);
      if (Array.isArray(gl.data)) {
        const isKnown = (k: string) => !!db.prepare("SELECT 1 FROM events WHERE key = ?").get(k);
        cands.push(...fromGists(entry, gl.data, isKnown));
      }
    }

    // oldest first, so "the previous activity" is always already in the store
    t.pipeline.recordActivity(activity);
    cands.sort((a, b) => a.githubAt.localeCompare(b.githubAt));
    const outcomes: Outcome[] = [];
    for (const c of cands) {
      const out = await t.pipeline.run(entry, c, {
        historySince,
        backfillBefore: first ? nowIso : (acc.baseline_at ?? undefined),
        skipBefore: first ? backfillFrom : undefined,
        eventType: c.key.startsWith("repo:") ? "RepoList" : c.key.startsWith("gist:") ? "Gist" : undefined,
      });
      if (out.verdict !== "seen before") outcomes.push(out);
      if (out.item) this.log(`+ ${out.item.heat.padEnd(8)} ${h}/${out.item.repo}${out.item.version ? " " + out.item.version : ""}  "${out.item.summary}"`);
    }

    updateAccount(db, h, {
      ...(first ? { baseline_at: nowIso, history_since: historySince } : {}),
      polls: acc.polls + 1,
      last_poll_at: nowIso,
      last_status: ev.status,
    });
    const rate = gh.rate;
    if (!t.extra) setMeta(db, "watcher", JSON.stringify({ lastPollAt: nowIso, lastHandle: h, authenticated: gh.authenticated, rate, requests: gh.requests, notModified: gh.notModified }));
    return { handle: h, requests: gh.requests - before, newEvents: outcomes.length + activity.length, outcomes };
  }

  /** Minutes between two reads of the project at this place in the list (src/plan.ts: three tiers by rank). */
  intervalFor(index: number): number {
    const auth = this.o.gh.authenticated;
    const n = this.o.accounts.length;
    return tierMinutes(n, sharesFor(auth).watch, auth)[tierOf(index + 1)] * 60_000;
  }

  /** The time between two polls of the same account, the old way (one interval for all); kept for the replay. */
  accountInterval(pollIntervalSec: number | null = null): number {
    const n = this.o.accounts.length;
    const floor = Math.max(60_000, (pollIntervalSec ?? 0) * 1000);
    const spacing = this.o.gh.spacingMs(this.o.gh.authenticated ? 1_000 : 5_000);
    return Math.max(floor, Math.round(n * 1.3 * spacing));
  }

  /**
   * Polls until stop(): the most overdue watched project first, each tier on its own interval, inside the watch share;
   * when no watched project is due, the most overdue holder-added account, inside the extra share. The watched list is
   * read live (the ranking changes it in place), so projects that enter are read on the next turn.
   */
  async run(opts: { until?: number } = {}) {
    const db = this.o.db;
    const auth = this.o.gh.authenticated;
    const shares = this.o.shares ?? true;
    const due = new Map<string, number>();
    const extraDue = new Map<string, number>();
    this.log(`watching ${this.o.accounts.length} accounts, ${auth ? "with a token" : "without a token (60 requests an hour: slow schedule)"}`);
    while (!this.stopped && (!opts.until || this.now() < opts.until)) {
      // follow the live list: new projects join (due now unless the store says later), gone ones leave
      const live = new Set(this.o.accounts.map((e) => e.handle));
      for (const e of this.o.accounts) if (!due.has(e.handle)) due.set(e.handle, account(db, e.handle).next_due_at);
      for (const k of [...due.keys()]) if (!live.has(k)) due.delete(k);
      const extras = this.o.extras?.list() ?? [];
      const liveX = new Set(extras.map((e) => e.handle));
      for (const e of extras) if (!extraDue.has(e.handle)) extraDue.set(e.handle, account(this.o.extras!.db, e.handle).next_due_at);
      for (const k of [...extraDue.keys()]) if (!liveX.has(k)) extraDue.delete(k);

      const next = [...due.entries()].sort((a, b) => a[1] - b[1])[0];
      const nowMs = this.now();
      if (next && next[1] <= nowMs) {
        if (shares && !shareRoom(db, "watch", auth, 2, nowMs)) {
          await this.sleep(60_000);
          continue;
        }
        const [handle] = next;
        const idx = this.o.accounts.findIndex((e) => e.handle === handle);
        const entry = this.o.accounts[idx];
        let res: PollResult | null = null;
        try {
          res = await this.poll(entry);
        } catch (e) {
          this.log(`poll ${handle} failed: ${(e as Error).message}`);
        }
        const at = this.now() + this.intervalFor(Math.max(0, idx));
        due.set(handle, at);
        updateAccount(db, handle, { next_due_at: at });
        const r = this.o.gh.rate;
        if (res) this.log(`polled ${handle}: ${res.requests} request(s), ${res.outcomes.filter((x) => x.item).length} new line(s)${r ? `, ${r.remaining}/${r.limit} left` : ""}`);
        const gap = this.o.minGapMs ?? this.o.gh.spacingMs(auth ? 1_000 : 5_000);
        await this.sleep(gap * Math.max(1, res?.requests ?? 1));
        continue;
      }
      // nothing watched is due: a holder-added account, when one is due and its share has room
      const nx = [...extraDue.entries()].sort((a, b) => a[1] - b[1])[0];
      if (nx && nx[1] <= nowMs && this.o.extras && (!shares || shareRoom(db, "extra", auth, 2, nowMs))) {
        const entry = extras.find((e) => e.handle === nx[0])!;
        try {
          const res = await this.pollExtra(entry);
          this.log(`polled added account ${entry.handle}: ${res.requests} request(s), ${res.outcomes.filter((x) => x.item).length} new line(s)`);
        } catch (e) {
          this.log(`poll added ${entry.handle} failed: ${(e as Error).message}`);
        }
        const at = this.now() + extraMinutes(extras.length, sharesFor(auth).extra, auth) * 60_000;
        extraDue.set(entry.handle, at);
        updateAccount(this.o.extras.db, entry.handle, { next_due_at: at });
        await this.sleep(this.o.minGapMs ?? this.o.extras.gh.spacingMs(auth ? 1_000 : 5_000));
        continue;
      }
      const wakeAt = Math.min(next?.[1] ?? nowMs + 60_000, nx?.[1] ?? Infinity, nowMs + 60_000);
      await this.sleep(Math.max(1_000, opts.until ? Math.min(wakeAt - nowMs, opts.until - nowMs) : wakeAt - nowMs));
    }
  }

  private sleep(ms: number) {
    return new Promise<void>((resolve) => {
      const t = setTimeout(() => ((this.wake = null), resolve()), Math.max(0, ms));
      this.wake = () => (clearTimeout(t), (this.wake = null), resolve());
    });
  }

  stop() {
    this.stopped = true;
    this.wake?.();
  }
}
