// Suggest a project: anyone may name a GitHub account, its camp and one line on why. Suggestions are stored, rate
// limited per visitor and in all, and wait for the owner in the admin inbox (the x-pushd-admin-key header, set from
// PUSHD_ADMIN_KEY; never in a page). Nothing is ever added automatically: approving only marks it for the owner. A
// project's suggestions count as a small part of its activity score (src/rank/score.ts, "PUSHD's own signals").
import { timingSafeEqual } from "node:crypto";
import type { DB } from "./db.ts";
import type { GroupKey, Suggestion } from "./types.ts";

export const SUGGEST_SCHEMA = `
CREATE TABLE IF NOT EXISTS suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  login TEXT NOT NULL,
  login_lc TEXT NOT NULL UNIQUE,
  camp TEXT NOT NULL,
  why TEXT NOT NULL,
  at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'new',
  decided_at INTEGER
);
CREATE TABLE IF NOT EXISTS suggestion_acts (visitor TEXT NOT NULL, at INTEGER NOT NULL);
`;

const CAMPS: GroupKey[] = ["chain", "wallets", "launchpads", "ai", "oss"];

export class SuggestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type SuggestDeps = {
  db: DB;
  /** in the Top N now: nothing to suggest */
  inTop: (login: string) => boolean;
  /** its place in the ranking, when it is in the pool */
  rankOf: (login: string) => number | null;
  /** the never-shown list: such a suggestion is taken and dropped without a word */
  hidden: (login: string) => boolean;
  perHour?: number;
  perDay?: number;
  globalPerDay?: number;
  now?: () => number;
};

/** Is this the admin key? Constant time, and never when no key is set. */
export function adminOk(given: unknown, expected: string | null): boolean {
  if (!expected || typeof given !== "string" || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class Suggestions {
  constructor(private readonly d: SuggestDeps) {
    d.db.exec(SUGGEST_SCHEMA);
  }

  private now = () => (this.d.now ?? Date.now)();

  add(input: unknown, visitor: string): { ok: true; already: boolean; message: string } {
    if (!input || typeof input !== "object") throw new SuggestError(400, "Nothing to send.");
    const i = input as Record<string, unknown>;
    const login = typeof i.login === "string" ? i.login.trim().replace(/^@/, "").replace(/^https?:\/\/(www\.)?github\.com\//i, "").replace(/\/.*$/, "") : "";
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login)) throw new SuggestError(400, "That is not a GitHub username or org.");
    const camp = i.camp;
    if (!CAMPS.includes(camp as GroupKey)) throw new SuggestError(400, "Pick a camp.");
    const why = typeof i.why === "string" ? i.why.replace(/[–—]/g, "-").replace(/\s+/g, " ").trim() : "";
    if (why.length < 8) throw new SuggestError(400, "Say in one line why (8 characters at least).");
    if (why.length > 160) throw new SuggestError(400, "One line, please: 160 characters at most.");
    if (/https?:\/\/|www\.|<|>/i.test(why)) throw new SuggestError(400, "No links in the line, please: just the why.");
    const now = this.now();
    this.d.db.prepare("DELETE FROM suggestion_acts WHERE at < ?").run(now - 86_400_000);
    const mine = this.d.db.prepare("SELECT count(*) AS n, sum(at >= ?) AS h FROM suggestion_acts WHERE visitor = ?").get(now - 3_600_000, visitor) as { n: number; h: number | null };
    if ((mine.h ?? 0) >= (this.d.perHour ?? 3)) throw new SuggestError(429, "Thanks! That is enough suggestions for this hour. Try again later.");
    if (mine.n >= (this.d.perDay ?? 10)) throw new SuggestError(429, "Thanks! That is enough suggestions for today.");
    const all = (this.d.db.prepare("SELECT count(*) AS n FROM suggestion_acts").get() as { n: number }).n;
    if (all >= (this.d.globalPerDay ?? 500)) throw new SuggestError(429, "The suggestion box is full for today. Try again tomorrow.");
    if (this.d.inTop(login)) throw new SuggestError(409, `${login} is on the list already.`);
    this.d.db.prepare("INSERT INTO suggestion_acts (visitor, at) VALUES (?, ?)").run(visitor, now);
    // the never-shown list: taken like any other, then dropped
    if (this.d.hidden(login)) return { ok: true, already: false, message: "Thanks. The owner reads every suggestion; nothing is added automatically." };
    const have = this.d.db.prepare("SELECT id FROM suggestions WHERE login_lc = ?").get(login.toLowerCase()) as { id: number } | undefined;
    if (have) {
      this.d.db.prepare("UPDATE suggestions SET count = count + 1, last_at = ? WHERE id = ?").run(now, have.id);
      return { ok: true, already: true, message: `${login} was suggested before. Your vote is counted; the owner reads every suggestion.` };
    }
    this.d.db.prepare("INSERT INTO suggestions (login, login_lc, camp, why, at, last_at) VALUES (?, ?, ?, ?, ?, ?)").run(login, login.toLowerCase(), camp, why, now, now);
    return { ok: true, already: false, message: "Thanks. The owner reads every suggestion; nothing is added automatically." };
  }

  list(limit = 200): Suggestion[] {
    const rows = this.d.db.prepare("SELECT * FROM suggestions ORDER BY status = 'new' DESC, last_at DESC LIMIT ?").all(Math.max(1, Math.min(1000, limit))) as { id: number; login: string; camp: GroupKey; why: string; at: number; status: Suggestion["status"]; count: number }[];
    return rows.map((r) => ({ id: r.id, login: r.login, camp: r.camp, why: r.why, at: new Date(r.at).toISOString(), status: r.status, count: r.count, inTop: this.d.inTop(r.login), rank: this.d.rankOf(r.login) }));
  }

  decide(id: number, status: unknown): Suggestion {
    if (status !== "approved" && status !== "declined" && status !== "new") throw new SuggestError(400, "status must be approved, declined or new");
    const r = this.d.db.prepare("UPDATE suggestions SET status = ?, decided_at = ? WHERE id = ?").run(status, this.now(), id);
    if (!r.changes) throw new SuggestError(404, "No such suggestion.");
    return this.list(1000).find((s) => s.id === id)!;
  }
}
