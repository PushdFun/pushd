// Small formatting helpers, all in UTC so the server and the browser agree.

const pad = (n: number) => String(n).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "6m", "1h", "3d": how long before `asOf` a thing happened. */
export function ago(at: string, asOf: string): string {
  const min = Math.max(0, Math.floor((Date.parse(asOf) - Date.parse(at)) / 60_000));
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** "14:12:09" */
export function utcTime(at: string): string {
  const d = new Date(at);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/** "27 Oct 2026" */
export function utcDate(at: string): string {
  const d = new Date(at);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "+0:38": how long after `from` the thing at `to` came, in minutes and seconds ("+14h 02m" past an hour). */
export function after(from: string, to: string): string {
  const s = Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000));
  if (s >= 3600) return `+${Math.floor(s / 3600)}h ${pad(Math.floor((s % 3600) / 60))}m`;
  return `+${Math.floor(s / 60)}:${pad(s % 60)}`;
}

/** A handle without the sample "@": the builder's address on the site (/builders/kaiwren). */
export const bare = (handle: string) => handle.replace(/^@/, "");
export const builderHref = (handle: string) => `/builders/${encodeURIComponent(bare(handle))}`;

/** 1,234 */
export const num = (n: number) => n.toLocaleString("en-US");

/** "27 Oct" */
export function shortDate(at: string): string {
  const d = new Date(at);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** "Mon" for a day key (2026-10-27) */
export function weekday(day: string): string {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(day + "T00:00:00Z").getUTCDay()];
}

/** "2h ago", "3d ago", "just now": how long before `asOf`. */
export function agoWords(at: string, asOf: string): string {
  const a = ago(at, asOf);
  return a === "0m" ? "just now" : `${a} ago`;
}

/** "14:00" for an hour of the day */
export const hourLabel = (h: number) => `${pad(h)}:00`;
