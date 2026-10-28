import "server-only";
import { cookies } from "next/headers";
import { adminCookieOk } from "./admin-token";

// The admin page's lock: PUSHD_ADMIN_KEY in this site's environment (the engine has the same key). It never reaches a
// browser: the page asks for it once, the server compares it, and the cookie holds only an HMAC of a fixed string.

export const ADMIN_COOKIE = "pushd_admin";

export const adminSecret = () => process.env.PUSHD_ADMIN_KEY?.trim() || null;

/** Is this request signed in to the admin page? */
export async function isAdmin(): Promise<boolean> {
  const secret = adminSecret();
  if (!secret) return false;
  return adminCookieOk((await cookies()).get(ADMIN_COOKIE)?.value, secret);
}
