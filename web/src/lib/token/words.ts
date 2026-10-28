/**
 * $PUSHD amounts and times in plain words for screens. Client-safe.
 * Amounts arrive as exact decimal strings in their smallest unit and are only
 * turned into words here; no arithmetic happens on the words.
 */

const TEN18 = BigInt("1000000000000000000");

/** Whole units with grouping, rounded down: "3,500,000". Fractions under one show as "less than 1". */
export function wholeWords(atomic: string | bigint, decimals = 18): string {
  const v = BigInt(atomic);
  const base = BigInt(10) ** BigInt(decimals);
  const whole = v / base;
  if (whole === BigInt(0) && v > BigInt(0)) return "less than 1";
  return whole.toLocaleString("en-US");
}

/** A short form for big numbers: 1,250,000,000 as "1.25B", 3,500,000 as "3.5M", rounded down. */
export function shortWords(atomic: string | bigint, decimals = 18): string {
  const whole = BigInt(atomic) / BigInt(10) ** BigInt(decimals);
  const steps: [bigint, string][] = [
    [BigInt(1_000_000_000), "B"],
    [BigInt(1_000_000), "M"],
    [BigInt(1_000), "K"],
  ];
  for (const [n, s] of steps) {
    if (whole >= n) {
      const hundredths = (whole * BigInt(100)) / n;
      const int = hundredths / BigInt(100);
      const frac = (hundredths % BigInt(100)).toString().padStart(2, "0").replace(/0+$/, "");
      return `${int.toLocaleString("en-US")}${frac ? `.${frac}` : ""}${s}`;
    }
  }
  return wholeWords(atomic, decimals);
}

/** ETH from wei with up to `places` decimals, rounded down, trailing zeros dropped: "0.0182". */
export function ethWords(wei: string | bigint, places = 6): string {
  const v = BigInt(wei);
  const whole = v / TEN18;
  const frac = (v % TEN18).toString().padStart(18, "0").slice(0, places).replace(/0+$/, "");
  if (whole === BigInt(0) && !frac && v > BigInt(0)) return `under 0.${"0".repeat(places - 1)}1`;
  return `${whole.toLocaleString("en-US")}${frac ? `.${frac}` : ""}`;
}

/** The share of `part` in `whole` as a percentage with two decimals, rounded down: "0.35%". */
export function percentWords(part: string | bigint, whole: string | bigint): string {
  const w = BigInt(whole);
  if (w <= BigInt(0)) return "0%";
  const bp = (BigInt(part) * BigInt(10_000)) / w;
  const int = bp / BigInt(100);
  const frac = (bp % BigInt(100)).toString().padStart(2, "0");
  return `${int}.${frac}%`;
}

/** "0x6717...dFdc" */
export function shortAddress(v: string, head = 6, tail = 4): string {
  return v.length > head + tail + 3 ? `${v.slice(0, head)}...${v.slice(-tail)}` : v;
}

/** "in 14 minutes", "in 2 hours", "now", from milliseconds. */
export function untilWords(at: number, now: number): string {
  const s = Math.round((at - now) / 1000);
  if (s <= 30) return "now";
  const m = Math.round(s / 60);
  if (m < 60) return `in ${m} minute${m === 1 ? "" : "s"}`;
  const h = Math.round(m / 60);
  if (h < 48) return `in about ${h} hour${h === 1 ? "" : "s"}`;
  return `in about ${Math.round(h / 24)} days`;
}

/** "22 Oct, 14:05 UTC" */
export function utcWords(ms: number): string {
  const d = new Date(ms);
  return `${d.toLocaleString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })}, ${d.toLocaleString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC`;
}

/** ETH from wei with every digit that matters, nothing rounded: "0.007468421052631578". */
export function ethExact(wei: string | bigint): string {
  const v = BigInt(wei);
  const frac = (v % TEN18).toString().padStart(18, "0").replace(/0+$/, "");
  return `${(v / TEN18).toLocaleString("en-US")}${frac ? `.${frac}` : ""}`;
}

/** ETH from wei rounded UP to `places` decimals, for an amount that is missing: never says less than is needed. */
export function ethUpWords(wei: string | bigint, places = 6): string {
  const step = BigInt(10) ** BigInt(18 - places);
  const v = BigInt(wei);
  return ethWords(((v + step - BigInt(1)) / step) * step, places);
}

/** Dollars for an amount of wei at an ETH price with 8 decimals, to the cent, rounded down: "$30.00". */
export function usdWords(wei: string | bigint, ethUsd8: string | bigint): string {
  const cents = (BigInt(wei) * BigInt(ethUsd8)) / BigInt("1000000000000000000000000");
  return `$${(cents / BigInt(100)).toLocaleString("en-US")}.${(cents % BigInt(100)).toString().padStart(2, "0")}`;
}
