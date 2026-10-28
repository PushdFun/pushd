/**
 * SERVER ONLY. The $PUSHD launch transaction, built exactly the way
 * contracts/script/LaunchToken.s.sol builds it, and every check
 * contracts/token-launch.sh makes on contracts/launch.json.
 *
 * Pure: no chain, no network. launch.ts reads the chain and calls in here;
 * the tests decode what comes out against the compiled ABI in contracts/out.
 *
 * What the forge script sends, and so what this sends:
 *   to     the burn pot
 *   data   launch(TokenParams, 0, [])
 *            name, symbol, logo, description   from launch.json
 *            socials                           website and twitter from launch.json, the other three ""
 *            creatorFeeRecipient, creatorTaxBps, buybackEnabled   zero (the pot forces its own and reads them back)
 *            expectedEconomics                 factory.previewLaunchEconomics(0, address(0)), read fresh
 *            salt                              keccak256(bytes(symbol))
 *   value  factory.launchFee() + the opening buy
 */
import { decodeErrorResult, decodeFunctionData, encodeFunctionData, keccak256, parseAbi, toBytes, type Address, type Hex } from "viem";

/** Pons' launch configuration $PUSHD is launched under (LaunchToken.s.sol: LAUNCH_CONFIG). */
export const LAUNCH_CONFIG_ID = BigInt(0);
/** The one ticker this page launches. */
export const PUSHD_SYMBOL = "PUSHD";

const SOCIALS = {
  name: "socials",
  type: "tuple",
  components: [
    { name: "twitter", type: "string" },
    { name: "telegram", type: "string" },
    { name: "discord", type: "string" },
    { name: "website", type: "string" },
    { name: "farcaster", type: "string" },
  ],
} as const;

const TOKEN_PARAMS = {
  name: "params",
  type: "tuple",
  components: [
    { name: "name", type: "string" },
    { name: "symbol", type: "string" },
    { name: "logo", type: "string" },
    { name: "description", type: "string" },
    SOCIALS,
    { name: "creatorFeeRecipient", type: "address" },
    { name: "creatorTaxBps", type: "uint16" },
    { name: "buybackEnabled", type: "bool" },
    { name: "expectedEconomics", type: "bytes32" },
    { name: "salt", type: "bytes32" },
  ],
} as const;

const view = (name: string, type: "address" | "uint256" | "uint16") => ({ type: "function", name, stateMutability: "view", inputs: [], outputs: [{ type }] }) as const;

/** PushdBurnPot: launch() and the reads the launch page needs. Checked against contracts/out in the tests. */
export const LAUNCH_POT_ABI = [
  {
    type: "function",
    name: "launch",
    stateMutability: "payable",
    inputs: [TOKEN_PARAMS, { name: "launchConfigId", type: "uint256" }, { name: "alsoExempt", type: "address[]" }],
    outputs: [{ name: "token_", type: "address" }],
  },
  view("launcher", "address"),
  view("splitter", "address"),
  view("factory", "address"),
  view("poolManager", "address"),
  view("hook", "address"),
  view("token", "address"),
  view("openingBuyEth", "uint256"),
  view("openingBuyTokens", "uint256"),
  view("CREATOR_TAX_BPS", "uint16"),
] as const;

/** Every custom error PushdBurnPot declares (contracts/src/PushdBurnPot.sol). Checked against contracts/out in the tests. */
export const POT_ERRORS = parseAbi([
  "error NotLauncher()",
  "error Reentered()",
  "error DuplicateExemption(address wallet)",
  "error ZeroAddress()",
  "error TokenAlreadySet()",
  "error TokenNotSet()",
  "error TooSoon(uint256 nextAt)",
  "error TooSmall(uint256 amount, uint256 min)",
  "error NothingToBurn()",
  "error NotPoolManager()",
  "error Slippage()",
  "error NotPonsLaunch()",
  "error WrongFeeRecipient(address recipient)",
  "error NotEthPair()",
  "error WrongCreatorTax(uint16 bps)",
  "error BuybackEnabled()",
  "error SplitterMismatch()",
  "error MarketNotReady()",
  "error Overcharged()",
  "error LaunchFeeShort(uint256 fee)",
  "error SupplyDidNotFall()",
]);

/**
 * The errors Pons' launch factory and bonding curve declare (Pons v2 source: PonsV2LaunchFactory.sol,
 * PonsV2BondingCurve.sol, PonsV2LauncherToken.sol). A selector that matches none of these or the pot's shows as its
 * raw selector.
 */
export const PONS_ERRORS = parseAbi([
  "error InvalidLaunchConfigId()",
  "error LaunchConfigDisabled()",
  "error InvalidBasisPoints()",
  "error ExemptionListTooLong()",
  "error InvalidSnipeTaxWindow()",
  "error CurveFeeTooHigh()",
  "error CreatorTaxTooHigh()",
  "error CombinedFeeTooHigh()",
  "error SupplyTooLow()",
  "error InvalidTickSpacing()",
  "error LaunchFeeNotPaid()",
  "error NotWhitelisted()",
  "error FeeTransferFailed()",
  "error AlreadySet()",
  "error InvalidTokenParams()",
  "error TokenNotFound()",
  "error WrongGraduationPhase()",
  "error LaunchDeployerNotSet()",
  "error LaunchDependenciesNotWired()",
  "error PairTokenNotApproved()",
  "error GraduationSeedNotViable()",
  "error SupplyTooHigh()",
  "error LaunchEconomicsMismatch(bytes32 expected, bytes32 actual)",
  "error InexactTransfer(address token, uint256 expected, uint256 received)",
  "error CurveGraduated()",
  "error ZeroAmount()",
  "error SlippageExceeded(uint256 actual, uint256 minimum)",
  "error NotFactory()",
  "error TransferFailed()",
  "error AlreadyGraduated()",
  "error NotInitialized()",
  "error InvalidLaunchEconomics()",
  "error NativeValueMismatch(uint256 supplied, uint256 expected)",
  "error UnexpectedNativeValue()",
  "error MetadataTooLong()",
]);

const STANDARD_ERRORS = parseAbi(["error Error(string message)", "error Panic(uint256 code)"]);

/** What each error means for the person pressing the button. Missing ones show their name. */
const ERROR_WORDS: Record<string, string> = {
  NotLauncher: "Only the launch wallet can launch $PUSHD.",
  TokenAlreadySet: "$PUSHD is already launched from this burn pot.",
  SplitterMismatch: "The fee address is not wired to this burn pot.",
  LaunchFeeShort: "The amount sent does not cover Pons' launch fee.",
  NotPonsLaunch: "Pons did not record the launch as this burn pot's.",
  WrongFeeRecipient: "Pons would pay the fees somewhere other than the fee address.",
  WrongCreatorTax: "Pons would set a different creator tax.",
  NotEthPair: "Pons would not pair $PUSHD with ETH.",
  BuybackEnabled: "Pons would switch its own buyback on.",
  DuplicateExemption: "A wallet is listed twice.",
  ZeroAddress: "An address in the launch is empty.",
  LaunchEconomicsMismatch: "Pons' launch terms changed since they were read. Reload the page to read them again.",
  LaunchFeeNotPaid: "Pons' launch fee changed since it was read.",
  NotWhitelisted: "Pons does not allow this burn pot to launch.",
  LaunchConfigDisabled: "Pons has switched this launch setup off.",
  InvalidLaunchConfigId: "Pons does not know this launch setup.",
  InvalidTokenParams: "Pons refused the name or the ticker.",
  MetadataTooLong: "Pons refused the launch details as too long.",
  ExemptionListTooLong: "Too many wallets are exempted.",
  CurveGraduated: "The launch curve is already full.",
  SlippageExceeded: "The opening buy would get fewer tokens than allowed.",
};

export type DecodedRevert = { name: string; args: string[]; words: string };

/** A revert's data in plain words: the pot's errors, Pons' errors, a reason string or a panic. */
export function decodeRevert(data: Hex | null | undefined): DecodedRevert {
  if (!data || data === "0x") return { name: "", args: [], words: "It reverted without saying why." };
  for (const abi of [POT_ERRORS, PONS_ERRORS, STANDARD_ERRORS] as const) {
    try {
      const r = decodeErrorResult({ abi, data });
      const args = (r.args ?? []).map((a) => String(a));
      const name = r.errorName;
      const words = name === "Error" ? `It reverted: ${args[0]}` : name === "Panic" ? `It reverted with panic code ${args[0]}.` : (ERROR_WORDS[name] ?? `It reverted with ${name}.`);
      return { name, args, words };
    } catch {
      /* not one of these */
    }
  }
  return { name: data.slice(0, 10), args: [], words: `It reverted with an error this page does not know (${data.slice(0, 10)}).` };
}

/** contracts/launch.json, as token-launch.sh reads it. */
export type LaunchFile = {
  name: string;
  symbol: string;
  logo: string;
  description: string;
  website: string;
  twitter: string;
  launchFeeWei: bigint;
  openingBuyUsd: string;
};

/**
 * Every check token-launch.sh makes on launch.json, word for word in what it refuses, plus LaunchToken.s.sol's own
 * (the ticker, a name and a logo) and the links being https. The picture's link answering with a picture is checked
 * on the network, in launch.ts.
 */
export function checkLaunchFile(raw: unknown): { ok: true; file: LaunchFile } | { ok: false; problem: string } {
  const bad = (problem: string) => ({ ok: false as const, problem: `contracts/launch.json is not ready: ${problem}` });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return bad("it is not a JSON object.");
  const d = raw as Record<string, unknown>;
  const keys = ["name", "symbol", "logo", "description", "website", "twitter"] as const;
  const missing = keys.filter((k) => typeof d[k] !== "string" || !(d[k] as string).trim());
  if (missing.length) return bad(`missing ${missing.join(", ")}.`);
  if (Object.values(d).some((v) => String(v).includes("REPLACE"))) return bad("it still holds a REPLACE ME placeholder (the picture's link or the X link).");
  const s = d as Record<(typeof keys)[number], string>;
  if (s.symbol !== PUSHD_SYMBOL) return bad("the ticker is not PUSHD.");
  if (!s.logo.startsWith("https://")) return bad("the picture's link is not https://.");
  if (!/^https:\/\/\S+$/.test(s.website) || !/^https:\/\/\S+$/.test(s.twitter)) return bad("the website and X links must be https:// links.");
  const text = s.name + s.description;
  if (text.includes("Robinhood")) return bad("the name or description says 'Robinhood' as one word.");
  if (text.includes("\u2014") || text.includes("\u2013")) return bad("the description has a long dash in it.");
  if (/\d+\s*(%|percent)/.test(s.description)) return bad("the description gives a percentage: it never shows how the fees are shared.");
  if (typeof d.openingBuyUsd !== "string" || !/^\d+$/.test(d.openingBuyUsd)) return bad('openingBuyUsd must be whole dollars as digits in quotes ("0" for none).');
  if (typeof d.launchFeeWei !== "string" || !/^\d+$/.test(d.launchFeeWei)) return bad("launchFeeWei must be Pons' launch fee in wei, as digits in quotes.");
  return {
    ok: true,
    file: { name: s.name, symbol: s.symbol, logo: s.logo, description: s.description, website: s.website, twitter: s.twitter, launchFeeWei: BigInt(d.launchFeeWei), openingBuyUsd: d.openingBuyUsd },
  };
}

/**
 * PUSHD_LAUNCH_OPENING_BUY_WEI: whole wei, digits only, above zero. Anything else is not set: the page then says so
 * and offers no button. No commas, no decimals, no "0.01": a typo must never become an amount.
 */
export function openingBuyFromEnv(env: Record<string, string | undefined> = process.env): bigint | null {
  const v = env.PUSHD_LAUNCH_OPENING_BUY_WEI;
  if (typeof v !== "string" || !/^\d{1,30}$/.test(v)) return null;
  const wei = BigInt(v);
  return wei > BigInt(0) ? wei : null;
}

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
const ZERO_BYTES32 = `0x${"0".repeat(64)}` as Hex;

/** The TokenParams LaunchToken.s.sol fills in, field by field. */
export function tokenParams(file: LaunchFile, economics: Hex) {
  return {
    name: file.name,
    symbol: file.symbol,
    logo: file.logo,
    description: file.description,
    socials: { twitter: file.twitter, telegram: "", discord: "", website: file.website, farcaster: "" },
    creatorFeeRecipient: ZERO_ADDRESS as Address,
    creatorTaxBps: 0,
    buybackEnabled: false,
    expectedEconomics: economics,
    salt: keccak256(toBytes(file.symbol)),
  };
}

export type LaunchTx = { to: Address; data: Hex; value: bigint };

/** The launch call: to the burn pot, launch(params, 0, []), value = fee + opening buy. */
export function buildLaunchTx(pot: string, file: LaunchFile, economics: Hex, fee: bigint, openingBuy: bigint): LaunchTx {
  if (!/^0x[0-9a-fA-F]{64}$/.test(economics) || economics.toLowerCase() === ZERO_BYTES32) throw new Error("Pons' launch terms were not read.");
  const data = encodeFunctionData({ abi: LAUNCH_POT_ABI, functionName: "launch", args: [tokenParams(file, economics), LAUNCH_CONFIG_ID, []] });
  const tx = { to: pot as Address, data, value: fee + openingBuy };
  // Read back what was just written, so a slip in the encoding can never leave this function.
  const back = decodeFunctionData({ abi: LAUNCH_POT_ABI, data });
  const [p, config, exempt] = back.args as unknown as [ReturnType<typeof tokenParams>, bigint, readonly string[]];
  const want = tokenParams(file, economics);
  const same =
    back.functionName === "launch" &&
    config === LAUNCH_CONFIG_ID &&
    exempt.length === 0 &&
    p.name === want.name &&
    p.symbol === want.symbol &&
    p.logo === want.logo &&
    p.description === want.description &&
    p.socials.twitter === want.socials.twitter &&
    p.socials.website === want.socials.website &&
    p.socials.telegram === "" &&
    p.socials.discord === "" &&
    p.socials.farcaster === "" &&
    p.creatorFeeRecipient.toLowerCase() === ZERO_ADDRESS &&
    p.creatorTaxBps === 0 &&
    p.buybackEnabled === false &&
    p.expectedEconomics.toLowerCase() === economics.toLowerCase() &&
    p.salt === want.salt;
  if (!same) throw new Error("The launch call did not read back as built.");
  return tx;
}

export const hex = (v: bigint): Hex => `0x${v.toString(16)}`;
