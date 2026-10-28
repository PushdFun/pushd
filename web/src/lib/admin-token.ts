import { createHmac, timingSafeEqual } from "node:crypto";

// The admin cookie: never the secret itself, only an HMAC of a fixed string keyed by it. Whoever holds the cookie can
// use the admin page on this site; nobody can get the secret back from it, and changing the secret signs everyone out.

const PURPOSE = "pushd admin session v1";

/** The cookie's value for a secret. */
export function adminToken(secret: string): string {
  return createHmac("sha256", secret).update(PURPOSE).digest("base64url");
}

/** Constant-time compare of two strings (false for different lengths, without a short cut on the content). */
export function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  if (x.length !== y.length) {
    timingSafeEqual(x, x);
    return false;
  }
  return timingSafeEqual(x, y);
}

/** Does this cookie value belong to this secret? Never true without a secret. */
export function adminCookieOk(cookie: string | null | undefined, secret: string | null | undefined): boolean {
  if (!secret || !cookie) return false;
  return sameText(cookie, adminToken(secret));
}

/** Is the typed key the secret? Never true without a secret. */
export function adminKeyOk(given: unknown, secret: string | null | undefined): boolean {
  if (!secret || typeof given !== "string" || !given) return false;
  return sameText(given, secret);
}
