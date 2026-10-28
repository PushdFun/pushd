// A holder's own scout is a rule: who (builders and camps), what (kinds of line), about what (keywords) and how hot
// (a floor on the watcher's score). Plain words become a rule once, when the holder writes it (a model when there is
// a key, the template parser otherwise); the holder sees it, edits it and saves it. After that every new line is
// matched against every saved rule here, with no model call.
import type { GroupKey, Kind, WatchEntry } from "../types.ts";

export type Rule = {
  /** handles from the watchlist; with camps, "who" is anyone in either. Both empty: anyone. */
  builders: string[];
  camps: GroupKey[];
  /** empty: any kind */
  kinds: Kind[];
  /** any of these words in the repo's name, its line, the scout's words or the README's first lines. Empty: no word needed. */
  keywords: string[];
  /** the watcher's score, 0 to 10, at least */
  heatFloor: number;
};

export const CAMPS: GroupKey[] = ["chain", "wallets", "launchpads", "ai", "oss"];
export const KINDS: Kind[] = ["repo", "release", "push", "gist"];
export const RULE_LIMITS = { builders: 40, keywords: 12, keyword: 30, name: 40, text: 300 };

const CAMP_WORDS: Record<GroupKey, string> = { chain: "Robinhood Chain projects", wallets: "Base and EVM projects", launchpads: "Solana and pump.fun projects", ai: "AI agent projects", oss: "tools and infra projects" };
const KIND_WORDS: Record<Kind, [string, string]> = { repo: ["a new repo", "new repos"], release: ["a release", "releases"], push: ["a push", "pushes"], gist: ["a gist", "gists"] };

export class RuleError extends Error {}

/** A rule from anything (the model's answer, a holder's edit): every field checked, unknown builders refused. */
export function checkRule(input: unknown, accounts: WatchEntry[], o: { dropUnknown?: boolean } = {}): { rule: Rule; dropped: string[] } {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new RuleError("The rule is not valid.");
  const i = input as Record<string, unknown>;
  const canon = new Map(accounts.map((a) => [a.handle.toLowerCase(), a.handle]));
  const arr = (v: unknown, what: string, max: number): unknown[] => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) throw new RuleError(`${what} must be a list.`);
    if (v.length > max) throw new RuleError(`At most ${max} ${what}.`);
    return v;
  };
  const dropped: string[] = [];
  const builders: string[] = [];
  for (const b of arr(i.builders, "builders", RULE_LIMITS.builders)) {
    const h = typeof b === "string" ? canon.get(b.trim().replace(/^@/, "").toLowerCase()) : undefined;
    if (!h) {
      if (o.dropUnknown) {
        dropped.push(String(b).slice(0, 40));
        continue;
      }
      throw new RuleError(`${String(b).slice(0, 40)} is not on the watchlist.`);
    }
    if (!builders.includes(h)) builders.push(h);
  }
  const camps: GroupKey[] = [];
  for (const c of arr(i.camps, "camps", 5)) {
    if (!CAMPS.includes(c as GroupKey)) throw new RuleError(`${String(c).slice(0, 20)} is not a camp.`);
    if (!camps.includes(c as GroupKey)) camps.push(c as GroupKey);
  }
  const kinds: Kind[] = [];
  for (const k of arr(i.kinds, "kinds", 4)) {
    if (!KINDS.includes(k as Kind)) throw new RuleError(`${String(k).slice(0, 20)} is not a kind of line.`);
    if (!kinds.includes(k as Kind)) kinds.push(k as Kind);
  }
  const keywords: string[] = [];
  for (const k of arr(i.keywords, "keywords", RULE_LIMITS.keywords)) {
    if (typeof k !== "string") throw new RuleError("A keyword must be text.");
    const w = k.trim().toLowerCase().replace(/\s+/g, " ");
    if (!w) continue;
    if (w.length < 2 || w.length > RULE_LIMITS.keyword || !/^[a-z0-9][a-z0-9 .+#_-]*$/.test(w)) throw new RuleError(`"${k.slice(0, 30)}" is not a keyword PUSHD can match (letters, digits, spaces, . + # _ -).`);
    if (!keywords.includes(w)) keywords.push(w);
  }
  const hf = i.heatFloor ?? 0;
  if (typeof hf !== "number" || !Number.isInteger(hf) || hf < 0 || hf > 10) throw new RuleError("The heat floor must be a whole number from 0 to 10.");
  if (!builders.length && !camps.length && !kinds.length && !keywords.length && hf === 0) throw new RuleError("This rule would match every line. Name some builders, a camp, a kind, a word or a heat floor.");
  return { rule: { builders, camps, kinds, keywords, heatFloor: hf }, dropped };
}

const list = (xs: string[], joiner = "or") => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} ${joiner} ${xs[xs.length - 1]}`);

/** The rule in plain words, as the holder reads it before saving. */
export function readable(r: Rule): string {
  const who: string[] = [];
  if (r.builders.length) {
    const names = r.builders.slice(0, 6);
    who.push(r.builders.length > 6 ? `${names.join(", ")} and ${r.builders.length - 6} more` : list(names));
  }
  if (r.camps.length) who.push(`anyone in ${list(r.camps.map((c) => CAMP_WORDS[c]))}`);
  const kinds = r.kinds.length ? list(r.kinds.map((k) => KIND_WORDS[k][1])) : "new lines";
  const whoText = who.length ? ` from ${who.join(", or ")}` : " from anyone on the watchlist";
  const about = r.keywords.length ? ` that mention ${list(r.keywords.map((k) => `"${k}"`))}` : "";
  const heat = r.heatFloor > 0 ? ` at heat ${r.heatFloor} or more` : "";
  return `Tell me about ${kinds}${whoText}${about}${heat}.`;
}

/** The word, and the same word with a plural or a verb ending. */
const keywordRe = (k: string) => {
  const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "[\\s_-]+");
  const root = k.length > 4 && k.endsWith("s") ? k.slice(0, -1) : k;
  return new RegExp(`(^|[^a-z0-9])(${esc(k)}|${esc(root)})(s|es|ing|ed)?([^a-z0-9]|$)`, "i");
};

export type MatchInput = { handle: string; group: GroupKey; kind: Kind; score: number; text: string };

/** Does a line match a rule? And if so, which parts of the rule it met. */
export function match(r: Rule, it: MatchInput): { hit: false } | { hit: true; parts: string[] } {
  const parts: string[] = [];
  if (r.builders.length || r.camps.length) {
    const byBuilder = r.builders.some((b) => b.toLowerCase() === it.handle.toLowerCase());
    const byCamp = r.camps.includes(it.group);
    if (!byBuilder && !byCamp) return { hit: false };
    parts.push(byBuilder ? `${it.handle} is on your list` : `${it.handle} is in ${CAMP_WORDS[it.group]}`);
  }
  if (r.kinds.length) {
    if (!r.kinds.includes(it.kind)) return { hit: false };
    parts.push(`it is ${KIND_WORDS[it.kind][0]}`);
  }
  if (r.keywords.length) {
    const found = r.keywords.find((k) => keywordRe(k).test(it.text));
    if (!found) return { hit: false };
    parts.push(`it mentions "${found}"`);
  }
  if (it.score < r.heatFloor) return { hit: false };
  if (r.heatFloor > 0) parts.push(`its heat is ${it.score}, your floor is ${r.heatFloor}`);
  return { hit: true, parts };
}

/** "Matched: x, y and z." */
export const matchNote = (parts: string[]) => `Matched: ${list(parts, "and")}.`;

// ---- the template parser: plain words to a rule draft, with no model ----

const STOP = new Set(
  "a an the me my i when whenever if tell notify alert ping show let know about any anyone someone something new creates create created makes make made ships ship shipped publishes publish published pushes push pushed releases release released repo repos repository repositories project projects gist gists commit commits that which who with on of in for to or and from by is are be it its their there this those these please also only just like something related regarding mentioning mention mentions anything founder founders core dev devs developer developers person people team teams lab labs camp chain chains wallet wallets tooling launchpad launchpads ai open source oss heat hot very high higher more than at least least score".split(
    " ",
  ),
);

export function templateRule(text: string, accounts: WatchEntry[]): { rule: Rule; notes: string[] } {
  const t = ` ${text.toLowerCase().replace(/[^a-z0-9.+#\s-]/g, " ").replace(/\s+/g, " ")} `;
  const has = (w: string) => new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`).test(t);
  const notes: string[] = [];
  const people = /\b(founders?|core devs?|developers?|devs?|person|people|engineers?)\b/.test(t);
  const builders: string[] = [];
  const orgsHit = new Set<string>();
  for (const a of accounts) {
    const org = a.org.toLowerCase();
    if (has(a.handle.toLowerCase()) || has(a.name.toLowerCase())) builders.push(a.handle);
    else if (org.length >= 3 && has(org)) {
      orgsHit.add(a.org);
      if (!people || a.type === "user") builders.push(a.handle);
    }
  }
  if (orgsHit.size) notes.push(`"${[...orgsHit].join('", "')}" read as the watched accounts known for ${[...orgsHit].length > 1 ? "them" : "it"}${people ? " (people only)" : ""}.`);
  const camps: GroupKey[] = [];
  // the camps by their names now (src/rank/config.ts), and the words of the old ones
  if (/\brobinhood\b|\bcore devs?\b/.test(t) && !orgsHit.size) camps.push("chain");
  if (/\bbase\b|\bevm\b|\bwallets?\b/.test(t)) camps.push("wallets");
  if (/\bsolana\b|\bpump\.?fun\b|\blaunchpads?\b/.test(t) && !orgsHit.size) camps.push("launchpads");
  if (/\bai agents?\b|\bagents?\b|\bai labs?\b|\bai\b/.test(t)) camps.push("ai");
  if (/\btools?\b|\binfra\b|\btooling\b|\bopen source\b|\boss\b/.test(t)) camps.push("oss");
  const kinds: Kind[] = [];
  if (/\b(new )?(repo|repos|repository|repositories|project|projects)\b|\bcreates?\b|\bcreated\b|\bstarts?\b/.test(t)) kinds.push("repo");
  if (/\breleases?\b|\breleased\b|\bships?\b|\bshipped\b|\bversion\b/.test(t)) kinds.push("release");
  if (/\bgists?\b/.test(t)) kinds.push("gist");
  if (/\bpush(es|ed)?\b|\bcommits?\b/.test(t)) kinds.push("push");
  let heatFloor = 0;
  const n = /\bheat (?:of |at least |over |above )?(\d{1,2})\b/.exec(t);
  if (n && Number(n[1]) <= 10) heatFloor = Number(n[1]);
  else if (/\bvery hot\b|\bvery high\b/.test(t)) heatFloor = 8;
  else if (/\bhot\b|\bhigh heat\b/.test(t)) heatFloor = 6;
  const orgWords = new Set([...orgsHit].flatMap((o) => o.toLowerCase().split(/\s+/)));
  const handleWords = new Set(builders.flatMap((h) => [h.toLowerCase(), ...(accounts.find((a) => a.handle === h)?.name.toLowerCase().split(/\s+/) ?? [])]));
  const keywords: string[] = [];
  for (const w of t.trim().split(" ")) {
    const k = w.replace(/^[.+#-]+|[.+#-]+$/g, "");
    if (k.length < 3 || STOP.has(k) || orgWords.has(k) || handleWords.has(k) || /^\d+$/.test(k)) continue;
    if (!keywords.includes(k) && keywords.length < 8) keywords.push(k);
  }
  const draft = { builders: [...new Set(builders)].slice(0, RULE_LIMITS.builders), camps, kinds, keywords, heatFloor };
  try {
    return { rule: checkRule(draft, accounts, { dropUnknown: true }).rule, notes };
  } catch (e) {
    notes.push((e as Error).message);
    return { rule: { ...draft, heatFloor: draft.heatFloor || 6 }, notes };
  }
}
