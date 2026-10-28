import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { HOLDER_COOKIE, HOLDER_HINT, engineUrl } from "./data";

// The holder routes (src/app/api/holder/*) all pass through to the engine, which does the checking: the signed
// message, the nonce, the balance on the chain. This site only carries the session in an httpOnly cookie, so
// no script on the page can read it, and refuses a write from another site.

const SESSION_RE = /^[A-Za-z0-9_-]{20,100}$/;

export const closed = () => NextResponse.json({ error: "Holder sign-in opens at launch, once $PUSHD exists." }, { status: 409 });

/** A write must come from this site: an Origin, when the browser sends one, must be this host. */
export function sameSite(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === (req.headers.get("x-forwarded-host") ?? req.headers.get("host"));
  } catch {
    return false;
  }
}

export function sessionOf(req: NextRequest): string | null {
  const v = req.cookies.get(HOLDER_COOKIE)?.value ?? "";
  return SESSION_RE.test(v) ? v : null;
}

/** A JSON body of at most 4 KB, or null. */
export async function smallJson(req: NextRequest): Promise<Record<string, unknown> | null> {
  const text = await req.text().catch(() => "");
  if (text.length > 4096) return null;
  try {
    const v = JSON.parse(text || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** One call to the engine; its answer passed on as it is, or 503 when it is silent. */
/** The visitor's address as this site was told it, for the engine's per-visitor limits. */
export function ipOf(req: NextRequest): string | null {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip")?.trim() || "";
  return ip ? ip.slice(0, 64) : null;
}

export async function toEngine(path: string, init: { method: string; body?: unknown; session?: string | null; ip?: string | null; timeoutMs?: number }): Promise<{ status: number; body: Record<string, unknown> }> {
  try {
    const res = await fetch(engineUrl() + path, {
      method: init.method,
      cache: "no-store",
      signal: AbortSignal.timeout(init.timeoutMs ?? 15_000),
      headers: {
        accept: "application/json",
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(init.session ? { authorization: `Bearer ${init.session}` } : {}),
        ...(init.ip ? { "x-forwarded-for": init.ip } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    if (res.status === 204) return { status: 204, body: {} };
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, body };
  } catch {
    return { status: 503, body: { error: "PUSHD's server did not answer. Try again in a minute." } };
  }
}

const secure = () => process.env.NODE_ENV === "production";

export function setSession(res: NextResponse, session: string, expiresAt: number) {
  const expires = new Date(expiresAt);
  res.cookies.set(HOLDER_COOKIE, session, { httpOnly: true, secure: secure(), sameSite: "lax", path: "/", expires });
  // no secret in it: it only lets the page know a sign-in exists, so it asks for nothing otherwise
  res.cookies.set(HOLDER_HINT, "1", { httpOnly: false, secure: secure(), sameSite: "lax", path: "/", expires });
}

export function clearSession(res: NextResponse) {
  res.cookies.set(HOLDER_COOKIE, "", { httpOnly: true, secure: secure(), sameSite: "lax", path: "/", maxAge: 0 });
  res.cookies.set(HOLDER_HINT, "", { httpOnly: false, secure: secure(), sameSite: "lax", path: "/", maxAge: 0 });
}

export const noStore = { "cache-control": "no-store" };
