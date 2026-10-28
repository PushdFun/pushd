/**
 * The launch page (/token/launch): the calldata against the compiled burn pot, every launch.json check
 * token-launch.sh makes, every refusal, and the switch. On a pretend chain; nothing calls a network.
 *
 * The compiled ABI comes from contracts/out (run `cd contracts && forge build` first). The real chain is covered by
 * the fork rehearsal: scripts/launch-rehearsal.sh (docs/token.md).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeFunctionData, encodeErrorResult, encodeFunctionResult, toFunctionSelector, type Abi, type Hex } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import { launchOutcome, launchPageOn, launchSettingsFromEnv, launchStatus, prepareLaunch, type LaunchDeps, type LaunchReader, type PotReads, type SplitterReads, type FactoryReads, type SimResult } from "./launch";
import { buildLaunchTx, checkLaunchFile, decodeRevert, LAUNCH_POT_ABI, openingBuyFromEnv, PONS_ERRORS, POT_ERRORS } from "./launch-plan";
import { readLaunchFile } from "./launch-server";

const OUT = join(process.cwd(), "..", "contracts", "out", "PushdBurnPot.sol", "PushdBurnPot.json");
if (!existsSync(OUT)) throw new Error("contracts/out is missing: run `cd contracts && forge build` before the tests");
const COMPILED = JSON.parse(readFileSync(OUT, "utf8")).abi as Abi;

const POT = "0x1111111111111111111111111111111111111111";
const SPLITTER = "0x2222222222222222222222222222222222222222";
const LAUNCHER = "0x8bB1a3f9C2d47e5A0c6E1D2f3a4B5c6D7e8F9a0B";
const OWNER = "0x3333333333333333333333333333333333333333";
const OTHER = "0x4444444444444444444444444444444444444444";
const ESCROW = "0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e";
const MANAGER = "0x5555555555555555555555555555555555555555";
const HOOK = "0x6666666666666666666666666666666666666666";
const TOKEN = "0x7777777777777777777777777777777777777777";
const PONS = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e";
const ZERO = "0x0000000000000000000000000000000000000000";
const ECON = "0xa9fc75d4203a33fe660e8fa32c74c3aa41c1fda4bf23d3a39b6bc22a1f8b1ca7" as Hex;
/** `cast keccak PUSHD`: the salt LaunchToken.s.sol uses, keccak256(bytes(symbol)). */
const SALT = "0xecf04dd431272849e14ac027fa82f382e53ef185944ef5e0d77c2647a25a1960";
const FEE = BigInt("500000000000000");
const BUY = BigInt("7468421052631578");
const ETH = BigInt("1000000000000000000");

const FILE = {
  name: "PUSHD",
  symbol: "PUSHD",
  logo: "https://pushd.example/pushd-mark.png",
  description: "The token of PUSHD, the live feed of what well-known crypto and AI builders publish on GitHub. Part of every trade's fee buys $PUSHD on the market and burns it, so the supply only goes down.",
  website: "https://pushd.example",
  twitter: "https://x.com/pushd-example",
  launchFeeWei: "500000000000000",
  openingBuyUsd: "30",
};

/** A chain where everything is as it should be; each test breaks one thing. */
class FakeReader implements LaunchReader {
  chain = 4663;
  code: Record<string, boolean> = { [POT.toLowerCase()]: true, [SPLITTER.toLowerCase()]: true, [PONS.toLowerCase()]: true };
  potReads: PotReads = { launcher: LAUNCHER, splitter: SPLITTER, factory: PONS, poolManager: MANAGER, hook: HOOK, token: ZERO, openingBuyEth: BigInt(0), openingBuyTokens: BigInt(0), creatorTaxBps: 300 };
  splitterReads: SplitterReads = { owner: OWNER, burnPot: POT, escrow: ESCROW, ownerBps: 7000, burnBps: 3000 };
  factoryReads: FactoryReads = { launchFee: FEE, economics: ECON, poolManager: MANAGER, memeHook: HOOK, feeEscrow: ESCROW, graduationThreshold: BigInt("4200000000000000000") };
  bal = ETH;
  nonce = { latest: 0, pending: 0 };
  price = BigInt(20_000_000);
  sim: SimResult = { ok: true, returned: encodeFunctionResult({ abi: LAUNCH_POT_ABI, functionName: "launch", result: TOKEN }) };
  gas = BigInt(4_000_000);
  logoAnswer = { status: 200, contentType: "image/png" };
  rec: { status: "success" | "reverted"; from: string; to: string | null; block: number } | null = null;
  known = false;
  simulated: { from: string; to: string; data: Hex; value: bigint }[] = [];
  chainId = async () => this.chain;
  hasCode = async (a: string) => Boolean(this.code[a.toLowerCase()]);
  pot = async () => ({ ...this.potReads });
  splitter = async () => ({ ...this.splitterReads });
  factory = async () => ({ ...this.factoryReads });
  balance = async () => this.bal;
  nonces = async () => this.nonce;
  gasPrice = async () => this.price;
  simulate = async (tx: { from: string; to: string; data: Hex; value: bigint }) => {
    this.simulated.push(tx);
    return this.sim;
  };
  estimateGas = async () => this.gas;
  ethUsd = async () => BigInt("401700000000");
  logo = async () => this.logoAnswer;
  receipt = async () => this.rec;
  knowsTx = async () => this.known;
  tokenBalance = async () => BigInt(123);
  launched = async () => ({ exists: true, deployer: POT, creatorFeeRecipient: SPLITTER, creatorTaxBps: 300, pairToken: ZERO, buybackEnabled: false });
}

const deps = (r: FakeReader, env: Record<string, string> = {}, file: unknown = FILE): LaunchDeps => ({
  reader: r,
  settings: launchSettingsFromEnv({ PUSHD_BURN_POT_ADDRESS: POT, PUSHD_SPLITTER_ADDRESS: SPLITTER, PUSHD_LAUNCH_OPENING_BUY_WEI: BUY.toString(), ...env }, "https://robinhoodchain.blockscout.com"),
  launchFile: file,
});

/** What contracts/script/LaunchToken.s.sol puts in TokenParams for a launch.json, field by field. */
function forgeParams(f: typeof FILE, economics: Hex) {
  return {
    name: f.name,
    symbol: f.symbol,
    logo: f.logo,
    description: f.description,
    socials: { twitter: f.twitter, telegram: "", discord: "", website: f.website, farcaster: "" },
    creatorFeeRecipient: ZERO,
    creatorTaxBps: 0,
    buybackEnabled: false,
    expectedEconomics: economics,
    salt: SALT,
  };
}

describe("the launch call, against the compiled burn pot", () => {
  it("uses launch() exactly as compiled, and every error the pot declares", () => {
    const compiledLaunch = COMPILED.find((e) => e.type === "function" && e.name === "launch")!;
    const ours = LAUNCH_POT_ABI.find((e) => e.name === "launch")!;
    expect(toFunctionSelector(ours as never)).toBe(toFunctionSelector(compiledLaunch as never));
    for (const name of ["launcher", "splitter", "factory", "poolManager", "hook", "token", "openingBuyEth", "openingBuyTokens", "CREATOR_TAX_BPS"]) {
      const c = COMPILED.find((e) => e.type === "function" && e.name === name) as { outputs: { type: string }[] } | undefined;
      const o = LAUNCH_POT_ABI.find((e) => e.name === name) as { outputs: readonly { type: string }[] };
      expect(c, name).toBeDefined();
      expect(o.outputs.map((x) => x.type)).toEqual(c!.outputs.map((x) => x.type));
    }
    const sig = (e: { name: string; inputs: readonly { type: string }[] }) => `${e.name}(${e.inputs.map((i) => i.type).join(",")})`;
    const compiledErrors = COMPILED.filter((e) => e.type === "error").map((e) => sig(e as never)).sort();
    expect(POT_ERRORS.map((e) => sig(e)).sort()).toEqual(compiledErrors);
  });

  it("decodes to exactly the TokenParams, launch config, exemptions and value the forge script uses", () => {
    const lf = checkLaunchFile(FILE);
    if (!lf.ok) throw new Error(lf.problem);
    const tx = buildLaunchTx(POT, lf.file, ECON, FEE, BUY);
    expect(tx.to).toBe(POT);
    expect(tx.value).toBe(FEE + BUY);
    const d = decodeFunctionData({ abi: COMPILED, data: tx.data });
    expect(d.functionName).toBe("launch");
    const [params, config, exempt] = d.args as [Record<string, unknown>, bigint, readonly string[]];
    expect(params).toEqual(forgeParams(FILE, ECON));
    expect(config).toBe(BigInt(0));
    expect(exempt).toEqual([]);
  });

  it("reads the real contracts/launch.json: refused while it holds placeholders, built the same way once filled in", () => {
    const raw = readLaunchFile() as typeof FILE;
    expect(raw).toBeTruthy();
    expect(raw.symbol).toBe("PUSHD");
    expect(BigInt(raw.launchFeeWei)).toBe(FEE);
    const lf = checkLaunchFile(raw);
    if (!lf.ok) {
      // the domain and the X account do not exist yet: the page and token-launch.sh both stop here
      expect(lf.problem).toContain("REPLACE ME");
      return;
    }
    const d = decodeFunctionData({ abi: COMPILED, data: buildLaunchTx(POT, lf.file, ECON, FEE, BUY).data });
    expect(d.args?.[0]).toEqual(forgeParams(raw, ECON));
  });

  it("builds the real launch.json's description and name as they are, once the links are filled in", () => {
    const raw = readLaunchFile() as typeof FILE;
    const filled = { ...raw, logo: FILE.logo, website: FILE.website, twitter: FILE.twitter };
    const lf = checkLaunchFile(filled);
    if (!lf.ok) throw new Error(lf.problem);
    const d = decodeFunctionData({ abi: COMPILED, data: buildLaunchTx(POT, lf.file, ECON, FEE, BUY).data });
    expect(d.args?.[0]).toEqual(forgeParams(filled, ECON));
  });

  it("never builds a call without Pons' launch terms", () => {
    const lf = checkLaunchFile(FILE);
    if (!lf.ok) throw new Error(lf.problem);
    expect(() => buildLaunchTx(POT, lf.file, `0x${"0".repeat(64)}`, FEE, BUY)).toThrow();
    expect(() => buildLaunchTx(POT, lf.file, "0x1234" as Hex, FEE, BUY)).toThrow();
  });
});

describe("contracts/launch.json, checked as token-launch.sh checks it", () => {
  const bad = (patch: Record<string, unknown>) => checkLaunchFile({ ...FILE, ...patch });
  it("takes the real file", () => expect(checkLaunchFile(FILE).ok).toBe(true));
  it.each([
    ["a REPLACE placeholder in the logo", { logo: "https://REPLACE-ME-when-the-domain-is-live/pushd-mark.png" }, "REPLACE ME"],
    ["a REPLACE placeholder in the website", { website: "https://REPLACE-ME-when-the-domain-is-live" }, "REPLACE ME"],
    ["a REPLACE placeholder anywhere", { openingBuyUsd: "REPLACE" }, "REPLACE ME"],
    ["another ticker", { symbol: "PUSH" }, "ticker is not PUSHD"],
    ["a logo that is not https", { logo: "http://pushd.example/x.png" }, "not https"],
    ["Robinhood as one word", { description: "On Robinhood Chain." }, "'Robinhood'"],
    ["an em dash", { description: "PUSHD \u2014 feed" }, "long dash"],
    ["an en dash", { name: "PUSHD \u2013 X" }, "long dash"],
    ["a percentage", { description: "30% is burned" }, "percentage"],
    ["a percentage in words", { description: "30 percent is burned" }, "percentage"],
    ["a missing name", { name: "  " }, "missing name"],
    ["a missing X link", { twitter: undefined }, "missing twitter"],
    ["openingBuyUsd as a number", { openingBuyUsd: 30 }, "openingBuyUsd"],
    ["launchFeeWei not digits", { launchFeeWei: "5e14" }, "launchFeeWei"],
  ])("refuses %s", (_, patch, words) => {
    const r = bad(patch);
    expect(r.ok).toBe(false);
    expect((r as { problem: string }).problem).toContain(words);
  });
  it("refuses a missing or broken file", () => {
    expect(checkLaunchFile(null).ok).toBe(false);
    expect(checkLaunchFile([]).ok).toBe(false);
  });
});

describe("the opening buy setting", () => {
  it("is whole wei, digits only, above zero", () => {
    expect(openingBuyFromEnv({ PUSHD_LAUNCH_OPENING_BUY_WEI: "10000000000000000" })).toBe(BigInt("10000000000000000"));
    for (const v of [undefined, "", "0", "0.01", "1e16", "1,000", " 100", "100 ", "-5", "0x10", "١٢"]) expect(openingBuyFromEnv({ PUSHD_LAUNCH_OPENING_BUY_WEI: v })).toBeNull();
  });
});

describe("the page's checks on load", () => {
  it("is ready with everything right, and shows the figures", async () => {
    const s = await launchStatus(deps(new FakeReader()));
    expect(s.kind).toBe("ready");
    if (s.kind !== "ready") return;
    expect(s.summary).toMatchObject({ name: "PUSHD", symbol: "PUSHD", openingBuyWei: BUY.toString(), launchFeeWei: FEE.toString(), totalWei: (FEE + BUY).toString(), creatorTaxBps: 300, launcher: LAUNCHER, pot: POT });
    // Nothing about the split crosses to the browser.
    expect(JSON.stringify(s)).not.toMatch(/ownerBps|burnBps|:7000|:3000|"7000"|"3000"/);
    expect(JSON.stringify(s)).not.toContain(OWNER);
  });

  const blocked = async (r: FakeReader, words: string, env: Record<string, string> = {}, file: unknown = FILE) => {
    const s = await launchStatus(deps(r, env, file));
    expect(s.kind).toBe("blocked");
    expect((s as { problem: string }).problem).toContain(words);
    const p = await prepareLaunch(deps(r, env, file), LAUNCHER);
    expect(p.ok).toBe(false);
    expect((p as { kind: string }).kind).toBe("blocked");
    expect(r.simulated).toHaveLength(0);
  };

  it("stops without the two addresses", async () => {
    await blocked(new FakeReader(), "PUSHD_BURN_POT_ADDRESS", { PUSHD_BURN_POT_ADDRESS: "" });
    await blocked(new FakeReader(), "PUSHD_SPLITTER_ADDRESS", { PUSHD_SPLITTER_ADDRESS: "0x12" });
  });
  it("stops on another chain", async () => {
    const r = new FakeReader();
    r.chain = 1;
    await blocked(r, "not Robinhood Chain");
  });
  it("stops when the burn pot has no code", async () => {
    const r = new FakeReader();
    r.code[POT.toLowerCase()] = false;
    await blocked(r, "no contract at the burn pot");
  });
  it("stops on a splitter mismatch, either way round", async () => {
    const a = new FakeReader();
    a.potReads.splitter = OTHER;
    await blocked(a, "not to the fee address set on this server");
    const b = new FakeReader();
    b.splitterReads.burnPot = OTHER;
    await blocked(b, "does not send the burn share to this burn pot");
  });
  it("stops when the shares do not add up, without saying what they are", async () => {
    const r = new FakeReader();
    r.splitterReads.burnBps = 2000;
    const s = await launchStatus(deps(r));
    expect((s as { problem: string }).problem).toBe("The fee address's two shares do not add up to the whole.");
    const z = new FakeReader();
    z.splitterReads = { ...z.splitterReads, ownerBps: 10000, burnBps: 0 };
    await blocked(z, "do not add up");
  });
  it("stops on another factory, escrow, pool, owner or tax", async () => {
    const f = new FakeReader();
    f.potReads.factory = OTHER;
    await blocked(f, "not Pons' launch factory");
    const e = new FakeReader();
    e.splitterReads.escrow = OTHER;
    await blocked(e, "another escrow");
    const h = new FakeReader();
    h.potReads.hook = OTHER;
    await blocked(h, "Pons' own pool");
    const o = new FakeReader();
    o.splitterReads.owner = POT;
    await blocked(o, "owner wallet");
    const t = new FakeReader();
    t.potReads.creatorTaxBps = 500;
    await blocked(t, "not 300");
  });
  it("stops on a fee mismatch", async () => {
    const r = new FakeReader();
    r.factoryReads.launchFee = BigInt("600000000000000");
    await blocked(r, "not the 500000000000000 wei written in contracts/launch.json");
  });
  it("stops on a REPLACE placeholder", async () => {
    await blocked(new FakeReader(), "REPLACE ME", {}, { ...FILE, logo: "https://REPLACE-ME/pushd.png" });
  });
  it("stops when the logo does not answer with a picture", async () => {
    const r = new FakeReader();
    r.logoAnswer = { status: 200, contentType: "text/html" };
    await blocked(r, "does not answer with a picture");
    const m = new FakeReader();
    m.logoAnswer = { status: 301, contentType: "" };
    await blocked(m, "does not answer with a picture");
  });
  it("stops when Pons' launch terms are not read", async () => {
    const r = new FakeReader();
    r.factoryReads.economics = `0x${"0".repeat(64)}`;
    await blocked(r, "launch terms");
  });
  it("stops when a read fails, with no guess", async () => {
    const r = new FakeReader();
    r.chainId = async () => {
      throw new Error("fetch failed");
    };
    await blocked(r, "did not answer");
  });
  it.each(["", "0", "0.01", "1e16", "abc"])("says the opening buy is not set for %j, and offers nothing", async (v) => {
    const r = new FakeReader();
    const s = await launchStatus(deps(r, { PUSHD_LAUNCH_OPENING_BUY_WEI: v }));
    expect(s).toEqual({ kind: "no_dev_buy", problem: "The opening buy is not set yet." });
    const p = await prepareLaunch(deps(r, { PUSHD_LAUNCH_OPENING_BUY_WEI: v }), LAUNCHER);
    expect(p).toMatchObject({ ok: false, kind: "no_dev_buy" });
    expect(r.simulated).toHaveLength(0);
  });
  it("refuses an opening buy as large as the whole curve", async () => {
    await blocked(new FakeReader(), "as large as the whole launch curve", { PUSHD_LAUNCH_OPENING_BUY_WEI: "4200000000000000000" });
  });
  it("shows the token instead of a button once launched", async () => {
    const r = new FakeReader();
    r.potReads = { ...r.potReads, token: TOKEN, openingBuyEth: BUY, openingBuyTokens: BigInt(5) * ETH };
    const s = await launchStatus(deps(r));
    expect(s).toEqual({ kind: "launched", launched: { token: TOKEN, openingBuyTokens: (BigInt(5) * ETH).toString(), openingBuyEth: BUY.toString(), launcher: LAUNCHER } });
    const p = await prepareLaunch(deps(r), LAUNCHER);
    expect(p).toMatchObject({ ok: false, kind: "launched" });
    expect(r.simulated).toHaveLength(0);
  });
});

describe("building the transaction for the connected wallet", () => {
  it("hands back exactly the launch call, run first from the launcher, with a quarter more gas", async () => {
    const r = new FakeReader();
    const p = await prepareLaunch(deps(r), LAUNCHER.toLowerCase());
    if (!p.ok) throw new Error(p.problem);
    expect(p.tx.to).toBe(POT);
    expect(p.tx.from).toBe(LAUNCHER.toLowerCase());
    expect(BigInt(p.tx.value)).toBe(FEE + BUY);
    expect(BigInt(p.tx.gas)).toBe(BigInt(5_000_000));
    expect(p.tx.chainId).toBe(4663);
    expect(p.predictedToken.toLowerCase()).toBe(TOKEN);
    const d = decodeFunctionData({ abi: COMPILED, data: p.tx.data });
    expect(d.args?.[0]).toEqual(forgeParams(FILE, ECON));
    expect(r.simulated).toEqual([{ from: LAUNCHER.toLowerCase(), to: POT, data: p.tx.data, value: FEE + BUY }]);
  });

  it("refuses another wallet, showing both addresses, in any letter case", async () => {
    const r = new FakeReader();
    const p = await prepareLaunch(deps(r), OTHER);
    expect(p).toEqual({ ok: false, kind: "wrong_wallet", problem: "This wallet is not the launch wallet.", launcher: LAUNCHER, connected: OTHER });
    expect(r.simulated).toHaveLength(0);
    expect((await prepareLaunch(deps(r), "not an address")).ok).toBe(false);
  });

  it("says how much ETH is missing, before and after the gas estimate", async () => {
    const r = new FakeReader();
    r.bal = FEE + BUY;
    const p = await prepareLaunch(deps(r), LAUNCHER);
    expect(p).toMatchObject({ ok: false, kind: "short" });
    // the gas reckoned at 8,000,000 units at twice the gas price
    expect((p as { missingWei: string }).missingWei).toBe((BigInt(8_000_000) * BigInt(40_000_000)).toString());
    expect(r.simulated).toHaveLength(0);

    const q = new FakeReader();
    q.gas = BigInt(9_000_000); // more than the guess: the check after the estimate catches it
    q.bal = FEE + BUY + BigInt(8_000_000) * BigInt(40_000_000);
    const p2 = await prepareLaunch(deps(q), LAUNCHER);
    expect(p2).toMatchObject({ ok: false, kind: "short" });
    expect(BigInt((p2 as { missingWei: string }).missingWei)).toBe(((BigInt(9_000_000) * BigInt(125)) / BigInt(100)) * BigInt(40_000_000) - BigInt(8_000_000) * BigInt(40_000_000));
  });

  it("waits while the wallet has a transaction out", async () => {
    const r = new FakeReader();
    r.nonce = { latest: 3, pending: 4 };
    expect(await prepareLaunch(deps(r), LAUNCHER)).toMatchObject({ ok: false, kind: "waiting" });
  });

  it("shows a simulation revert decoded, and no transaction", async () => {
    const r = new FakeReader();
    r.sim = { ok: false, revertData: encodeErrorResult({ abi: POT_ERRORS, errorName: "NotLauncher" }), message: "execution reverted" };
    const p = await prepareLaunch(deps(r), LAUNCHER);
    expect(p).toMatchObject({ ok: false, kind: "reverted" });
    expect((p as { problem: string }).problem).toContain("Only the launch wallet can launch $PUSHD.");
    expect("tx" in p).toBe(false);

    r.sim = { ok: false, revertData: encodeErrorResult({ abi: PONS_ERRORS, errorName: "LaunchEconomicsMismatch", args: [ECON, SALT as Hex] }), message: "" };
    expect(((await prepareLaunch(deps(r), LAUNCHER)) as { problem: string }).problem).toContain("launch terms changed");

    r.sim = { ok: false, revertData: null, message: "The node refused it: insufficient funds" };
    expect(((await prepareLaunch(deps(r), LAUNCHER)) as { problem: string }).problem).toContain("insufficient funds");

    r.sim = { ok: true, returned: "0x" };
    expect(await prepareLaunch(deps(r), LAUNCHER)).toMatchObject({ ok: false, kind: "reverted" });
  });

  it("decodes the pot's errors, Pons' errors, reasons and unknown ones", () => {
    expect(decodeRevert(encodeErrorResult({ abi: POT_ERRORS, errorName: "TokenAlreadySet" })).name).toBe("TokenAlreadySet");
    expect(decodeRevert(encodeErrorResult({ abi: POT_ERRORS, errorName: "LaunchFeeShort", args: [FEE] })).args).toEqual([FEE.toString()]);
    expect(decodeRevert(encodeErrorResult({ abi: PONS_ERRORS, errorName: "LaunchFeeNotPaid" })).name).toBe("LaunchFeeNotPaid");
    expect(decodeRevert(`0x08c379a0${"0".repeat(62)}20${"0".repeat(63)}2${"6869"}${"0".repeat(60)}`).words).toBe("It reverted: hi");
    expect(decodeRevert("0xdeadbeef").words).toContain("0xdeadbeef");
    expect(decodeRevert("0x").words).toContain("without saying why");
  });
});

describe("after the wallet sent it", () => {
  const H = `0x${"ab".repeat(32)}`;
  it("reads the token, the opening buy and the wallet's tokens from the burn pot", async () => {
    const r = new FakeReader();
    r.rec = { status: "success", from: LAUNCHER, to: POT, block: 10 };
    r.potReads = { ...r.potReads, token: TOKEN, openingBuyEth: BUY, openingBuyTokens: BigInt(7) * ETH };
    expect(await launchOutcome(deps(r), H)).toEqual({ state: "launched", launched: { token: TOKEN, openingBuyTokens: (BigInt(7) * ETH).toString(), openingBuyEth: BUY.toString(), launcher: LAUNCHER }, balanceWei: "123", viaThisTx: true });
  });
  it("says a failed transaction failed", async () => {
    const r = new FakeReader();
    r.rec = { status: "reverted", from: LAUNCHER, to: POT, block: 10 };
    expect(await launchOutcome(deps(r), H)).toMatchObject({ state: "failed" });
  });
  it("waits while the node knows it, and says when it does not", async () => {
    const r = new FakeReader();
    r.known = true;
    expect(await launchOutcome(deps(r), H)).toEqual({ state: "pending" });
    r.known = false;
    expect(await launchOutcome(deps(r), H)).toEqual({ state: "unknown" });
    expect(await launchOutcome(deps(r), "0x12")).toMatchObject({ state: "failed" });
  });
});

describe("the switch", () => {
  const saved = process.env.PUSHD_LAUNCH_PAGE;
  afterEach(() => {
    if (saved === undefined) delete process.env.PUSHD_LAUNCH_PAGE;
    else process.env.PUSHD_LAUNCH_PAGE = saved;
  });
  it("is on only for PUSHD_LAUNCH_PAGE=on", () => {
    expect(launchPageOn({})).toBe(false);
    expect(launchPageOn({ PUSHD_LAUNCH_PAGE: "true" })).toBe(false);
    expect(launchPageOn({ PUSHD_LAUNCH_PAGE: "ON" })).toBe(false);
    expect(launchPageOn({ PUSHD_LAUNCH_PAGE: "on" })).toBe(true);
  });
  it("makes /token/launch a 404 without PUSHD_LAUNCH_PAGE=on, and its server steps refuse", async () => {
    delete process.env.PUSHD_LAUNCH_PAGE;
    const page = (await import("@/app/token/launch/page")).default;
    await expect(page()).rejects.toMatchObject({ digest: expect.stringContaining("404") });
    process.env.PUSHD_LAUNCH_PAGE = "off";
    await expect(page()).rejects.toMatchObject({ digest: expect.stringContaining("404") });
    const actions = await import("@/app/token/launch/actions");
    expect(await actions.prepareLaunchTx(LAUNCHER)).toMatchObject({ ok: false, problem: "This page is switched off." });
    expect(await actions.readLaunchOutcome(`0x${"ab".repeat(32)}`)).toMatchObject({ state: "failed", problem: "This page is switched off." });
  });
});
