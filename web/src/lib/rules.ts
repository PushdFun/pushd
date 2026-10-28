import type { GroupKey, Kind, Rule } from "./types";

// A holder's own scout rule in plain words, the same sentence the engine writes (engine/src/scouts/rules.ts
// readable(); engine/test/rules-readable.test.ts checks the two agree). The editor shows it as the rule changes.

const CAMP_WORDS: Record<GroupKey, string> = { chain: "Robinhood Chain projects", wallets: "Base and EVM projects", launchpads: "Solana and pump.fun projects", ai: "AI agent projects", oss: "tools and infra projects" };
const KIND_WORDS: Record<Kind, string> = { repo: "new repos", release: "releases", push: "pushes", gist: "gists" };
export const KIND_CHIP: Record<Kind, string> = { repo: "new repo", release: "release", push: "push", gist: "gist" };
export const RULE_KINDS: Kind[] = ["repo", "release", "push", "gist"];

const list = (xs: string[], joiner = "or") => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} ${joiner} ${xs[xs.length - 1]}`);

export function readable(r: Rule): string {
  const who: string[] = [];
  if (r.builders.length) {
    const names = r.builders.slice(0, 6);
    who.push(r.builders.length > 6 ? `${names.join(", ")} and ${r.builders.length - 6} more` : list(names));
  }
  if (r.camps.length) who.push(`anyone in ${list(r.camps.map((c) => CAMP_WORDS[c]))}`);
  const kinds = r.kinds.length ? list(r.kinds.map((k) => KIND_WORDS[k])) : "new lines";
  const whoText = who.length ? ` from ${who.join(", or ")}` : " from anyone on the watchlist";
  const about = r.keywords.length ? ` that mention ${list(r.keywords.map((k) => `"${k}"`))}` : "";
  const heat = r.heatFloor > 0 ? ` at heat ${r.heatFloor} or more` : "";
  return `Tell me about ${kinds}${whoText}${about}${heat}.`;
}

export const EMPTY_RULE: Rule = { builders: [], camps: [], kinds: [], keywords: [], heatFloor: 0 };

/** A rule matches every line when it names nothing: the engine refuses those. */
export const matchesAll = (r: Rule) => !r.builders.length && !r.camps.length && !r.kinds.length && !r.keywords.length && r.heatFloor === 0;

/** A keyword the engine can match: letters, digits, spaces and . + # _ - */
export const cleanKeyword = (k: string) => {
  const w = k.trim().toLowerCase().replace(/\s+/g, " ");
  return w.length >= 2 && w.length <= 30 && /^[a-z0-9][a-z0-9 .+#_-]*$/.test(w) ? w : null;
};
