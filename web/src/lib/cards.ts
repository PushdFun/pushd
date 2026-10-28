import { utcDate } from "./format";
import { KIND_LABEL } from "./groups";
import type { FeedItem } from "./types";

// What picture a gallery card gets. A real picture only when the engine stored the repo's preview; everything else
// is drawn from the line itself, so a card never shows a broken picture.

export type Art =
  | { type: "image"; src: string }
  | { type: "release"; version: string }
  | { type: "gist"; line: string }
  | { type: "terminal"; lines: string[] }
  | { type: "drawn" };

/** The first quoted bit of a summary ('A gist with one line: "soon".' -> soon), when it is short. */
export function quoted(summary: string): string | null {
  const m = summary.match(/["“]([^"”]{1,40})["”]/);
  return m ? m[1].trim() || null : null;
}

/** A command line tool, or anything terminal-like, by its name or its summary. */
export function isTerminalLike(it: Pick<FeedItem, "repo" | "summary">): boolean {
  return /(^|[-_.])(cli|tui|shell|sh)([-_.]|$)/i.test(it.repo) || /\b(command[- ]line|terminal|cli|shell)\b/i.test(it.summary);
}

export function artFor(it: FeedItem): Art {
  if (it.kind === "release") return { type: "release", version: it.version || "new" };
  if (it.kind === "gist") return { type: "gist", line: quoted(it.summary) ?? it.repo };
  if (it.mediaUrl) return { type: "image", src: it.mediaUrl };
  if (isTerminalLike(it)) {
    const out = quoted(it.summary);
    return { type: "terminal", lines: [`$ ${it.repo}`, ...(out ? [out] : []), "$ _"] };
  }
  return { type: "drawn" };
}

/** The repo's owner, as GitHub writes it: from the link when there is one, otherwise the handle. */
export function ownerOf(it: Pick<FeedItem, "url" | "handle">): string {
  const m = it.url?.match(/^https:\/\/github\.com\/([^/]+)/);
  return m ? m[1] : it.handle.replace(/^@/, "");
}

const AVATAR = ["#5b5bd6", "#0e7490", "#b4235a", "#c2410c", "#3b7a57", "#9945ff", "#2f6fd6"];

/** A steady colour per owner, for the drawn card's initial. */
export function avatarColor(owner: string): string {
  let h = 0;
  for (const ch of owner.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR[h % AVATAR.length];
}

/** The drawn card's small line: only what PUSHD knows about the line, never counts it does not have. */
export function drawnStats(it: FeedItem): string[] {
  return [KIND_LABEL[it.kind], utcDate(it.githubAt).replace(/ \d{4}$/, ""), it.score != null ? `heat ${it.score}/10` : null].filter((s): s is string => !!s);
}
