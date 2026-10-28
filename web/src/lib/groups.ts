import type { GroupKey, Heat, Kind } from "./types";

// The five watchlist groups and every way the site names them.
export const GROUPS: Record<
  GroupKey,
  { chip: string; title: string; label: string; mid: string; short: string; slug: string; about: string }
> = {
  // the keys stay as they were (the feed, the scouts and the engine use them); each camp holds what its label says
  chain: {
    chip: "Robinhood Chain",
    title: "Robinhood Chain projects",
    label: "Robinhood Chain projects",
    mid: "Robinhood Chain",
    short: "robinhood",
    slug: "robinhood",
    about: "Token projects trading on Robinhood Chain that keep shipping code in public.",
  },
  wallets: {
    chip: "Base and EVM",
    title: "Base and EVM projects",
    label: "Base and EVM projects",
    mid: "Base and EVM",
    short: "base and evm",
    slug: "base-evm",
    about: "Token projects on Base and other EVM chains with a real, busy GitHub.",
  },
  launchpads: {
    chip: "Solana and pump.fun",
    title: "Solana and pump.fun projects",
    label: "Solana and pump.fun projects",
    mid: "Solana and pump.fun",
    short: "solana",
    slug: "solana",
    about: "Solana tokens, pump.fun launches included, whose code is public and moving.",
  },
  ai: {
    chip: "AI agents",
    title: "AI agent projects",
    label: "AI agent projects",
    mid: "AI agents",
    short: "ai agents",
    slug: "ai-agents",
    about: "AI agent coins and the tools behind them, with code that changes every week.",
  },
  oss: {
    chip: "Tools and infra",
    title: "Tools and infra",
    label: "tools and infra projects",
    mid: "tools and infra",
    short: "tools",
    slug: "tools",
    about: "Token projects that build tools, SDKs, indexers and other infrastructure.",
  },
};

export const GROUP_ORDER: GroupKey[] = ["chain", "wallets", "launchpads", "ai", "oss"];

export const KIND_LABEL: Record<Kind, string> = { repo: "new repo", push: "push", release: "release", gist: "gist" };
export const KIND_VERB: Record<Kind, string> = { repo: "created", push: "pushed", release: "released", gist: "posted" };

export const HEAT_RANK: Record<Heat, number> = { low: 1, medium: 2, high: 3, veryHigh: 4 };
export const HEAT_CLASS: Record<Heat, string> = { low: "low", medium: "medium", high: "high", veryHigh: "vhigh" };
export const HEAT_LABEL: Record<Heat, string> = { low: "low", medium: "medium", high: "high", veryHigh: "very high" };
// the bar is ten blocks: lit, then unlit
export const HEAT_BAR: Record<Heat, [number, number]> = { low: [3, 7], medium: [5, 5], high: [8, 2], veryHigh: [10, 0] };

/** A catch is a hot line: high heat and up. */
export const isCatch = (heat: Heat) => HEAT_RANK[heat] >= HEAT_RANK.high;
