/**
 * SERVER ONLY. The launch page's reads on Robinhood Chain, with viem, through
 * PUSHD_TOKEN_RPC_URL (else the public node). Read
 * only: nothing here signs or sends. The one call that runs the launch,
 * simulate(), is an eth_call: the node runs it from the launcher wallet and
 * throws the result away. It needs no key.
 */
import { createPublicClient, http, type Address, type Hex } from "viem";
import { ERC20_ABI, FEED_ABI, ROBINHOOD_CHAIN } from "./chain";
import { ETH_USD_FEED } from "./config";
import type { LaunchReader } from "./launch";
import { hex, LAUNCH_POT_ABI } from "./launch-plan";

const SPLITTER_READS = [
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "burnPot", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "escrow", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "ownerBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
  { type: "function", name: "burnBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
] as const;

const FACTORY_READS = [
  { type: "function", name: "launchFee", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "previewLaunchEconomics", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "address" }], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "poolManager", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "memeHook", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "feeEscrow", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  {
    type: "function",
    name: "getLaunchConfig",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "supply", type: "uint256" },
          { name: "curveFeeBps", type: "uint256" },
          { name: "phantomQuote", type: "uint256" },
          { name: "graduationThreshold", type: "uint256" },
          { name: "poolFee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "enabled", type: "bool" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "getLaunchedToken",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "token", type: "address" },
          { name: "curve", type: "address" },
          { name: "deployer", type: "address" },
          { name: "creatorFeeRecipient", type: "address" },
          { name: "pairToken", type: "address" },
          { name: "graduationThreshold", type: "uint256" },
          { name: "poolFee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "creatorTaxBps", type: "uint16" },
          { name: "buybackEnabled", type: "bool" },
          { name: "phase", type: "uint8" },
          { name: "sweptQuote", type: "uint256" },
          { name: "sweptTokens", type: "uint256" },
          { name: "sweptAt", type: "uint256" },
          { name: "exists", type: "bool" },
        ],
      },
    ],
  },
] as const;

/** The revert data somewhere in a viem error's chain of causes. */
function revertData(err: unknown): Hex | null {
  let e: unknown = err;
  for (let i = 0; i < 10 && e; i++) {
    const d = (e as { data?: unknown }).data;
    if (typeof d === "string" && /^0x[0-9a-fA-F]*$/.test(d)) return d as Hex;
    if (d && typeof d === "object" && typeof (d as { data?: unknown }).data === "string") return (d as { data: Hex }).data;
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}

export function viemLaunchReader(rpcUrl: string): LaunchReader {
  const c = createPublicClient({ chain: ROBINHOOD_CHAIN, transport: http(rpcUrl, { timeout: 15_000, retryCount: 1 }) });
  const read = <T>(address: string, abi: readonly unknown[], functionName: string, args: readonly unknown[] = []) =>
    c.readContract({ address: address as Address, abi: abi as never, functionName: functionName as never, args: args as never }) as Promise<T>;
  return {
    chainId: () => c.getChainId(),
    hasCode: async (a) => {
      const code = await c.getCode({ address: a as Address });
      return Boolean(code && code !== "0x");
    },
    async pot(pot) {
      const [launcher, splitter, factory, poolManager, hook, token, openingBuyEth, openingBuyTokens, tax] = await Promise.all([
        read<string>(pot, LAUNCH_POT_ABI, "launcher"),
        read<string>(pot, LAUNCH_POT_ABI, "splitter"),
        read<string>(pot, LAUNCH_POT_ABI, "factory"),
        read<string>(pot, LAUNCH_POT_ABI, "poolManager"),
        read<string>(pot, LAUNCH_POT_ABI, "hook"),
        read<string>(pot, LAUNCH_POT_ABI, "token"),
        read<bigint>(pot, LAUNCH_POT_ABI, "openingBuyEth"),
        read<bigint>(pot, LAUNCH_POT_ABI, "openingBuyTokens"),
        read<number>(pot, LAUNCH_POT_ABI, "CREATOR_TAX_BPS"),
      ]);
      return { launcher, splitter, factory, poolManager, hook, token, openingBuyEth, openingBuyTokens, creatorTaxBps: Number(tax) };
    },
    async splitter(s) {
      const [owner, burnPot, escrow, ownerBps, burnBps] = await Promise.all([
        read<string>(s, SPLITTER_READS, "owner"),
        read<string>(s, SPLITTER_READS, "burnPot"),
        read<string>(s, SPLITTER_READS, "escrow"),
        read<number>(s, SPLITTER_READS, "ownerBps"),
        read<number>(s, SPLITTER_READS, "burnBps"),
      ]);
      return { owner, burnPot, escrow, ownerBps: Number(ownerBps), burnBps: Number(burnBps) };
    },
    async factory(f) {
      const [launchFee, economics, poolManager, memeHook, feeEscrow, config] = await Promise.all([
        read<bigint>(f, FACTORY_READS, "launchFee"),
        read<Hex>(f, FACTORY_READS, "previewLaunchEconomics", [BigInt(0), "0x0000000000000000000000000000000000000000"]),
        read<string>(f, FACTORY_READS, "poolManager"),
        read<string>(f, FACTORY_READS, "memeHook"),
        read<string>(f, FACTORY_READS, "feeEscrow"),
        read<{ graduationThreshold: bigint }>(f, FACTORY_READS, "getLaunchConfig", [BigInt(0)]),
      ]);
      return { launchFee, economics, poolManager, memeHook, feeEscrow, graduationThreshold: config.graduationThreshold };
    },
    balance: (a) => c.getBalance({ address: a as Address }),
    async nonces(a) {
      const [latest, pending] = await Promise.all([c.getTransactionCount({ address: a as Address, blockTag: "latest" }), c.getTransactionCount({ address: a as Address, blockTag: "pending" })]);
      return { latest, pending };
    },
    gasPrice: () => c.getGasPrice(),
    async simulate(tx) {
      try {
        const returned = (await c.request({ method: "eth_call", params: [{ from: tx.from as Address, to: tx.to as Address, data: tx.data, value: hex(tx.value) }, "latest"] })) as Hex;
        return { ok: true, returned };
      } catch (err) {
        const data = revertData(err);
        const msg = err instanceof Error ? ((err as { shortMessage?: string }).shortMessage ?? err.message) : String(err);
        return { ok: false, revertData: data, message: `The node refused it: ${msg.replace(/https?:\/\/\S+/g, "[node]").slice(0, 200)}` };
      }
    },
    estimateGas: (tx) => c.estimateGas({ account: tx.from as Address, to: tx.to as Address, data: tx.data, value: tx.value }),
    async ethUsd() {
      // Chainlink's ETH / USD with 8 decimals; null when it is older than 26 hours or not above zero
      const [round, decimals] = await Promise.all([read<readonly [bigint, bigint, bigint, bigint, bigint]>(ETH_USD_FEED, FEED_ABI, "latestRoundData"), read<number>(ETH_USD_FEED, FEED_ABI, "decimals")]);
      const answer = round[1];
      if (answer <= BigInt(0) || Math.floor(Date.now() / 1000) - Number(round[3]) > 26 * 3600) return null;
      const d = Number(decimals);
      return d === 8 ? answer : d > 8 ? answer / BigInt(10) ** BigInt(d - 8) : answer * BigInt(10) ** BigInt(8 - d);
    },
    async logo(url) {
      const res = await fetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(20_000), cache: "no-store" });
      await res.body?.cancel().catch(() => undefined);
      return { status: res.status, contentType: res.headers.get("content-type") ?? "" };
    },
    async receipt(hash) {
      const rec = await c.getTransactionReceipt({ hash: hash as Hex }).catch(() => null);
      if (!rec) return null;
      return { status: rec.status, from: rec.from, to: rec.to ?? null, block: Number(rec.blockNumber) };
    },
    async knowsTx(hash) {
      const tx = await c.getTransaction({ hash: hash as Hex }).catch(() => null);
      return tx !== null;
    },
    tokenBalance: (token, wallet) => read<bigint>(token, ERC20_ABI, "balanceOf", [wallet]),
    async launched(f, token) {
      const i = await read<{ exists: boolean; deployer: string; creatorFeeRecipient: string; creatorTaxBps: number; pairToken: string; buybackEnabled: boolean }>(f, FACTORY_READS, "getLaunchedToken", [token]);
      return { exists: i.exists, deployer: i.deployer, creatorFeeRecipient: i.creatorFeeRecipient, creatorTaxBps: Number(i.creatorTaxBps), pairToken: i.pairToken, buybackEnabled: i.buybackEnabled };
    },
  };
}
