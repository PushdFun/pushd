// The five scouts: one AI model per camp of the watchlist, each from another maker, run through OpenRouter. Each one reads the new lines of its camp and makes a call:
// the line, why it matters, what the repo really is (for new repos and releases) and a heat call with a reason.
//
// They describe repos. They never speak for the builders behind them, and their calls are information, not advice.
// The site draws each one from its id (web/src/components/ScoutAvatar.tsx); web/src/lib/scouts.ts keeps the same
// roster for the site (test/scouts-roster.test.ts checks the two agree).
import type { GroupKey, ScoutId, Verdict } from "../types.ts";

export type { ScoutId, Verdict };

export type Scout = {
  id: ScoutId;
  name: string;
  camp: GroupKey;
  /** one line under the name */
  title: string;
  /** a short personality, as the site shows it */
  personality: string;
  /** how it writes, as the model is told and the site shows it */
  voice: string;
  /** a line in its own voice, shown on its page (about itself, never about a builder) */
  motto: string;
  /** the maker of the model behind it, and its logo in web/public/scouts/<id>.svg */
  maker: string;
  /** the model that writes every call, and the stronger one for the deep read of new repos and releases (OpenRouter ids) */
  model: string;
  deepModel: string;
  modelName: string;
  deepModelName: string;
  /** "in, out" USD per million tokens, for the estimate before a call */
  price: [number, number];
  deepPrice: [number, number];
};

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
    model: "anthropic/claude-haiku-5.5",
    deepModel: "anthropic/claude-sonnet-5.5",
    price: [0.1, 0.5],
    deepPrice: [2, 10],
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
    model: "openai/gpt-6-luna",
    deepModel: "openai/gpt-6.1-terra",
    price: [0.1, 0.5],
    deepPrice: [1, 5],
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
    model: "x-ai/grok-4.3",
    deepModel: "x-ai/grok-4.7",
    price: [1.25, 2.5],
    deepPrice: [2, 6],
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
    model: "google/gemini-3.5-flash-lite",
    deepModel: "google/gemini-3.8-flash",
    price: [0.3, 2.5],
    deepPrice: [0.825, 4.125],
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
    model: "deepseek/deepseek-v4.1-flash",
    deepModel: "deepseek/deepseek-v4-pro-0813",
    price: [0.14, 0.42],
    deepPrice: [0.66, 1.98],
  },
];

export const SCOUT_BY_ID = new Map(SCOUTS.map((s) => [s.id, s]));
export const SCOUT_BY_CAMP = new Map<GroupKey, Scout>(SCOUTS.map((s) => [s.camp, s]));
export const scoutFor = (camp: GroupKey): Scout => SCOUT_BY_CAMP.get(camp)!;
export const isScoutId = (v: unknown): v is ScoutId => typeof v === "string" && SCOUT_BY_ID.has(v as ScoutId);

/** What a scout says a repo really is, after reading it. */
export const VERDICTS: readonly Verdict[] = ["tool", "experiment", "fork", "joke", "docs", "unclear"];

/** A heat call at or above this is a hot call. The watcher's catches start at the same score (high heat, 6). */
export const HOT_CALL = 6;
