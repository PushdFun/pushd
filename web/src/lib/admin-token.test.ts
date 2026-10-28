import { describe, expect, it } from "vitest";
import { adminCookieOk, adminKeyOk, adminToken, sameText } from "./admin-token";

describe("the admin lock", () => {
  it("never puts the secret in the cookie", () => {
    const t = adminToken("s3cret-key-for-test");
    expect(t).not.toContain("s3cret");
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(adminToken("s3cret-key-for-test")).toBe(t);
    expect(adminToken("another")).not.toBe(t);
  });
  it("accepts only the matching cookie and key", () => {
    const secret = "s3cret-key-for-test";
    expect(adminCookieOk(adminToken(secret), secret)).toBe(true);
    expect(adminCookieOk(adminToken("other"), secret)).toBe(false);
    expect(adminCookieOk("", secret)).toBe(false);
    expect(adminKeyOk(secret, secret)).toBe(true);
    expect(adminKeyOk("s3cret-key-for-tesT", secret)).toBe(false);
    expect(adminKeyOk(42, secret)).toBe(false);
  });
  it("is closed without a secret", () => {
    expect(adminCookieOk(adminToken(""), "")).toBe(false);
    expect(adminCookieOk("anything", null)).toBe(false);
    expect(adminKeyOk("", "")).toBe(false);
  });
  it("compares texts of different lengths safely", () => {
    expect(sameText("abc", "abc")).toBe(true);
    expect(sameText("abc", "abcd")).toBe(false);
  });
});
