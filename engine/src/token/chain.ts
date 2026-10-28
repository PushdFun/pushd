// Reading $PUSHD's contracts and the token on Robinhood Chain, through the configured RPC with viem. Read only:
// nothing here signs or sends. The keeper's sending side is keeper-chain.ts.
//
// Within the node's limits: logs in spans of 100,000 blocks, halved when the node refuses a span as too big; balances
// many at a time through Multicall3; no read of an old block's state, which the node prunes.
//
// Tests hand in their own TokenReader; no test calls a chain.
import { createPublicClient, http, parseAbiItem, type Address } from "viem";
import { ROBINHOOD_CHAIN_ID } from "./config.ts";

export const ZERO = 0n;
const ZERO_ADDRESS = /^0x0{40}$/i;

export const POT_ABI = [
  { type: "function", name: "token", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "splitter", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "burnCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "totalTokensBurned", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "totalEthBurned", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "lastBurnAt", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "startedAt", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "preview", stateMutability: "view", inputs: [], outputs: [{ name: "amount", type: "uint256" }, { name: "nextAt", type: "uint256" }, { name: "ready", type: "bool" }, { name: "tokens", type: "uint256" }] },
  { type: "function", name: "burn", stateMutability: "nonpayable", inputs: [{ name: "minTokensOut", type: "uint256" }], outputs: [{ name: "ethIn", type: "uint256" }, { name: "tokensBurned", type: "uint256" }] },
] as const;

export const SPLITTER_ABI = [{ type: "function", name: "sweep", stateMutability: "nonpayable", inputs: [], outputs: [{ name: "amount", type: "uint256" }] }] as const;

export const ERC20_ABI = [
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "who", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

export const BURNED_EVENT = parseAbiItem("event Burned(uint256 indexed n, address indexed caller, uint256 ethIn, uint256 tokensBurned, bool viaCurve)");

export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
export const ROBINHOOD_CHAIN = {
  id: ROBINHOOD_CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  contracts: { multicall3: { address: MULTICALL3 as Address } },
} as const;

/** Node addresses, keys and anything that looks like one, out of a message before it is logged or shown. */
export function scrub(msg: string): string {
  return msg
    .replace(/https?:\/\/\S+/g, "[node]")
    .replace(/0x[0-9a-fA-F]{64}/g, (m) => `${m.slice(0, 10)}...`)
    .slice(0, 300);
}

export type PotState = {
  /** Null before the launch. */
  token: string | null;
  burnCount: number;
  totalTokens: bigint;
  totalEth: bigint;
  /** Milliseconds; 0 when it has not happened. */
  lastBurnAt: number;
  startedAt: number;
  /** From preview(): the ETH the next burn would spend, the $PUSHD held for it, when, and whether burn() goes through now. */
  waitingEth: bigint;
  waitingTokens: bigint;
  nextAt: number;
  ready: boolean;
};

export type BurnLog = { n: number; tx: string; block: number; tokens: bigint; eth: bigint };

/** Everything the engine reads from the chain. The viem one below; tests give their own. */
export interface TokenReader {
  chainId(): Promise<number>;
  head(): Promise<number>;
  blockTime(block: number): Promise<number>;
  pot(pot: string): Promise<PotState>;
  supply(token: string): Promise<bigint>;
  /** Burned events in [from, to]. Throws the node's own error when the span holds too many. */
  burnLogs(pot: string, from: number, to: number): Promise<BurnLog[]>;
  /** Balances at the head; null for a wallet the node did not answer for. */
  balances(token: string, wallets: string[]): Promise<(bigint | null)[]>;
}

const SPAN = 100_000;

/** A reader on one RPC URL: 10 seconds a call, one retry. */
export function viemReader(rpcUrl: string): TokenReader {
  const c = createPublicClient({ chain: ROBINHOOD_CHAIN, transport: http(rpcUrl, { timeout: 10_000, retryCount: 1 }) });
  const read = <T>(address: string, abi: readonly unknown[], functionName: string, args: readonly unknown[] = []) =>
    c.readContract({ address: address as Address, abi: abi as never, functionName: functionName as never, args: args as never }) as Promise<T>;
  return {
    chainId: () => c.getChainId(),
    head: async () => Number(await c.getBlockNumber()),
    blockTime: async (n) => Number((await c.getBlock({ blockNumber: BigInt(n) })).timestamp) * 1000,
    async pot(pot) {
      const [token, n, tokens, eth, last, started, preview] = await Promise.all([
        read<string>(pot, POT_ABI, "token"),
        read<bigint>(pot, POT_ABI, "burnCount"),
        read<bigint>(pot, POT_ABI, "totalTokensBurned"),
        read<bigint>(pot, POT_ABI, "totalEthBurned"),
        read<bigint>(pot, POT_ABI, "lastBurnAt"),
        read<bigint>(pot, POT_ABI, "startedAt"),
        read<readonly [bigint, bigint, boolean, bigint]>(pot, POT_ABI, "preview"),
      ]);
      return {
        token: ZERO_ADDRESS.test(token) ? null : token,
        burnCount: Number(n),
        totalTokens: tokens,
        totalEth: eth,
        lastBurnAt: Number(last) * 1000,
        startedAt: Number(started) * 1000,
        waitingEth: preview[0],
        nextAt: Number(preview[1]) * 1000,
        ready: preview[2],
        waitingTokens: preview[3],
      };
    },
    supply: (token) => read<bigint>(token, ERC20_ABI, "totalSupply"),
    async burnLogs(pot, from, to) {
      const logs = await c.getLogs({ address: pot as Address, event: BURNED_EVENT, fromBlock: BigInt(from), toBlock: BigInt(to) });
      return logs.map((l) => ({ n: Number(l.args.n), tx: l.transactionHash as string, block: Number(l.blockNumber), tokens: l.args.tokensBurned!, eth: l.args.ethIn! }));
    },
    async balances(token, wallets) {
      const out: (bigint | null)[] = [];
      for (let i = 0; i < wallets.length; i += 100) {
        const part = wallets.slice(i, i + 100);
        const res = await c.multicall({
          contracts: part.map((w) => ({ address: token as Address, abi: ERC20_ABI, functionName: "balanceOf" as const, args: [w as Address] as const })),
          allowFailure: true,
        });
        for (const r of res) out.push(r.status === "success" ? (r.result as bigint) : null);
      }
      return out;
    },
  };
}

/** Whether a node's refusal means "too many logs in that span": then the span is halved. */
export const tooManyLogs = (err: unknown) => /exceeds limit|too many|query returned more than|log query timed out|block range/i.test(err instanceof Error ? err.message : String(err));

/**
 * Burned events from `from` up to `to`, in spans of at most 100,000 blocks, each halved when the node refuses it as
 * too big.
 */
export async function scanBurns(reader: TokenReader, pot: string, from: number, to: number, opts: { maxSpans?: number } = {}): Promise<{ scannedTo: number; logs: BurnLog[] }> {
  const logs: BurnLog[] = [];
  let at = from;
  let spans = 0;
  let span = SPAN;
  let scannedTo = from - 1;
  while (at <= to && spans < (opts.maxSpans ?? 20)) {
    const end = Math.min(to, at + span - 1);
    let part: BurnLog[];
    try {
      part = await reader.burnLogs(pot, at, end);
    } catch (err) {
      if (tooManyLogs(err) && span > 1) {
        span = Math.max(1, Math.floor(span / 2));
        continue;
      }
      throw err;
    }
    logs.push(...part);
    scannedTo = end;
    at = end + 1;
    spans++;
    span = SPAN;
  }
  return { scannedTo, logs };
}
