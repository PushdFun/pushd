// Which camp a token project belongs to, and which repos and accounts are not projects at all (bots, forks, mirrors,
// empty templates, tutorial farms, trading-bot spam). Plain rules over the token's chain, its CoinGecko categories,
// and the words in its repos' names, descriptions and topics.
import type { GroupKey } from "../types.ts";

const AI = /\b(ai|a\.i\.|ai[- ]agents?|agentic|llms?|gpt|mcp|inference|machine[- ]learning|eliza|virtuals|autonomous agents?|chatbot|model context)\b/i;
// CoinGecko's category names and ids alike ("AI Agents", "ai-agents")
const AI_CATS = /^(ai[- ]agents?|ai[- ]framework|ai[- ]meme(-coins)?|ai[- ]agent[- ]launchpad|artificial[- ]intelligence|virtuals[- ]protocol[- ]ecosystem|ai[- ]applications)/i;
const INFRA = /\b(sdk|indexer|oracle|rpc|explorer|bridge|wallet|infra|infrastructure|toolkit|tooling|library|cli|api|protocol|dex|amm|launchpad|aggregator|zk|zero.knowledge|rollup|validator|node|smart contracts?|framework|perps?|lending|staking)\b/i;
const INFRA_CATS = /(infrastructure|oracle|bridge|wallets?|decentralized exchange|dex|launchpad|lending|derivatives|perpetuals|zero knowledge|layer 2|developer tools|data|analytics|liquid staking)/i;
const MEME_CATS = /(meme|pump\.fun|pump fun|pump-fun)/i;

/** The camp: AI agents first, then tools and infra, then by the chain the token trades on. */
export function campOf(o: { chain: string | null; categories: string[]; text: string }): GroupKey {
  const cats = o.categories.join(" | ");
  if (o.categories.some((c) => AI_CATS.test(c)) || AI.test(o.text)) return "ai";
  const memeish = MEME_CATS.test(cats);
  if (!memeish && (o.categories.some((c) => INFRA_CATS.test(c)) || INFRA.test(o.text))) return "oss";
  if (o.chain === "robinhood") return "chain";
  if (o.chain === "solana") return "launchpads";
  if (o.chain) return "wallets";
  return "oss";
}

/** Accounts that are tools of GitHub or of a service, not people or projects. */
export const isBot = (login: string) => /\[bot\]$|-bot$|^dependabot|^renovate|^github-actions|^actions-user$/i.test(login);

const TUTORIAL = /\b(tutorial|tutorials|course|homework|assignment|bootcamp|exercises?|learning|learn-|100-days|cheat-?sheet|interview|leetcode|awesome-)/i;
const SPAM = /\b(sniper|snipe|bundler|volume[- ]?bot|copy[- ]?trad(e|ing)|mev[- ]?bot|pump[- ]?bot|drainer|airdrop[- ]?farm|wallet[- ]?drain|rug|honeypot|token[- ]?generator)\b/i;
const MIRROR = /\b(mirror|mirrored|read-only copy|unofficial copy)\b/i;

/** Why a repo is not a project's own work, or null when it is. */
export function repoNoise(r: { name: string; description: string | null; fork: boolean; archived?: boolean; size?: number; template?: boolean }): string | null {
  if (r.fork) return "a fork";
  if (r.archived) return "archived";
  if (r.template) return "a template";
  if (r.size === 0) return "empty";
  const text = `${r.name} ${r.description ?? ""}`;
  if (MIRROR.test(text)) return "a mirror";
  if (SPAM.test(text.replace(/[-_]/g, " ")) || SPAM.test(text)) return "a trading bot or spam";
  if (TUTORIAL.test(text)) return "a tutorial or course";
  return null;
}

/** A GitHub link to owner (and repo), from any URL a token lists. Null for links that are not an owner's page. */
export function githubOwner(url: string): { owner: string; repo: string | null } | null {
  const m = /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))(?:\/([A-Za-z0-9._-]{1,100}))?(?:[/?#]|$)/i.exec(url.trim());
  if (!m) return null;
  const owner = m[1];
  const reserved = /^(orgs|sponsors|features|topics|collections|marketplace|about|pricing|login|signup|settings|apps|search|explore|trending|enterprise|security|readme|site|contact|customer-stories|team|users|notifications|issues|pulls|codespaces|resources|solutions)$/i;
  if (reserved.test(owner)) return null;
  const repo = m[2] && !/\.git$/.test(m[2]) ? m[2] : m[2]?.replace(/\.git$/, "") ?? null;
  return { owner, repo: repo && !/^(repositories|projects|packages|people|stars|followers|following)$/i.test(repo) ? repo : null };
}

/** Every GitHub link in a page's HTML (a token's website), owners only, at most a few. */
export function githubLinksIn(html: string, max = 5): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/https?:\/\/(?:www\.)?github\.com\/[A-Za-z0-9-]{1,39}(?:\/[A-Za-z0-9._-]{1,100})?/gi)) {
    const g = githubOwner(m[0]);
    if (g && !out.includes(m[0])) out.push(m[0]);
    if (out.length >= max) break;
  }
  return out;
}

/** Token addresses in a piece of text: Solana mints (base58, 32 to 44 long) and EVM addresses. */
export function addressesIn(text: string): { kind: "solana" | "evm"; address: string }[] {
  const out: { kind: "solana" | "evm"; address: string }[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/\b0x[a-fA-F0-9]{40}\b/g)) {
    if (seen.has(m[0].toLowerCase())) continue;
    seen.add(m[0].toLowerCase());
    out.push({ kind: "evm", address: m[0] });
  }
  for (const m of text.matchAll(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g)) {
    // a mint has digits and both cases; plain words of that length do not
    if (!/[0-9]/.test(m[0]) || !/[a-z]/.test(m[0]) || !/[A-Z]/.test(m[0])) continue;
    if (seen.has(m[0])) continue;
    seen.add(m[0]);
    out.push({ kind: "solana", address: m[0] });
  }
  return out;
}
