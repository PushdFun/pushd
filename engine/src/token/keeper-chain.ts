// The keeper's side of the chain, with viem. The one place PUSHD_KEEPER_KEY is read: it is turned into a viem account
// at once and never kept elsewhere, logged, shown or put in an error (every message that leaves goes through scrub()).
//
// It can send exactly two calls, both with no value: sweep() on the fee address and burn(0) on the burn pot. There is
// no transfer, no approval and no way to pass a value or another target through it.
import { createPublicClient, createWalletClient, encodeFunctionData, http, keccak256, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { POT_ABI, ROBINHOOD_CHAIN, SPLITTER_ABI, scrub, viemReader } from "./chain.ts";
import type { TokenConfig } from "./config.ts";
import { NotSent, type KeeperChain } from "./keeper.ts";

/** The keeper wallet's chain, or null when the key is not set or not a key. */
export function keeperChainFromEnv(c: TokenConfig, env: Record<string, string | undefined> = process.env): KeeperChain | null {
  const key = env.PUSHD_KEEPER_KEY?.trim() ?? "";
  if (!/^0x[0-9a-fA-F]{64}$/.test(key) || !c.pot || !c.splitter) return null;
  return viemKeeperChain(key as Hex, c.pot, c.splitter, c.keeper.rpcUrl);
}

function viemKeeperChain(key: Hex, pot: string, splitter: string, rpcUrl: string): KeeperChain {
  const account = privateKeyToAccount(key);
  const transport = http(rpcUrl, { timeout: 15_000, retryCount: 1 });
  const pub = createPublicClient({ chain: ROBINHOOD_CHAIN, transport });
  const wallet = createWalletClient({ chain: ROBINHOOD_CHAIN, transport, account });
  const reader = viemReader(rpcUrl);
  const potAddr = pot as Address;
  const splitAddr = splitter as Address;

  return {
    account: account.address,
    chainId: () => pub.getChainId(),
    // What a transaction pays here: the block's base fee. Robinhood Chain (an Arbitrum chain) takes no tip.
    gasPrice: async () => (await pub.getBlock()).baseFeePerGas ?? pub.getGasPrice(),
    balance: () => pub.getBalance({ address: account.address }),
    sweepWouldSplit: async () => (await pub.simulateContract({ address: splitAddr, abi: SPLITTER_ABI, functionName: "sweep", account })).result,
    estimateSweep: () => pub.estimateContractGas({ address: splitAddr, abi: SPLITTER_ABI, functionName: "sweep", account }),
    pot: () => reader.pot(pot),
    estimateBurn: () => pub.estimateContractGas({ address: potAddr, abi: POT_ABI, functionName: "burn", args: [0n], account }),
    async send(kind, gas, maxFeePerGas, before) {
      const to = kind === "sweep" ? splitAddr : potAddr;
      const data = kind === "sweep" ? encodeFunctionData({ abi: SPLITTER_ABI, functionName: "sweep" }) : encodeFunctionData({ abi: POT_ABI, functionName: "burn", args: [0n] });
      let raw: Hex;
      try {
        const req = await wallet.prepareTransactionRequest({ account, chain: ROBINHOOD_CHAIN, to, data, value: 0n, gas, maxFeePerGas, maxPriorityFeePerGas: 0n });
        raw = await wallet.signTransaction(req as never);
      } catch (err) {
        throw new NotSent(scrub(String((err as Error)?.message ?? err)));
      }
      const tx = keccak256(raw);
      await before(tx);
      try {
        await wallet.sendRawTransaction({ serializedTransaction: raw });
      } catch (err) {
        const msg = String((err as Error)?.message ?? err);
        // The node answered no: not broadcast. A timeout or a dropped connection may have sent it; the receipt decides.
        if (/timeout|timed out|fetch failed|socket|ECONN|network/i.test(msg)) return tx;
        throw new NotSent(scrub(msg));
      }
      return tx;
    },
    async receipt(tx) {
      const r = await pub.getTransactionReceipt({ hash: tx as Hex }).catch(() => null);
      return r ? { ok: r.status === "success", gas: Number(r.gasUsed), block: Number(r.blockNumber) } : null;
    },
  };
}
