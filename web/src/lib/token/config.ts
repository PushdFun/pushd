// The site's own $PUSHD settings, from the environment. Everything here is public: addresses, links, numbers.
// The engine has its own copy of the addresses (engine/src/token/config.ts); set them on both.
//
//   PUSHD_TOKEN_ADDRESS         $PUSHD, once launched. When empty the site asks the engine (which reads the burn pot)
//   PUSHD_BUY_URL               where "Buy $PUSHD" leads once launched (https only). Empty: the token's Pons page
//   PUSHD_BURN_POT_ADDRESS      the burn pot, for the launch page (/token/launch)
//   PUSHD_SPLITTER_ADDRESS      the fee address, for the launch page's checks
//   PUSHD_TOKEN_RPC_URL         Robinhood Chain RPC for the launch page's reads (the public node when empty)
//   PUSHD_EXPLORER_URL          the explorer (Robinhood Chain's Blockscout by default)
//   PUSHD_LAUNCH_PAGE           on: /token/launch exists. Anything else: 404. Switch it off after the launch
//   PUSHD_LAUNCH_OPENING_BUY_WEI the opening buy, whole wei, digits only (10000000000000000 is 0.01 ETH)
//   PUSHD_LAUNCH_FILE           contracts/launch.json by default (the repo's own, next to web/)

export const ROBINHOOD_CHAIN_ID = 4663;
export const PUBLIC_RPC = "https://rpc.mainnet.chain.robinhood.com";
export const EXPLORER = "https://robinhoodchain.blockscout.com";
/** Chainlink ETH / USD on Robinhood Chain, 8 decimals. */
export const ETH_USD_FEED = "0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9";
/** The Pons launch factory $PUSHD launches through (contracts/lib.sh). */
export const PONS_FACTORY = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e";
/** A launched token's trade page on Pons. */
export const ponsPage = (token: string) => `https://ponsfamily.com/launchpad/${token}`;

type Env = Record<string, string | undefined>;

export const isAddress = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
export const sameAddress = (a: string | null | undefined, b: string | null | undefined) => Boolean(a && b && isAddress(a) && isAddress(b) && a.toLowerCase() === b.toLowerCase());
const addr = (v: string | undefined) => (isAddress(v?.trim()) ? v!.trim() : null);
const https = (v: string | undefined) => (/^https:\/\/\S+$/.test(v?.trim() ?? "") ? v!.trim() : null);
const rpc = (v: string | undefined) => (/^https?:\/\/\S+$/.test(v?.trim() ?? "") ? v!.trim() : null);

export type SiteTokenConfig = {
  token: string | null;
  buyUrl: string | null;
  pot: string | null;
  splitter: string | null;
  rpcUrl: string;
  explorer: string;
};

export function siteTokenConfig(env: Env = process.env): SiteTokenConfig {
  return {
    token: addr(env.PUSHD_TOKEN_ADDRESS),
    buyUrl: https(env.PUSHD_BUY_URL),
    pot: addr(env.PUSHD_BURN_POT_ADDRESS),
    splitter: addr(env.PUSHD_SPLITTER_ADDRESS),
    rpcUrl: rpc(env.PUSHD_TOKEN_RPC_URL) ?? PUBLIC_RPC,
    explorer: https(env.PUSHD_EXPLORER_URL)?.replace(/\/+$/, "") ?? EXPLORER,
  };
}
