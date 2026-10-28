// The one plain line. Written only from what is in the repo (name, description, README's first lines, topics, files).
// With PUSHD_OPENROUTER_KEY set, a cheap model writes it and every call's cost is logged; otherwise, and whenever the
// model's line fails the checks, a deterministic fallback takes it from the description or the README's first sentence.
import type { Candidate, RepoInfo } from "./types.ts";

export const MAX_LEN = 119;

export type SummaryInput = { candidate: Candidate; repo: RepoInfo | null };
export type Summary = { text: string; source: "ai" | "fallback" };
export type CostEntry = { at: string; provider: string; model: string; inputTokens: number; outputTokens: number; usd: number; ref: string };

const DASHES = /\s*[‒–—―−]\s*/g;
const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu;

/** Markdown and HTML out, dashes out, one line, a capital, a full stop, and under 120 characters. */
export function cleanLine(raw: string): string {
  let s = raw
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/`+/g, "")
    .replace(/(\*\*|__|\*|~~)/g, "")
    .replace(/^[#>\-*+\s]+/, "")
    .replace(/:[a-z0-9_+-]+:/g, " ")
    .replace(EMOJI, " ")
    .replace(DASHES, ", ")
    .replace(/\s+-{1,2}\s+/g, ", ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/,\s*,/g, ",")
    .trim()
    .replace(/^[,;:\s]+|[,;:\s]+$/g, "");
  if (!s) return "";
  if (/^[a-z]/.test(s) && !/^[a-z]+[A-Z0-9_.]/.test(s)) s = s[0].toUpperCase() + s.slice(1);
  if (!/[.!?]$/.test(s)) s += ".";
  if (s.length > MAX_LEN) {
    const cut = s.slice(0, MAX_LEN - 3);
    const at = cut.lastIndexOf(" ");
    s = (at > 40 ? cut.slice(0, at) : cut).replace(/[,;:.\s]+$/, "") + "...";
  }
  return s;
}

/** The README's first real sentence: past the title, badges, pictures, tables and code. */
export function readmeFirstSentence(readme: string | null, repoName: string): string | null {
  if (!readme) return null;
  const lines = readme.split(/\r?\n/);
  const para: string[] = [];
  let fence = false;
  const nameish = repoName.toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const line of lines) {
    const t = line.trim();
    if (/^(```|~~~)/.test(t)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const skip =
      t === "" ||
      /^#{1,6}\s/.test(t) ||
      /^(\[!\[|!\[|<img|<p|<\/p|<div|<\/div|<a |<\/a|<h\d|<\/h\d|<br|<picture|<\/picture|<source|\|)/i.test(t) ||
      /^(-{3,}|\*{3,}|_{3,}|={3,})$/.test(t) ||
      /^\[[^\]]*\]\([^)]*\)$/.test(t) ||
      t.toLowerCase().replace(/[^a-z0-9]/g, "") === nameish;
    if (skip) {
      if (para.length) break;
      continue;
    }
    para.push(t);
  }
  const text = cleanLine(para.join(" "));
  if (!text || text.length < 12) return null;
  const m = text.match(/^(.{12,}?[.!?])(\s|$)/);
  return cleanLine(m ? m[1] : text);
}

const article = (word: string) => (/^[aeiou]/i.test(word) ? "An" : "A");

/** What a repo is, from its own words; null when it says nothing about itself. */
function repoLine(repo: RepoInfo | null, name: string): string | null {
  if (repo?.description) {
    const d = cleanLine(repo.description);
    if (d.length >= 6) return d;
  }
  return readmeFirstSentence(repo?.readme ?? null, name);
}

/** When there is nothing to go on: say plainly what kind of thing it is. */
function plainKind(c: Candidate, repo: RepoInfo | null): string {
  const lang = repo?.language;
  const lead = c.sub === "made-public" ? (lang ? `${article(lang)} ${lang} repo just made public` : "A repo just made public") : lang ? `A new ${lang} repo` : "A new repo";
  if (repo?.files && repo.files.length > 0) {
    const n = repo.files.length;
    return cleanLine(`${lead} with no description yet, ${n} ${n === 1 ? "file" : "files and folders"} at the top`);
  }
  return cleanLine(`${lead} with no description or README yet`);
}

/** The deterministic line. Never invents: every word comes from the repo, or says what kind of thing it is. */
export function fallbackSummary({ candidate: c, repo }: SummaryInput): string {
  switch (c.sub) {
    case "new-repo":
    case "made-public":
      return repoLine(repo, c.repo) ?? plainKind(c, repo);
    case "release": {
      const line = repoLine(repo, c.repo);
      if (line) return line;
      const name = c.releaseName && c.releaseName !== c.tag ? cleanLine(c.releaseName) : null;
      return name && name.length > 8 ? name : cleanLine(`Release ${c.tag ?? ""} of ${c.repo}`);
    }
    case "push": {
      const line = repoLine(repo, c.repo);
      if (line) return line;
      const msg = c.commits?.[0]?.split("\n")[0];
      if (msg) return cleanLine(`New commits, the latest says: "${msg}"`);
      return cleanLine(`New commits on the ${c.ref?.replace(/^refs\/heads\//, "") ?? "main"} branch of ${c.repo}`);
    }
    case "gist": {
      if (c.gistDescription && cleanLine(c.gistDescription).length >= 6) return cleanLine(c.gistDescription);
      const files = c.gistFiles ?? [];
      const first = c.gistFirstLine?.trim();
      if (files.length === 1 && first && first.length <= 60) return cleanLine(`A public gist with one line: "${first}"`);
      if (files.length === 1) return cleanLine(`A public gist with one file, ${files[0]}`);
      return cleanLine(`A public gist with ${files.length} files: ${files.slice(0, 3).join(", ")}`);
    }
  }
}

/** Everything the model may use, and nothing else. */
export function facts({ candidate: c, repo }: SummaryInput) {
  return {
    kind: c.sub,
    name: c.repo,
    tag: c.tag,
    releaseName: c.releaseName,
    description: repo?.description ?? c.gistDescription ?? null,
    topics: repo?.topics ?? [],
    language: repo?.language ?? null,
    readmeFirstLines: repo?.readme?.split(/\r?\n/).slice(0, 40).join("\n").slice(0, 1500) ?? null,
    files: repo?.files?.slice(0, 40) ?? c.gistFiles ?? null,
    gistFirstLine: c.gistFirstLine ?? null,
    latestCommit: c.commits?.[0]?.split("\n")[0] ?? null,
  };
}

const SYSTEM = [
  "You write one plain line saying what a GitHub repo, release, push or gist is.",
  "Use only the facts given. Never add a claim, a number, a name or a purpose that is not in them.",
  "If the facts say little, say plainly what kind of thing it is (for example: A new Rust repo with no description yet).",
  "Plain words, no hype, no prices, no advice, no emojis, no dashes of any kind between words, no quotes around the line.",
  "At most 110 characters. Answer with the line only.",
].join(" ");

/** A model's line passes only if it is short, plain, and every number in it is in the facts. */
export function acceptModelLine(line: string, sourceText: string): string | null {
  const s = cleanLine(line.replace(/^["'\s]+|["'\s]+$/g, ""));
  if (s.length < 8 || s.length > MAX_LEN) return null;
  if (/https?:\/\//i.test(s)) return null;
  for (const n of s.match(/\d+(?:\.\d+)*/g) ?? []) if (!sourceText.includes(n)) return null;
  return s;
}

export type OpenRouterOptions = {
  key: string;
  model?: string;
  fetchImpl?: typeof fetch;
  onCost?: (c: CostEntry) => void;
  ref?: string;
};

export const DEFAULT_MODEL = "google/gemini-2.5-flash-lite";

/** One call to OpenRouter. Returns the line, or null when the call or the line fails (the fallback then writes it). */
export async function openRouterLine(input: SummaryInput, o: OpenRouterOptions): Promise<string | null> {
  const model = o.model || DEFAULT_MODEL;
  const f = facts(input);
  const body = {
    model,
    max_tokens: 200,
    temperature: 0.2,
    usage: { include: true },
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: JSON.stringify(f) },
    ],
  };
  const res = await (o.fetchImpl ?? fetch)("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${o.key}`, "content-type": "application/json", "x-title": "PUSHD" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return null;
  const j = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  };
  o.onCost?.({
    at: new Date().toISOString(),
    provider: "openrouter",
    model,
    inputTokens: j.usage?.prompt_tokens ?? 0,
    outputTokens: j.usage?.completion_tokens ?? 0,
    usd: j.usage?.cost ?? 0,
    ref: o.ref ?? input.candidate.key,
  });
  const text = j.choices?.[0]?.message?.content ?? "";
  return acceptModelLine(text, JSON.stringify(f));
}

/** The line for a candidate: the model when a key is set and its line passes, the fallback otherwise. */
export async function summarize(input: SummaryInput, o: Partial<OpenRouterOptions> = {}): Promise<Summary> {
  if (o.key) {
    try {
      const line = await openRouterLine(input, o as OpenRouterOptions);
      if (line) return { text: line, source: "ai" };
    } catch {
      // the fallback below
    }
  }
  return { text: fallbackSummary(input), source: "fallback" };
}
