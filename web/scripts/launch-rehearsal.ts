/**
 * The $PUSHD launch, rehearsed on a local fork of Robinhood Chain with the site's and the engine's own pieces.
 * scripts/launch-rehearsal.sh (at the repo root) starts the fork, deploys the burn pot and the splitter with
 * contracts/token-deploy.sh, starts the engine against the fork, and calls this in steps:
 *
 *   tsx scripts/launch-rehearsal.ts before    every refusal the launch page makes, and its call against the forge script's
 *   tsx scripts/launch-rehearsal.ts launch    the page's server builds the call; the launch wallet sends exactly that,
 *                                             impersonated on the fork (the launcher pressing the button)
 *   tsx scripts/launch-rehearsal.ts after     the token, the opening buy, the tax, a buy and a sell, then the engine's
 *                                             keeper (npm run keeper, a throwaway key): a sweep, and a burn that lowers
 *                                             totalSupply by exactly what it burned
 *   tsx scripts/launch-rehearsal.ts holders   holder sign-in through the engine: a wallet holding $PUSHD gets the live
 *                                             feed, one without is refused
 *
 * It reads the site's settings (PUSHD_TOKEN_RPC_URL, PUSHD_BURN_POT_ADDRESS, PUSHD_SPLITTER_ADDRESS,
 * PUSHD_LAUNCH_OPENING_BUY_WEI, PUSHD_LAUNCH_FILE) plus FORK_LAUNCHER, FORK_ENGINE, FORK_STATE and two throwaway fork
 * keys (FORK_KEEPER_KEY, FORK_HOLDER_KEY) made by the shell script for this run. It refuses any node that is not a local
 * fork. No key is printed.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createTestClient, createWalletClient, decodeEventLog, encodeFunctionData, http, parseAbi, parseEther, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ROBINHOOD_CHAIN } from "../src/lib/token/chain";
import { launchOutcome, launchStatus, prepareLaunch } from "../src/lib/token/launch";
import { decodeRevert } from "../src/lib/token/launch-plan";
import { launchDeps, LAUNCH_FILE } from "../src/lib/token/launch-server";

const RPC = process.env.PUSHD_TOKEN_RPC_URL ?? "";
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(RPC)) throw new Error("PUSHD_TOKEN_RPC_URL must be the local fork, http://127.0.0.1:<port>");
const POT = process.env.PUSHD_BURN_POT_ADDRESS as Address;
const SPLITTER = process.env.PUSHD_SPLITTER_ADDRESS as Address;
const LAUNCHER = process.env.FORK_LAUNCHER as Address;
const BUY = BigInt(process.env.PUSHD_LAUNCH_OPENING_BUY_WEI ?? "0");
const STATE = process.env.FORK_STATE ?? "";
const ENGINE = process.env.FORK_ENGINE ?? "";
const ROOT = join(process.cwd(), "..");
// Throwaway wallets on the fork only, impersonated: nobody holds a key to them.
const STRANGER = "0x5ec0000000000000000000000000000000057a9e" as Address;
const TRADER = "0x7ad3000000000000000000000000000000007ad3" as Address;
const FACTORY = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e" as Address;
const ZERO = "0x0000000000000000000000000000000000000000";

const chain = { ...ROBINHOOD_CHAIN, rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC) });
const test = createTestClient({ chain, mode: "anvil", transport: http(RPC) });
const wallet = createWalletClient({ chain, transport: http(RPC) });

const POT_ABI = parseAbi([
  "function token() view returns (address)",
  "function launcher() view returns (address)",
  "function openingBuyEth() view returns (uint256)",
  "function openingBuyTokens() view returns (uint256)",
  "function burnCount() view returns (uint256)",
  "function totalTokensBurned() view returns (uint256)",
  "function preview() view returns (uint256 amount, uint256 nextAt, bool ready, uint256 tokens)",
  "event Burned(uint256 indexed n, address indexed caller, uint256 ethIn, uint256 tokensBurned, bool viaCurve)",
]);
const SPLITTER_ABI = parseAbi([
  "function owner() view returns (address)",
  "function ownerBps() view returns (uint16)",
  "function burnBps() view returns (uint16)",
  "event Split(uint256 amount, uint256 toOwner, uint256 toBurn, bool ownerPushed, bool burnPushed)",
]);
const TOKEN_ABI = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
]);
const CURVE_ABI = parseAbi([
  "function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256)",
  "function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256)",
  "event CurveBuy(address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 tax)",
  "event CurveSell(address indexed seller, address indexed recipient, uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 tax)",
]);
const FACTORY_ABI = parseAbi([
  "struct LaunchedToken { address token; address curve; address deployer; address creatorFeeRecipient; address pairToken; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; uint16 creatorTaxBps; bool buybackEnabled; uint8 phase; uint256 sweptQuote; uint256 sweptTokens; uint256 sweptAt; bool exists; }",
  "function getLaunchedToken(address token) view returns (LaunchedToken)",
]);

let failures = 0;
function ok(cond: boolean, what: string, detail = "") {
  console.log(`  ${cond ? "OK  " : "FAIL"} ${what}${detail ? `: ${detail}` : ""}`);
  if (!cond) failures++;
}
const units = (wei: bigint) => {
  const s = wei.toString().padStart(19, "0");
  return `${s.slice(0, -18)}.${s.slice(-18)}`.replace(/\.?0+$/, "") || "0";
};
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const state = () => JSON.parse(readFileSync(STATE, "utf8")) as Record<string, unknown>;
const save = (patch: Record<string, unknown>) => writeFileSync(STATE, JSON.stringify({ ...state(), ...patch }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));

/** Sends as `from` on the fork with no key: the fork answers for an impersonated wallet. */
async function sendAs(from: Address, tx: { to: Address; data?: Hex; value?: bigint; gas?: bigint }) {
  await test.impersonateAccount({ address: from });
  try {
    const hash = await wallet.sendTransaction({ account: from, chain, to: tx.to, data: tx.data, value: tx.value ?? 0n, gas: tx.gas });
    const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
    return { hash, receipt };
  } finally {
    await test.stopImpersonatingAccount({ address: from });
  }
}
function encode(abi: readonly unknown[], functionName: string, args: readonly unknown[]): Hex {
  return (encodeFunctionData as (a: unknown) => Hex)({ abi, functionName, args });
}
function tryDecode(abi: readonly unknown[], log: { data: Hex; topics: [Hex, ...Hex[]] | [] }) {
  try {
    return decodeEventLog({ abi: abi as never, data: log.data, topics: log.topics }) as unknown as { eventName: string; args: Record<string, unknown> };
  } catch {
    return null;
  }
}

async function before() {
  console.log("== The launch page's checks, before the launch");
  writeFileSync(STATE, "{}");
  const chainId = await pub.getChainId();
  ok(chainId === 4663, "the fork answers as Robinhood Chain", String(chainId));
  ok(same(await pub.readContract({ address: POT, abi: POT_ABI, functionName: "launcher" }), LAUNCHER), "the burn pot's launcher is the launch wallet", LAUNCHER);

  await test.setBalance({ address: LAUNCHER, value: parseEther("0.001") });
  const short = await prepareLaunch(launchDeps(), LAUNCHER);
  ok(!short.ok && short.kind === "short" && BigInt(short.missingWei ?? "0") > 0n, "a launch wallet without enough ETH is refused, with what is missing", !short.ok ? `${short.problem} (${units(BigInt(short.missingWei ?? "0"))} ETH)` : "");

  await test.setBalance({ address: LAUNCHER, value: parseEther("1") });
  await test.setBalance({ address: STRANGER, value: parseEther("1") });
  const status = await launchStatus(launchDeps());
  ok(status.kind === "ready", "the page is ready", status.kind === "ready" ? `opening buy ${units(BigInt(status.summary.openingBuyWei))} ETH, fee ${units(BigInt(status.summary.launchFeeWei))} ETH, total ${units(BigInt(status.summary.totalWei))} ETH` : JSON.stringify(status));

  const wrong = await prepareLaunch(launchDeps(), STRANGER);
  ok(!wrong.ok && wrong.kind === "wrong_wallet" && wrong.problem === "This wallet is not the launch wallet.", "another wallet is refused", !wrong.ok ? `${wrong.problem} (${wrong.connected} vs ${wrong.launcher})` : "");

  const p = await prepareLaunch(launchDeps(), LAUNCHER.toLowerCase());
  if (!p.ok) throw new Error(`the page refused the launch wallet: ${p.problem}`);
  ok(true, "the page's server built the launch and ran it on the fork from the launcher", `predicted token ${p.predictedToken}, gas ${BigInt(p.tx.gas)}`);
  ok(BigInt(p.tx.value) === BigInt(status.kind === "ready" ? status.summary.totalWei : "0"), "value = Pons' launch fee + the opening buy", `${BigInt(p.tx.value)} wei`);

  const sim = await launchDeps().reader.simulate({ from: STRANGER, to: p.tx.to, data: p.tx.data, value: BigInt(p.tx.value) });
  ok(!sim.ok && decodeRevert(sim.revertData).name === "NotLauncher", "run from another wallet, it reverts NotLauncher", !sim.ok ? decodeRevert(sim.revertData).words : "it went through");
  const stranger = await sendAs(STRANGER, { to: p.tx.to as Address, data: p.tx.data, value: BigInt(p.tx.value), gas: BigInt(p.tx.gas) });
  ok(stranger.receipt.status === "reverted", "sent from another wallet, the launch reverts on chain", stranger.hash);
  ok((await pub.readContract({ address: POT, abi: POT_ABI, functionName: "token" })) === ZERO, "and the burn pot still has no token");

  // The forge script, dry run on the same fork with the same launch file and opening buy: the same bytes.
  const [owner, ownerBps, burnBps] = await Promise.all([
    pub.readContract({ address: SPLITTER, abi: SPLITTER_ABI, functionName: "owner" }),
    pub.readContract({ address: SPLITTER, abi: SPLITTER_ABI, functionName: "ownerBps" }),
    pub.readContract({ address: SPLITTER, abi: SPLITTER_ABI, functionName: "burnBps" }),
  ]);
  const contracts = join(ROOT, "contracts");
  const forge = spawnSync(join(process.env.HOME ?? "", ".foundry/bin/forge"), ["script", "script/LaunchToken.s.sol", "--rpc-url", RPC, "--sender", LAUNCHER], {
    cwd: contracts,
    encoding: "utf8",
    env: {
      ...process.env,
      PUSHD_OPENING_BUY_WEI: BUY.toString(),
      PUSHD_LAUNCH_JSON: readFileSync(LAUNCH_FILE(), "utf8"),
      PUSHD_OWNER_WALLET: owner,
      PUSHD_SPLIT_OWNER_BPS: String(ownerBps),
      PUSHD_SPLIT_BURN_BPS: String(burnBps),
    },
  });
  if (forge.status !== 0) {
    console.log(forge.stdout.slice(-2000), forge.stderr.slice(-2000));
    ok(false, "the forge script's dry run");
  } else {
    const run = JSON.parse(readFileSync(join(contracts, "broadcast/LaunchToken.s.sol/4663/dry-run/run-latest.json"), "utf8"));
    const t = run.transactions[0].transaction;
    ok(run.transactions.length === 1 && same(t.to, POT) && same(t.from, LAUNCHER), "the forge script sends one call, launcher to burn pot");
    ok(t.input === p.tx.data, "the page's calldata is byte for byte the forge script's", `${(p.tx.data.length - 2) / 2} bytes`);
    ok(BigInt(t.value) === BigInt(p.tx.value), "the page's value is the forge script's", `${BigInt(t.value)} wei`);
  }
  save({ predicted: p.predictedToken });
}

async function launch() {
  console.log("== The launch: the page's server builds it, the launch wallet sends exactly that");
  const p = await prepareLaunch(launchDeps(), LAUNCHER);
  if (!p.ok) throw new Error(`the page refused: ${p.problem}`);
  const sent = await sendAs(LAUNCHER, { to: p.tx.to as Address, data: p.tx.data, value: BigInt(p.tx.value), gas: BigInt(p.tx.gas) });
  ok(sent.receipt.status === "success", "the launch transaction went through", `${sent.hash}, ${sent.receipt.gasUsed} gas of ${BigInt(p.tx.gas)}`);
  const out = await launchOutcome(launchDeps(), sent.hash);
  ok(out.state === "launched", "the page reads the launch back", out.state === "launched" ? `token ${out.launched.token}, ${units(BigInt(out.launched.openingBuyTokens))} $PUSHD` : JSON.stringify(out));
  save({ hash: sent.hash, tx: p.tx, launchBlock: Number(sent.receipt.blockNumber) });
}

/** One run of the engine's keeper (engine/src/cli/keeper.ts) against the fork, with the throwaway keeper key. */
function keeper(): string {
  const r = spawnSync("npm", ["run", "-s", "keeper"], {
    cwd: join(ROOT, "engine"),
    encoding: "utf8",
    env: { ...process.env, PUSHD_DB: process.env.FORK_ENGINE_DB, PUSHD_KEEPER_KEY: process.env.FORK_KEEPER_KEY, PUSHD_KEEPER: "" },
  });
  const out = `${r.stdout}${r.stderr}`.trim();
  for (const line of out.split("\n")) console.log(`    keeper | ${line}`);
  if (process.env.FORK_KEEPER_KEY && out.includes(process.env.FORK_KEEPER_KEY.slice(2, 20))) ok(false, "the keeper printed its key");
  return out;
}

async function after() {
  console.log("== After the launch: the token, trades, the keeper, a burn");
  const s = state() as { predicted: string; hash: Hex; tx: { to: Address; data: Hex; value: Hex; gas: Hex } };
  const token = await pub.readContract({ address: POT, abi: POT_ABI, functionName: "token" });
  ok(token !== ZERO, "the burn pot's token() is set", token);
  ok(same(token, s.predicted), "it is the address the page predicted before the click");
  const [name, symbol] = await Promise.all([pub.readContract({ address: token, abi: TOKEN_ABI, functionName: "name" }), pub.readContract({ address: token, abi: TOKEN_ABI, functionName: "symbol" })]);
  const file = JSON.parse(readFileSync(LAUNCH_FILE(), "utf8"));
  ok(name === file.name && symbol === file.symbol, "the token's name and ticker", `${name} ($${symbol})`);
  const [boughtEth, boughtTokens, held, supplyAtLaunch] = await Promise.all([
    pub.readContract({ address: POT, abi: POT_ABI, functionName: "openingBuyEth" }),
    pub.readContract({ address: POT, abi: POT_ABI, functionName: "openingBuyTokens" }),
    pub.readContract({ address: token, abi: TOKEN_ABI, functionName: "balanceOf", args: [LAUNCHER] }),
    pub.readContract({ address: token, abi: TOKEN_ABI, functionName: "totalSupply" }),
  ]);
  ok(boughtTokens > 0n && held === boughtTokens, "the launch wallet holds exactly the opening buy's tokens", `${units(boughtTokens)} $PUSHD`);
  ok(boughtEth === BUY, "the burn pot's openingBuyEth is the configured opening buy", `${boughtEth} wei`);
  const info = await pub.readContract({ address: FACTORY, abi: FACTORY_ABI, functionName: "getLaunchedToken", args: [token] });
  ok(info.exists && info.creatorTaxBps === 300, "Pons records a 300 basis point (3%) creator tax");
  ok(same(info.creatorFeeRecipient, SPLITTER) && same(info.deployer, POT) && info.pairToken === ZERO && !info.buybackEnabled, "fees to the splitter, the pot as deployer, paired with ETH, Pons buyback off");

  const again = await prepareLaunch(launchDeps(), LAUNCHER);
  ok(!again.ok && again.kind === "launched", "the page offers no second launch");
  const sim = await launchDeps().reader.simulate({ from: LAUNCHER, to: s.tx.to, data: s.tx.data, value: BigInt(s.tx.value) });
  ok(!sim.ok && decodeRevert(sim.revertData).name === "TokenAlreadySet", "the same call again reverts TokenAlreadySet");

  // Trades from another wallet, after the launch-seconds tax window.
  await test.increaseTime({ seconds: 3600 });
  await test.mine({ blocks: 1 });
  await test.setBalance({ address: TRADER, value: parseEther("5") });
  const curve = info.curve;
  const buy = await sendAs(TRADER, { to: curve, data: encode(CURVE_ABI, "buy", [parseEther("0.5"), 0n, TRADER]), value: parseEther("0.5") });
  ok(buy.receipt.status === "success", "a buy of 0.5 ETH from another wallet", buy.hash);
  const bal = await pub.readContract({ address: token, abi: TOKEN_ABI, functionName: "balanceOf", args: [TRADER] });
  console.log(`  0.5 ETH bought ${units(bal)} $PUSHD`);
  await sendAs(TRADER, { to: token, data: encode(TOKEN_ABI, "approve", [curve, bal]) });
  const sell = await sendAs(TRADER, { to: curve, data: encode(CURVE_ABI, "sell", [bal / 2n, 0n, TRADER]) });
  ok(sell.receipt.status === "success", "a sell of half of it", sell.hash);
  for (const log of [...buy.receipt.logs, ...sell.receipt.logs]) {
    const e = tryDecode(CURVE_ABI, log) as { eventName: string; args: { quoteIn?: bigint; quoteOut?: bigint; fee: bigint; tax: bigint } } | null;
    if (e?.eventName === "CurveSell") {
      const gross = e.args.quoteOut! + e.args.fee + e.args.tax;
      ok(e.args.tax === (gross * 300n) / 10_000n, "the sell paid exactly 3% tax", `${e.args.tax} of ${gross} wei`);
    }
    if (e?.eventName === "CurveBuy") ok(e.args.tax === (e.args.quoteIn! * 300n) / 10_000n, "the buy paid exactly 3% tax", `${e.args.tax} of ${e.args.quoteIn} wei`);
  }

  // The engine's keeper, twice with the pot's own wait between: it sweeps the fees in, and burns when preview() allows.
  const head = await pub.getBlockNumber();
  const supplyBefore = await pub.readContract({ address: token, abi: TOKEN_ABI, functionName: "totalSupply" });
  console.log("  the engine's keeper, first run");
  keeper();
  await test.increaseTime({ seconds: 31 * 60 });
  await test.mine({ blocks: 1 });
  console.log("  the engine's keeper, second run (31 minutes later)");
  keeper();
  const supplyAfter = await pub.readContract({ address: token, abi: TOKEN_ABI, functionName: "totalSupply" });
  const countAfter = await pub.readContract({ address: POT, abi: POT_ABI, functionName: "burnCount" });
  const splits = await pub.getLogs({ address: SPLITTER, event: SPLITTER_ABI[3], fromBlock: head, toBlock: "latest" });
  const swept = splits.reduce((a, l) => a + (l.args.amount ?? 0n), 0n);
  ok(splits.length > 0 && swept > 0n, "the keeper's sweep split the trading fees, part of them into the burn pot", `${units(swept)} ETH of fees swept`);
  const logs = await pub.getLogs({ address: POT, event: POT_ABI[7], fromBlock: head, toBlock: "latest" });
  const burnedTokens = logs.reduce((a, l) => a + (l.args.tokensBurned ?? 0n), 0n);
  const burnedEth = logs.reduce((a, l) => a + (l.args.ethIn ?? 0n), 0n);
  const burned = logs.at(-1);
  ok(logs.length > 0, "the keeper's burn() went through", logs.map((l) => `burn ${l.args.n} in ${l.transactionHash}`).join("; "));
  ok(burnedTokens > 0n, "it bought $PUSHD on the market and burned it", `${units(burnedTokens)} $PUSHD for ${units(burnedEth)} ETH`);
  ok(supplyBefore - supplyAfter === burnedTokens, "totalSupply fell by exactly that", `${units(supplyBefore)} to ${units(supplyAfter)}`);
  save({ token, supplyAtLaunch, supplyBefore, supplyAfter, burnedTokens, burnedEth, burnTxs: logs.map((l) => l.transactionHash), curve, openingBuyTokens: boughtTokens });

  // The engine's /v1/token reads the same from the chain.
  // the engine reads the chain at most once a minute for everyone: wait for its next look
  type Panel = { stage: string; token: string; count: number; burned: string; supply: string; latest: { tx: string }[] };
  let panel = (await (await fetch(`${ENGINE}/v1/token`)).json()) as Panel;
  for (let i = 0; i < 40 && panel.count !== Number(countAfter); i++) {
    await new Promise((r) => setTimeout(r, 2000));
    panel = (await (await fetch(`${ENGINE}/v1/token`)).json()) as Panel;
  }
  ok(panel.stage === "live" && same(panel.token, token), "the engine's /v1/token says live, with the token", panel.stage);
  ok(panel.count === Number(countAfter) && BigInt(panel.burned) === (await pub.readContract({ address: POT, abi: POT_ABI, functionName: "totalTokensBurned" })), "and the burn count and total, read from the chain", `${panel.count} burn, ${units(BigInt(panel.burned))} $PUSHD`);
  ok(BigInt(panel.supply) === supplyAfter, "and the supply now", units(BigInt(panel.supply)));
  ok(panel.latest.some((b) => Boolean(burned) && same(b.tx, burned!.transactionHash)), "and the burn in its list, from the pot's logs");
  ok(!/bps|split|owner|share/i.test(JSON.stringify(panel)), "and nothing about how the fees are shared, nor the fee address", Object.keys(panel).join(", "));
}

async function holders() {
  console.log("== Holder sign-in through the engine, on the fork");
  const s = state() as { token: Address; curve: Address };
  const key = process.env.FORK_HOLDER_KEY as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key ?? "")) throw new Error("FORK_HOLDER_KEY is not set");
  const holder = privateKeyToAccount(key);
  const nobody = privateKeyToAccount(generatePrivateKey());
  await test.setBalance({ address: holder.address, value: parseEther("1") });
  // the holder buys $PUSHD with its own key, a signed transaction like any wallet's
  const own = createWalletClient({ chain, transport: http(RPC), account: holder });
  const hash = await own.sendTransaction({ to: s.curve, data: encode(CURVE_ABI, "buy", [parseEther("0.1"), 0n, holder.address]), value: parseEther("0.1") });
  ok((await pub.waitForTransactionReceipt({ hash })).status === "success", "a holder wallet buys 0.1 ETH of $PUSHD", hash);
  const held = await pub.readContract({ address: s.token, abi: TOKEN_ABI, functionName: "balanceOf", args: [holder.address] });
  const me = (await (await fetch(`${ENGINE}/v1/token`)).json()) as { holderMin: string };
  console.log(`  it holds ${units(held)} $PUSHD; the live feed needs ${Number(me.holderMin).toLocaleString("en-US")}`);
  ok(held >= BigInt(me.holderMin) * 10n ** 18n, "that is at or above the threshold");

  const post = (path: string, body: unknown, bearer?: string) =>
    fetch(`${ENGINE}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body) });
  const signIn = async (who: typeof holder) => {
    const c = (await (await post("/v1/holders/challenge", { address: who.address })).json()) as { message: string; nonce: string };
    return post("/v1/holders/session", { address: who.address, nonce: c.nonce, signature: await who.signMessage({ message: c.message }) });
  };

  const yes = await signIn(holder);
  const yb = (await yes.json()) as { session?: string; status?: { holder: boolean; balanceWei: string } };
  ok(yes.status === 200 && yb.status?.holder === true && BigInt(yb.status.balanceWei) === held, "the holder signs a message and gets a session, its balance read from the chain", `${yes.status}, ${units(BigInt(yb.status?.balanceWei ?? "0"))} $PUSHD`);
  const live = await fetch(`${ENGINE}/v1/feed?delay=0`, { headers: { authorization: `Bearer ${yb.session}` } });
  ok(live.status === 200, "its session opens the live feed (no public delay)", String(live.status));
  const pub401 = await fetch(`${ENGINE}/v1/feed?delay=0`);
  ok(pub401.status === 401, "without a session the live feed is refused", String(pub401.status));

  const no = await signIn(nobody);
  const nb = (await no.json()) as { error?: string; session?: string };
  ok(no.status === 403 && !nb.session, "a wallet with no $PUSHD signs too, and is refused with no session", `${no.status}: ${nb.error}`);
  const replay = await post("/v1/holders/session", { address: holder.address, nonce: "x".repeat(17), signature: "0x00" });
  ok(replay.status === 401, "a made-up nonce is refused", String(replay.status));

  // The same through the site: its routes carry the session in an httpOnly cookie and pass everything else on.
  const WEB = process.env.FORK_WEB ?? "";
  if (!WEB) return;
  const webPost = (path: string, body: unknown, cookie = "") => fetch(`${WEB}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  const wc = (await (await webPost("/api/holder/challenge", { address: holder.address })).json()) as { message: string; nonce: string };
  const signed = await webPost("/api/holder/session", { address: holder.address, nonce: wc.nonce, signature: await holder.signMessage({ message: wc.message }) });
  const setCookie = signed.headers.getSetCookie();
  const session = setCookie.find((v) => v.startsWith("pushd_holder="));
  const sb = (await signed.json()) as { session?: string; status?: { holder: boolean } };
  ok(signed.status === 200 && sb.status?.holder === true && !sb.session, "the site's sign-in answers the status and never hands the session to the page", String(signed.status));
  ok(Boolean(session && /HttpOnly/i.test(session) && /SameSite=lax/i.test(session)), "the session is an httpOnly, same-site cookie", session?.replace(/=[^;]+/, "=...") ?? "none");
  const cookie = setCookie.map((v) => v.split(";")[0]).join("; ");
  const meRes = await fetch(`${WEB}/api/holder/me`, { headers: { cookie } });
  ok(meRes.status === 200 && ((await meRes.json()) as { status: { holder: boolean } }).status.holder, "the site's /api/holder/me knows the holder");
  const ac = new AbortController();
  const stream = await fetch(`${WEB}/api/holder/stream`, { headers: { cookie }, signal: ac.signal });
  const first = stream.body ? new TextDecoder().decode((await stream.body.getReader().read()).value) : "";
  ac.abort();
  ok(stream.status === 200 && /text\/event-stream/.test(stream.headers.get("content-type") ?? "") && first.includes("0 min behind"), "the live stream through the site runs with no delay", first.split("\n")[1] ?? first.slice(0, 60));
  const feed = await (await fetch(`${WEB}/feed`, { headers: { cookie } })).text();
  ok(feed.includes("holder view"), "the feed page shows the holder view for that cookie");
  ok(!(await (await fetch(`${WEB}/feed`)).text()).includes("holder view"), "and the public view without it");
  const other = await fetch(`${WEB}/api/holder/challenge`, { method: "POST", headers: { "content-type": "application/json", origin: "https://somewhere.example" }, body: JSON.stringify({ address: holder.address }) });
  ok(other.status === 403, "a sign-in started from another site is refused", String(other.status));
  const out = await webPost("/api/holder/signout", {}, cookie);
  ok(out.ok && (await fetch(`${WEB}/api/holder/me`, { headers: { cookie } })).status === 401, "signing out ends it");
}

async function main() {
  const step = process.argv[2];
  if (step === "before") await before();
  else if (step === "launch") await launch();
  else if (step === "after") await after();
  else if (step === "holders") await holders();
  else throw new Error("say which step: before, launch, after or holders");
  if (failures) {
    console.log(`\n${failures} check${failures === 1 ? "" : "s"} FAILED`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(String(err?.stack ?? err).replace(/0x[0-9a-fA-F]{64}/g, (m) => `${m.slice(0, 10)}...`));
  process.exit(1);
});
