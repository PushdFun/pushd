// A pretend model for the scout tests: it answers from a script and records every request, with a made-up cost per
// call. Nothing here calls a network; the engine itself never fakes a model (without a key it writes templates).
import { scoutConfigFromEnv, type ScoutConfig } from "../src/scouts/config.ts";
import { ModelError, type ModelAnswer, type ModelProvider, type ModelRequest } from "../src/scouts/provider.ts";
import type { StoredItem } from "../src/db.ts";

export type Script = (req: ModelRequest, n: number) => string | Error | { text: string; usd?: number | null; inputTokens?: number; outputTokens?: number };

export class FakeModel implements ModelProvider {
  readonly name = "fake";
  requests: ModelRequest[] = [];
  constructor(private readonly script: Script) {}
  async complete(req: ModelRequest): Promise<ModelAnswer> {
    this.requests.push(req);
    const out = this.script(req, this.requests.length);
    if (out instanceof Error) throw out instanceof ModelError ? out : new ModelError(out.message);
    const o = typeof out === "string" ? { text: out } : out;
    return { text: o.text, model: req.model, inputTokens: o.inputTokens ?? 1200, outputTokens: o.outputTokens ?? 90, usd: o.usd === undefined ? 0.0004 : o.usd };
  }
}

/** A valid scout answer as JSON. */
export const answer = (p: Partial<{ line: string; why: string; heat: number; heat_reason: string; verdict: string; what_it_is: string; injection: boolean }> = {}) =>
  JSON.stringify({
    line: "A hardware signer for an old chip.",
    why: "A brand new repo with a retro computing theme. Retro hardware repos from big accounts get shared fast.",
    heat: 8,
    heat_reason: "New repo, retro theme, big account.",
    verdict: "experiment",
    what_it_is: "A spec and a simulation for a breadboard signer, with no released hardware yet.",
    injection: false,
    ...p,
  });

export function scoutConfig(env: Record<string, string> = {}, key: string | null = "test-key"): ScoutConfig {
  // the quality gate is tested on its own (test/credit.test.ts); the older tests call on every line
  return scoutConfigFromEnv({ PUSHD_SCOUT_GAP_MS: "0", PUSHD_SCOUT_MIN_HEAT: "0", PUSHD_SCOUT_DEEP_MIN_HEAT: "0", PUSHD_SCOUT_DEDUPE_HOURS: "0", ...env }, { key });
}

const ago = (now: number, min: number) => new Date(now - min * 60_000).toISOString();

export function line(now: number, p: Partial<StoredItem> & { id: string }): StoredItem {
  return {
    key: `k:${p.id}`,
    handle: "aeyakovenko",
    group: "chain",
    kind: "repo",
    repo: p.id,
    summary: "A thing.",
    summarySource: "fallback",
    heat: "low",
    score: 2,
    signals: [{ label: "new repo", points: 3 }],
    githubAt: ago(now, 30),
    seenAt: ago(now, 29),
    shownAt: ago(now, 29),
    url: `https://github.com/aeyakovenko/${p.id}`,
    backfill: false,
    ...p,
  };
}
