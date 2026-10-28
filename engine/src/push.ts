// Alerts with PUSHD closed: web push for signed-in holders. A holder's browser subscribes (its push service gives an
// endpoint and two keys), and the API process follows new lines as they are stored (no delay, like the holder's live
// stream) and sends a short notification to every subscribed holder whose own choices match: their alert heat, their
// "only my list" switch, their muted builders. The same rule the open site uses (web/src/components/HolderLive.tsx).
//
//   - Only while the wallet still holds $PUSHD at the threshold (the holders service's cached balance check).
//   - At most PUSH_PER_HOUR notifications a holder an hour; at most MAX_SUBS devices a holder.
//   - A subscription the push service says is gone (404 or 410) is dropped; one that fails 5 times in a row too.
//   - Off unless the VAPID keys are set (PUSHD_VAPID_PUBLIC_KEY, PUSHD_VAPID_PRIVATE_KEY, PUSHD_VAPID_SUBJECT): then the
//     routes answer 409 "not switched on yet" and nothing is followed or sent.
// What is sent: the line's handle, what happened, the repo, the heat and the plain line. Nothing about the holder.
import webpush from "web-push";
import { HEAT_RANK, itemsAfterSeq, type DB, type StoredItem } from "./db.ts";
import { HolderError, type HolderPrefs } from "./token/holders.ts";

export const PUSH_PER_HOUR = 20;
export const MAX_SUBS = 5;
const MAX_FAILS = 5;
const HOUR = 3_600_000;

export type PushSub = { endpoint: string; keys: { p256dh: string; auth: string } };
export type PushConfig = { publicKey: string; privateKey: string; subject: string };
/** Sends one payload to one subscription; answers the push service's status (201 is fine, 404/410 gone). */
export type PushSender = (sub: PushSub, payload: string, o: { urgent: boolean }) => Promise<{ status: number }>;

export const PUSH_SCHEMA = `
CREATE TABLE IF NOT EXISTS holder_push (
  endpoint TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_ok_at INTEGER,
  fails INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS holder_push_address ON holder_push(address);
CREATE TABLE IF NOT EXISTS holder_push_sent (address TEXT NOT NULL, at INTEGER NOT NULL);
`;

/** The keys from the environment; null (push off) unless both keys are there and look like VAPID keys. */
export function pushConfigFromEnv(env: Record<string, string | undefined> = process.env): PushConfig | null {
  const publicKey = env.PUSHD_VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.PUSHD_VAPID_PRIVATE_KEY?.trim();
  if (!publicKey || !privateKey) return null;
  if (!/^[A-Za-z0-9_-]{80,100}$/.test(publicKey) || !/^[A-Za-z0-9_-]{40,50}$/.test(privateKey)) return null;
  const subject = env.PUSHD_VAPID_SUBJECT?.trim() || env.PUSHD_SITE_URL?.trim() || "https://pushd.fun";
  if (!/^(mailto:|https:\/\/)/.test(subject)) return null;
  return { publicKey, privateKey, subject };
}

/** A subscription as the browser gives it, checked: an https endpoint, two base64url keys, nothing big. */
export function readSub(input: unknown): PushSub {
  const bad = () => new HolderError(400, "That push subscription is not valid.");
  if (!input || typeof input !== "object") throw bad();
  const i = input as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (typeof i.endpoint !== "string" || i.endpoint.length > 1000) throw bad();
  let u: URL;
  try {
    u = new URL(i.endpoint);
  } catch {
    throw bad();
  }
  if (u.protocol !== "https:" || u.username || u.password) throw bad();
  const k = i.keys;
  if (!k || typeof k.p256dh !== "string" || typeof k.auth !== "string") throw bad();
  if (!/^[A-Za-z0-9_-]{60,120}=*$/.test(k.p256dh) || !/^[A-Za-z0-9_-]{16,40}=*$/.test(k.auth)) throw bad();
  return { endpoint: i.endpoint, keys: { p256dh: k.p256dh, auth: k.auth } };
}

/** Does a holder want an alert for this line? The open site's rule (HolderLive). */
export function wants(prefs: HolderPrefs, it: Pick<StoredItem, "handle" | "heat">): boolean {
  if (prefs.alertHeat === "off") return false;
  if (prefs.mute.includes(it.handle)) return false;
  if (HEAT_RANK[it.heat] < HEAT_RANK[prefs.alertHeat]) return false;
  if (prefs.alertMine && !prefs.follow.includes(it.handle)) return false;
  return true;
}

const VERB: Record<string, string> = { repo: "created", push: "pushed", release: "released", gist: "posted" };
const HEAT_WORD: Record<string, string> = { low: "Low", medium: "Medium", high: "High", veryHigh: "Very high" };

/** The notification for a line: what the service worker shows (web/public/sw.js). */
export function payloadFor(it: Pick<StoredItem, "id" | "handle" | "kind" | "repo" | "version" | "heat" | "summary">): string {
  return JSON.stringify({
    id: it.id,
    title: `${it.handle} ${VERB[it.kind] ?? "pushed"} ${it.repo}${it.version ? ` ${it.version}` : ""}`,
    body: `${HEAT_WORD[it.heat] ?? "New"} heat. ${it.summary}`.slice(0, 240),
    url: `/feed/${encodeURIComponent(it.id)}`,
    tag: `pushd-${it.id}`,
  });
}

/** The real sender: the web-push library, signed with the VAPID keys. */
export function webPushSender(c: PushConfig): PushSender {
  return async (sub, payload, o) => {
    try {
      const r = await webpush.sendNotification(sub, payload, {
        vapidDetails: { subject: c.subject, publicKey: c.publicKey, privateKey: c.privateKey },
        TTL: 3600,
        urgency: o.urgent ? "high" : "normal",
        timeout: 15_000,
      });
      return { status: r.statusCode };
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode;
      return { status: typeof status === "number" ? status : 0 };
    }
  };
}

export type PushDeps = {
  db: DB;
  config: PushConfig | null;
  /** the holders service: prefs and the cached balance check */
  holders: { prefs(address: string): HolderPrefs; status(address: string): Promise<{ holder: boolean }> } | null;
  sender?: PushSender;
  perHour?: number;
  now?: () => number;
  log?: (msg: string) => void;
};

export class Push {
  private readonly sender: PushSender | null;
  private cursor = 0;
  sent = 0;

  constructor(private readonly d: PushDeps) {
    d.db.exec(PUSH_SCHEMA);
    this.sender = d.config ? (d.sender ?? webPushSender(d.config)) : null;
  }

  private now = () => (this.d.now ?? Date.now)();
  get on(): boolean {
    return !!this.d.config && !!this.d.holders;
  }

  private off(): never {
    throw new HolderError(409, "Alerts with PUSHD closed are not switched on yet.");
  }

  /** The VAPID public key a browser subscribes with. */
  key(): string {
    if (!this.on) this.off();
    return this.d.config!.publicKey;
  }

  /** Saves a device for a holder (at most MAX_SUBS; the oldest goes). */
  subscribe(address: string, input: unknown): { ok: true; devices: number } {
    if (!this.on) this.off();
    const sub = readSub(input);
    const a = address.toLowerCase();
    const db = this.d.db;
    db.prepare(
      "INSERT INTO holder_push (endpoint, address, p256dh, auth, created_at, fails) VALUES (?, ?, ?, ?, ?, 0) ON CONFLICT(endpoint) DO UPDATE SET address = excluded.address, p256dh = excluded.p256dh, auth = excluded.auth, fails = 0",
    ).run(sub.endpoint, a, sub.keys.p256dh, sub.keys.auth, this.now());
    const rows = db.prepare("SELECT endpoint FROM holder_push WHERE address = ? ORDER BY created_at DESC").all(a) as { endpoint: string }[];
    for (const r of rows.slice(MAX_SUBS)) db.prepare("DELETE FROM holder_push WHERE endpoint = ?").run(r.endpoint);
    return { ok: true, devices: Math.min(rows.length, MAX_SUBS) };
  }

  /** Forgets one device (by its endpoint), or every device of the holder. */
  unsubscribe(address: string, endpoint?: unknown): { ok: true } {
    const a = address.toLowerCase();
    if (typeof endpoint === "string" && endpoint) this.d.db.prepare("DELETE FROM holder_push WHERE address = ? AND endpoint = ?").run(a, endpoint);
    else this.d.db.prepare("DELETE FROM holder_push WHERE address = ?").run(a);
    return { ok: true };
  }

  devices(address: string): number {
    return (this.d.db.prepare("SELECT count(*) AS n FROM holder_push WHERE address = ?").get(address.toLowerCase()) as { n: number }).n;
  }

  private sentInHour(a: string): number {
    this.d.db.prepare("DELETE FROM holder_push_sent WHERE at <= ?").run(this.now() - HOUR);
    return (this.d.db.prepare("SELECT count(*) AS n FROM holder_push_sent WHERE address = ?").get(a) as { n: number }).n;
  }

  /** Sends one line to every subscribed holder who wants it. Returns how many notifications went out. */
  async deliver(it: StoredItem): Promise<number> {
    if (!this.on || !this.sender) return 0;
    const addresses = (this.d.db.prepare("SELECT DISTINCT address FROM holder_push ORDER BY address").all() as { address: string }[]).map((r) => r.address);
    const payload = payloadFor(it);
    const urgent = HEAT_RANK[it.heat] >= HEAT_RANK.high;
    let n = 0;
    for (const address of addresses) {
      if (!wants(this.d.holders!.prefs(address), it)) continue;
      n += await this.sendTo(address, payload, urgent);
    }
    this.sent += n;
    return n;
  }

  /**
   * One notification to every device of one holder: only while the wallet holds at the threshold, and at most
   * PUSH_PER_HOUR an hour. The holder's own scouts send their hits through here (src/scouts/myscouts.ts).
   */
  async sendTo(address: string, payload: string, urgent: boolean): Promise<number> {
    if (!this.on || !this.sender) return 0;
    const db = this.d.db;
    const a = address.toLowerCase();
    const list = db.prepare("SELECT endpoint, p256dh, auth, fails FROM holder_push WHERE address = ?").all(a) as { endpoint: string; p256dh: string; auth: string; fails: number }[];
    if (!list.length) return 0;
    if (this.sentInHour(a) >= (this.d.perHour ?? PUSH_PER_HOUR)) return 0;
    const holder = await this.d.holders!.status(a).then(
      (st) => st.holder,
      () => false,
    );
    if (!holder) return 0;
    db.prepare("INSERT INTO holder_push_sent (address, at) VALUES (?, ?)").run(a, this.now());
    let n = 0;
    for (const s of list) {
      const { status } = await this.sender({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { urgent });
      if (status >= 200 && status < 300) {
        db.prepare("UPDATE holder_push SET last_ok_at = ?, fails = 0 WHERE endpoint = ?").run(this.now(), s.endpoint);
        n++;
      } else if (status === 404 || status === 410 || s.fails + 1 >= MAX_FAILS) {
        db.prepare("DELETE FROM holder_push WHERE endpoint = ?").run(s.endpoint);
      } else db.prepare("UPDATE holder_push SET fails = fails + 1 WHERE endpoint = ?").run(s.endpoint);
    }
    return n;
  }

  /** One look for lines stored since the last look; each is delivered once, in the order stored. */
  async tick(): Promise<number> {
    let n = 0;
    const nowIso = new Date(this.now()).toISOString();
    for (const it of itemsAfterSeq(this.d.db, this.cursor)) {
      if (it.shownAt > nowIso) break;
      this.cursor = it.seq;
      // a line seen on the watcher's first look happened a while ago: never an alert
      if (it.backfill) continue;
      n += await this.deliver(it);
    }
    return n;
  }

  /** Follows new lines every few seconds, starting after the newest stored now (no old alerts after a restart). */
  start(everyMs = 3_000): () => void {
    if (!this.on) return () => undefined;
    this.cursor = (this.d.db.prepare("SELECT coalesce(max(seq), 0) AS s FROM items").get() as { s: number }).s;
    let busy = false;
    const t = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        await this.tick();
      } catch (e) {
        this.d.log?.(`push: ${(e as Error).message}`);
      } finally {
        busy = false;
      }
    }, everyMs);
    t.unref?.();
    this.d.log?.("push alerts on");
    return () => clearInterval(t);
  }

  /** For the tests: start following from a sequence number. */
  from(seq: number) {
    this.cursor = seq;
  }
}
