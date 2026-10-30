// The key check, and the mask every agent's words go through. A push's added lines are read for credentials (cloud
// keys, API keys, private keys, tokens of the big services, key-like assignments); a finding is reported to the owner
// with the credential masked: its first four characters and stars, never more. The same masking runs over everything an
// agent stores, shows, comments or opens a pull request with, so a key read from a repo is never repeated in full.
// Patterns only: no model sees a finding.

export type SecretKind =
  | "AWS access key"
  | "GitHub token"
  | "Slack token"
  | "Stripe live key"
  | "OpenAI key"
  | "Anthropic key"
  | "OpenRouter key"
  | "Google API key"
  | "private key block"
  | "wallet private key"
  | "key-like value";

const PATTERNS: { kind: SecretKind; re: RegExp; group?: number }[] = [
  { kind: "private key block", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g },
  { kind: "AWS access key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "GitHub token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/g },
  { kind: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: "Stripe live key", re: /\b(?:sk|rk)_live_[0-9A-Za-z]{20,}\b/g },
  { kind: "Anthropic key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { kind: "OpenRouter key", re: /\bsk-or-v1-[a-f0-9]{48,}\b/g },
  { kind: "OpenAI key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/g },
  { kind: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  // a 32-byte hex value is also a transaction hash: only with a key-like name beside it
  { kind: "wallet private key", re: /\b(?:private[_-]?key|priv[_-]?key|PRIVATE_KEY|PK|DEPLOYER_KEY|WALLET_KEY|MNEMONIC_KEY)\b["']?\s*[:=]\s*["']?((?:0x)?[0-9a-fA-F]{64})\b/g, group: 1 },
  { kind: "key-like value", re: /\b(?:api[_-]?key|apikey|secret[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token|password|passwd)\b["']?\s*[:=]\s*["']([^"'\s]{16,200})["']/gi, group: 1 },
];

/** A credential as it may be shown: its first four characters, then stars. */
export function maskValue(v: string): string {
  return `${v.slice(0, 4)}${"*".repeat(Math.max(4, Math.min(12, v.length - 4)))}`;
}

/** Text with every credential the patterns know masked. Safe to call on anything; idempotent. */
export function maskSecrets(text: string): string {
  let s = text;
  for (const p of PATTERNS) {
    s = s.replace(p.re, (m: string, ...groups: unknown[]) => {
      if (p.kind === "private key block") return "[a private key was here]";
      const inner = p.group ? (groups[p.group - 1] as string | undefined) : undefined;
      return inner ? m.replace(inner, maskValue(inner)) : maskValue(m);
    });
  }
  return s;
}

export type Finding = { file: string; line: number | null; kind: SecretKind; masked: string };

/** Credentials in plain text, masked, with the line they are on. */
export function findSecrets(text: string, file = ""): Finding[] {
  const out: Finding[] = [];
  const lines = text.split("\n");
  lines.forEach((l, i) => {
    for (const p of PATTERNS) {
      p.re.lastIndex = 0;
      for (const m of l.matchAll(p.re)) {
        const v = p.group ? m[p.group] : m[0];
        if (!v) continue;
        // a placeholder is not a credential
        // (a whole value of x or 0, or one starting with a placeholder word; a 0x key starts with 0 and is real)
        const bare = v.replace(/^0x/i, "");
        if (/^(x+|0+)$/i.test(bare) || /^(your|changeme|example|placeholder|dummy|test|xxx)/i.test(bare) || /\$\{|process\.env|<[^>]+>/.test(v)) continue;
        out.push({ file, line: i + 1, kind: p.kind, masked: p.kind === "private key block" ? "[private key]" : maskValue(v) });
      }
    }
  });
  return out;
}

/** The credentials in a push's added lines (a compare's patches). The line number is the new file's. */
export function scanPatches(files: { filename: string; patch?: string | null }[]): Finding[] {
  const out: Finding[] = [];
  for (const f of files) {
    if (!f.patch) continue;
    let line = 0;
    for (const raw of f.patch.split("\n")) {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (hunk) {
        line = Number(hunk[1]) - 1;
        continue;
      }
      if (raw.startsWith("-")) continue;
      line++;
      if (!raw.startsWith("+")) continue;
      for (const x of findSecrets(raw.slice(1), f.filename)) out.push({ ...x, line });
    }
  }
  // one finding per file, line and kind
  const seen = new Set<string>();
  return out.filter((x) => {
    const k = `${x.file}:${x.line}:${x.kind}`;
    return seen.has(k) ? false : (seen.add(k), true);
  });
}
