// The template writer: what a scout says when no model is used (no key, the daily cap reached, or the model's answer
// failed the checks). Deterministic and built only from what the store holds: the watcher's line, its signals and
// score, the repo's listing on GitHub and its README's first lines. Every template call is labelled as one on the
// site and in the API. It never judges what a model would judge: unless the stored facts show it plainly (a fork, a
// README that calls itself a joke, no code at all) the verdict is "unclear".
import type { StoredItem } from "../db.ts";
import type { WatchEntry } from "../types.ts";
import type { Verdict } from "./roster.ts";

export type TemplateFacts = {
  /** GitHub lists the repo as a fork */
  fork: boolean | null;
  /** GitHub's main language for it (null: no code found, or not known) */
  language: string | null;
  /** whether the language is known at all (a listing was read) */
  listed: boolean;
  readme: string | null;
};

const JOKE = [/\bjust for fun\b/i, /\bas a joke\b/i, /\b(satire|parody|shitpost)\b/i, /\bthis is a joke\b/i, /\bnot a serious\b/i, /\btoy project\b/i];

/** A signal label, as part of a sentence. */
export function signalPhrase(label: string): string {
  const l = label.trim();
  const fixed: Record<string, string> = {
    "new repo": "a brand new repo",
    "repo made public": "an older repo just made public",
    "public gist": "a public gist",
    release: "a release",
    "push to an existing repo": "new commits to an existing repo",
    "fun name": "a fun name",
    "short name": "a short name",
    "retro computing theme": "a retro computing theme",
    "joke README": "a README that calls itself a joke",
    "images in the repo": "pictures in the repo",
    "emoji in the description": "emoji in the description",
    "account with a big following": "an account with a big following",
    "well-known account": "a well-known account",
    "account with a following": "an account with a following",
  };
  if (fixed[l]) return fixed[l];
  const word = /^word "([^"]+)" in the (name|text)$/.exec(l);
  if (word) return `the word "${word[1]}" in its ${word[2] === "name" ? "name" : "text"}`;
  const major = /^major release (.+)$/.exec(l);
  if (major) return `a major release (${major[1]})`;
  const first = /^first release (.+)$/.exec(l);
  if (first) return `its first release (${first[1]})`;
  return l;
}

const LEADS = new Set(["new repo", "repo made public", "public gist", "release", "push to an existing repo"]);

/** Why it matters, from the signals: what happened, on whose account, and what stands out. */
export function templateWhy(it: Pick<StoredItem, "handle" | "kind" | "signals">, who: Pick<WatchEntry, "org"> | undefined): string {
  const lead = it.signals.find((s) => LEADS.has(s.label) || /^(major|first) release /.test(s.label));
  const rest = it.signals.filter((s) => s !== lead).map((s) => signalPhrase(s.label));
  const what = lead ? signalPhrase(lead.label) : it.kind === "repo" ? "a new repo" : it.kind === "gist" ? "a public gist" : it.kind === "release" ? "a release" : "new commits";
  const owner = `${it.handle}'s account${who?.org ? ` (${who.org})` : ""}`;
  const first = `${what[0].toUpperCase()}${what.slice(1)} on ${owner}.`;
  return rest.length ? `${first} What stands out: ${rest.slice(0, 4).join(", ")}.` : `${first} Nothing else stands out.`;
}

/** The heat reason: the watcher's score and its biggest signals. */
export function templateHeatReason(it: Pick<StoredItem, "score" | "signals">): string {
  const top = [...it.signals].sort((a, b) => b.points - a.points).slice(0, 3);
  return top.length ? `The watcher's score, ${it.score}/10: ${top.map((s) => `${s.label} +${s.points}`).join(", ")}.` : `The watcher's score, ${it.score}/10.`;
}

/** What the stored facts show plainly, and nothing more. */
export function templateVerdict(f: TemplateFacts, signals: { label: string }[]): { verdict: Verdict; whatItIs: string } {
  if (f.fork) return { verdict: "fork", whatItIs: "GitHub lists it as a fork of another repo." };
  if ((f.readme && JOKE.some((re) => re.test(f.readme!))) || signals.some((s) => s.label === "joke README"))
    return { verdict: "joke", whatItIs: "Its README calls it a joke or a toy in its own words." };
  if (f.listed && f.language === null && f.readme) return { verdict: "docs", whatItIs: "GitHub finds no code language in it, only text so far." };
  return { verdict: "unclear", whatItIs: "The template does not judge what it is; that takes a model read of the repo." };
}

export type TemplateCall = {
  line: string;
  why: string;
  heat: number;
  heatReason: string;
  verdict: Verdict | null;
  whatItIs: string | null;
};

export function templateCall(it: StoredItem, who: WatchEntry | undefined, facts: TemplateFacts): TemplateCall {
  const deep = it.kind === "repo" || it.kind === "release";
  const v = deep ? templateVerdict(facts, it.signals) : null;
  return {
    line: it.summary,
    why: templateWhy(it, who),
    heat: it.score,
    heatReason: templateHeatReason(it),
    verdict: v?.verdict ?? null,
    whatItIs: v?.whatItIs ?? null,
  };
}
