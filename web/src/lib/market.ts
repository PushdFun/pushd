import type { RankToken } from "./types";

// A project's token as the site shows it: the chain's short name, the symbol with its $, and the market numbers as they
// were read (they move all the time; PUSHD shows them as information, never as advice).

const CHAINS: Record<string, string> = {
  solana: "Solana",
  base: "Base",
  robinhood: "Robinhood Chain",
  ethereum: "Ethereum",
  arbitrum: "Arbitrum",
  bsc: "BNB Chain",
};

export const chainLabel = (chain: string) => CHAINS[chain] ?? chain.charAt(0).toUpperCase() + chain.slice(1);

/** The chain's name in a tight row: "Robinhood", "BNB". */
export const chainShort = (chain: string) => ({ robinhood: "Robinhood", bsc: "BNB" })[chain] ?? chainLabel(chain);

/** "$ELIZA", or null when the token has no symbol. */
export const symbolOf = (t: Pick<RankToken, "symbol"> | null | undefined) => (t?.symbol ? `$${t.symbol.replace(/^\$/, "")}` : null);

/** "$1.2M", "$84K", "$900". */
export function usd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "n/a";
  const a = Math.abs(n);
  if (a >= 1e9) return `$${(n / 1e9).toFixed(a >= 1e10 ? 0 : 1)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(a >= 1e4 ? 0 : 1)}K`;
  return `$${Math.round(n)}`;
}

/** "trading for 2 years", "for 45 days". */
export function pairAge(days: number | null | undefined): string {
  if (days == null) return "n/a";
  if (days >= 730) return `${Math.floor(days / 365)} years`;
  if (days >= 365) return "1 year";
  if (days >= 60) return `${Math.floor(days / 30)} months`;
  return `${days} day${days === 1 ? "" : "s"}`;
}

/** A short address for a label: 4LLw...pump. */
export const shortAddress = (a: string) => (a.length > 14 ? `${a.slice(0, 4)}...${a.slice(-4)}` : a);
