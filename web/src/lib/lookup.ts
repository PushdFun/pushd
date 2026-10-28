import type { Movement, RankRow, ScorePart } from "./types";

// Plain helpers for looking up anyone on GitHub and for the list, safe on the server and in the browser.

/** A GitHub login: letters, digits and single hyphens, at most 39, never starting or ending with a hyphen. */
export const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
/** A repo name as GitHub allows it. */
export const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

export const validLogin = (s: string) => LOGIN_RE.test(s);
export const validRepo = (s: string) => REPO_RE.test(s) && s !== "." && s !== "..";

export type ParsedQuery =
  | { kind: "empty" }
  | { kind: "user"; login: string; href: string }
  | { kind: "repo"; owner: string; repo: string; href: string }
  | { kind: "words"; words: string };

/**
 * What a search box got: a username ("toly", "@toly"), a repo ("owner/name", or a github.com link to either) or free
 * words. A single word could be both a name and a word: it counts as a username, and the search still runs on it.
 */
export function parseQuery(input: string): ParsedQuery {
  let q = input.trim();
  if (!q) return { kind: "empty" };
  const link = q.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/?#\s]+)(?:\/([^/?#\s]+))?\/?(?:[?#].*)?$/i);
  if (link) q = link[2] ? `${link[1]}/${link[2]}` : link[1];
  q = q.replace(/^@/, "");
  const two = q.match(/^([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  if (two && validLogin(two[1]) && validRepo(two[2])) return { kind: "repo", owner: two[1], repo: two[2], href: ghRepoHref(two[1], two[2]) };
  if (!/\s/.test(q) && validLogin(q)) return { kind: "user", login: q, href: ghUserHref(q) };
  return { kind: "words", words: input.trim().slice(0, 80) };
}

export const ghUserHref = (login: string) => `/gh/${encodeURIComponent(login)}`;
export const ghRepoHref = (owner: string, repo: string) => `/gh/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

/** owner/name from a GitHub link to a repo, a commit or a release; null for anything else (a gist). */
export function repoFromUrl(url: string | null | undefined): { owner: string; repo: string } | null {
  const m = url?.match(/^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})(?:[/?#]|$)/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

/** Where a line links on this site: its own page, or for a holder's added account (not on the list) its repo's page. */
export function itemHref(it: { id: string; extra?: boolean; url: string | null }): string {
  if (!it.extra) return `/feed/${it.id}`;
  const r = repoFromUrl(it.url);
  return r ? ghRepoHref(r.owner, r.repo) : (it.url ?? "/feed");
}

/** How a row moved since a day before, in a few characters: "+3", "-2", "new", "=". */
export function movementText(m: Movement, delta: number): string {
  if (m === "new") return "new";
  if (m === "up") return `+${Math.abs(delta)}`;
  if (m === "down") return `-${Math.abs(delta)}`;
  return "=";
}

/** The same, as words for a screen reader. */
export function movementWords(m: Movement, delta: number): string {
  if (m === "new") return "new on the list";
  if (m === "up") return `up ${Math.abs(delta)} place${Math.abs(delta) === 1 ? "" : "s"}`;
  if (m === "down") return `down ${Math.abs(delta)} place${Math.abs(delta) === 1 ? "" : "s"}`;
  return "no change";
}

/** The parts of a score, biggest first. */
export const partsByPoints = (parts: ScorePart[]) => [...parts].sort((a, b) => b.points - a.points || b.weight - a.weight);

/** "24h 3 . 7d 21 . 30d 80" */
export function rawText(raw: Record<string, number>): string {
  const order = ["24h", "7d", "14d", "30d", "total"];
  const keys = Object.keys(raw).sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
  return keys.map((k) => `${k} ${fmtNum(raw[k])}`).join(" . ");
}

const fmtNum = (n: number) => (Number.isInteger(n) ? n.toLocaleString("en-US") : (Math.round(n * 10) / 10).toLocaleString("en-US"));

/** "every 2 min", "every 4 h", "about every 1.5 h" */
export function everyText(min: number | null | undefined): string {
  if (min == null || !Number.isFinite(min) || min <= 0) return "not read";
  if (min < 60) return `every ${Math.max(1, Math.round(min))} min`;
  const h = min / 60;
  if (h < 48) return `every ${Math.round(h * 10) / 10} h`;
  return `every ${Math.round(h / 24)} days`;
}

/** The best part of a row's score, for a one-line "why". */
export function topReason(row: Pick<RankRow, "parts">): string | null {
  const p = partsByPoints(row.parts)[0];
  return p && p.points > 0 ? p.label : null;
}
