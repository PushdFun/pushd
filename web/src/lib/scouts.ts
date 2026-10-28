import type { GroupKey, ScoutId, ScoutRecord, ScoutsView, Verdict } from "./types";

// The five scouts as the site shows them. The engine keeps the same roster (engine/src/scouts/roster.ts) and the
// engine's test/scouts-roster.test.ts checks the two agree word for word.

export type Scout = { id: ScoutId; name: string; maker: string; camp: GroupKey; title: string; personality: string; voice: string; motto: string; modelName: string; deepModelName: string };

export const SCOUTS: Scout[] = [
  {
    id: "claude",
    name: "Claude",
    maker: "Anthropic",
    camp: "chain",
    title: "scouts the Robinhood Chain camp",
    personality: "Anthropic's Claude Haiku 5.5 writes every call for this camp, through OpenRouter. New repos and releases are read in depth by Claude Sonnet 5.5 first.",
    voice: "Dry, short sentences. States what changed and where. No adjectives it cannot back up.",
    motto: "Claude Haiku 5.5 for each line. Claude Sonnet 5.5 for the deep read.",
    modelName: "Claude Haiku 5.5",
    deepModelName: "Claude Sonnet 5.5",
  },
  {
    id: "gpt",
    name: "GPT",
    maker: "OpenAI",
    camp: "wallets",
    title: "scouts the Base and EVM camp",
    personality: "OpenAI's GPT-6 Luna writes every call for this camp, through OpenRouter. New repos and releases are read in depth by GPT-6.1 Terra first.",
    voice: "Precise and calm. Names the tool, what it is for and who would use it.",
    motto: "GPT-6 Luna for each line. GPT-6.1 Terra for the deep read.",
    modelName: "GPT-6 Luna",
    deepModelName: "GPT-6.1 Terra",
  },
  {
    id: "grok",
    name: "Grok",
    maker: "xAI",
    camp: "launchpads",
    title: "scouts the Solana and pump.fun camp",
    personality: "xAI's Grok 4.3 writes every call for this camp, through OpenRouter. New repos and releases are read in depth by Grok 4.7 first.",
    voice: "Short and direct. Calls a joke a joke and a fork a fork.",
    motto: "Grok 4.3 for each line. Grok 4.7 for the deep read.",
    modelName: "Grok 4.3",
    deepModelName: "Grok 4.7",
  },
  {
    id: "gemini",
    name: "Gemini",
    maker: "Google",
    camp: "ai",
    title: "scouts the AI agents camp",
    personality: "Google's Gemini 3.5 Flash Lite writes every call for this camp, through OpenRouter. New repos and releases are read in depth by Gemini 3.8 Flash first.",
    voice: "Clear and explanatory. Says what the thing does in plain words a non expert gets.",
    motto: "Gemini 3.5 Flash Lite for each line. Gemini 3.8 Flash for the deep read.",
    modelName: "Gemini 3.5 Flash Lite",
    deepModelName: "Gemini 3.8 Flash",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    maker: "DeepSeek",
    camp: "oss",
    title: "scouts the tools and infra camp",
    personality: "DeepSeek V4.1 Flash writes every call for this camp, through OpenRouter. New repos and releases are read in depth by DeepSeek V4 Pro first.",
    voice: "Plain and exact, with an eye for what is finished and what is a sketch.",
    motto: "DeepSeek V4.1 Flash for each line. DeepSeek V4 Pro for the deep read.",
    modelName: "DeepSeek V4.1 Flash",
    deepModelName: "DeepSeek V4 Pro",
  },
];

export const SCOUT_BY_ID = Object.fromEntries(SCOUTS.map((s) => [s.id, s])) as Record<ScoutId, Scout>;
export const SCOUT_BY_CAMP = Object.fromEntries(SCOUTS.map((s) => [s.camp, s])) as Record<GroupKey, Scout>;
export const isScoutId = (v: unknown): v is ScoutId => typeof v === "string" && v in SCOUT_BY_ID;

export const VERDICT_LABEL: Record<Verdict, string> = { tool: "real tool", experiment: "experiment", fork: "fork", joke: "joke", docs: "docs only", unclear: "unclear" };

/** The one line every place that shows calls carries. */
export const NOT_ADVICE = "Scout calls and heat are information, not advice. They describe public GitHub activity and are never a signal to trade.";

/** A heat call, 0 to 10, as the site's heat words. */
export const callHeat = (n: number) => (n >= 8 ? "veryHigh" : n >= 6 ? "high" : n >= 4 ? "medium" : "low") as "low" | "medium" | "high" | "veryHigh";

/** "4m 05s", "2h 10m", "n/a" */
export function fmtSecs(s: number | null): string {
  if (s == null) return "n/a";
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

/** The leaderboard with nobody connected: the five scouts and no calls, marked as a sample. */
export function sampleScouts(): ScoutsView {
  const zero = { tool: 0, experiment: 0, fork: 0, joke: 0, docs: 0, unclear: 0 };
  const scouts: ScoutRecord[] = SCOUTS.map((s, i) => ({
    id: s.id,
    name: s.name,
    camp: s.camp,
    title: s.title,
    rank: i + 1,
    calls: 0,
    modelCalls: 0,
    templateCalls: 0,
    deepReads: 0,
    hotCalls: 0,
    hotCatches: 0,
    hitRate: null,
    catches: 0,
    catchesCalledHot: 0,
    medianToCallSec: null,
    timedCalls: 0,
    best: null,
    worst: null,
    verdicts: { ...zero },
    injections: 0,
    lastCallAt: null,
    sample: true,
  }));
  return { scouts, mode: "template", model: null, deepModel: null, asOf: new Date().toISOString(), sample: true };
}

/** Followed scouts in this browser (a holder's are also kept in their prefs). */
export const FOLLOW_KEY = "pushd-scouts";
