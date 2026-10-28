/**
 * In the browser: finding a wallet, and the way in on a phone.
 * No wallet library: an injected wallet is asked over the standard EIP-1193
 * request. A phone browser has no wallet inside it, so there the button
 * opens this same page inside MetaMask's own browser, where one is, with the
 * whole path, query and anchor carried over and `link=wallet` added so the
 * step starts again there. A desktop with no wallet is sent to MetaMask's
 * download page. Everything here is read at the moment of the tap, never
 * while rendering.
 */

export type Eip1193 = { request(args: { method: string; params?: unknown[] }): Promise<unknown> };

export function injectedWallet(): Eip1193 | null {
  const eth = (window as unknown as { ethereum?: Eip1193 }).ethereum;
  return eth && typeof eth.request === "function" ? eth : null;
}

/** A phone: both a coarse pointer and a phone's user agent, so a touchscreen laptop is not one. */
export function onPhone(): boolean {
  const ua = navigator.userAgent;
  const phoneUa = /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
  const coarse = Boolean(window.matchMedia?.("(pointer: coarse)").matches);
  return phoneUa && coarse;
}

/** This page inside MetaMask's in-app browser, with the step to start again there. */
export function metamaskLink(step = "wallet"): string {
  const u = new URL(window.location.href);
  u.searchParams.set("link", step);
  return `https://metamask.app.link/dapp/${u.host}${u.pathname}${u.search}${u.hash}`;
}

export const METAMASK_DOWNLOAD = "https://metamask.io/download/";

/** personal_sign takes the message as hex-encoded UTF-8. */
export function utf8Hex(text: string): string {
  return `0x${Array.from(new TextEncoder().encode(text), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** A wallet's refusal in plain words. */
export function walletError(err: unknown, what: "connect" | "sign" | "send"): { message: string; cancelled: boolean } {
  const code = (err as { code?: number })?.code;
  if (code === 4001) return { message: what === "connect" ? "You closed the wallet before it connected. Nothing was signed." : what === "sign" ? "You declined in the wallet. Nothing was signed." : "You declined in the wallet. Nothing was sent.", cancelled: true };
  if (code === -32002) return { message: "Your wallet is already asking. Open it to answer.", cancelled: false };
  return { message: what === "connect" ? "The wallet did not connect. Open it and try again." : what === "sign" ? "The wallet did not sign. Try again." : "The wallet did not send it. Nothing was paid; try again.", cancelled: false };
}

export const ROBINHOOD_CHAIN_HEX = "0x1237"; // 4663
const ADD_CHAIN = {
  chainId: ROBINHOOD_CHAIN_HEX,
  chainName: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: ["https://rpc.mainnet.chain.robinhood.com"],
  blockExplorerUrls: ["https://robinhoodchain.blockscout.com"],
};

/** Moves the wallet to Robinhood Chain, adding it when the wallet does not know it. */
export async function toRobinhoodChain(eth: Eip1193): Promise<void> {
  const id = String(await eth.request({ method: "eth_chainId" })).toLowerCase();
  if (id === ROBINHOOD_CHAIN_HEX) return;
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: ROBINHOOD_CHAIN_HEX }] });
  } catch (err) {
    // MetaMask on a phone wraps "unknown chain" as data.originalError.code.
    const e = err as { code?: number; data?: { originalError?: { code?: number } } };
    if (e?.code !== 4902 && e?.data?.originalError?.code !== 4902) throw err;
    await eth.request({ method: "wallet_addEthereumChain", params: [ADD_CHAIN] });
  }
}
