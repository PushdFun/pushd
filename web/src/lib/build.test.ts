import { describe, expect, it } from "vitest";
import { JOBS, requestable, type AgentSpec } from "./build";
import { agentsOn, buildRouteOk } from "./build-switch";

describe("PUSHD Agents on the site", () => {
  it("is off unless PUSHD_AGENTS is on", () => {
    expect(agentsOn({})).toBe(false);
    expect(agentsOn({ PUSHD_AGENTS: "" })).toBe(false);
    expect(agentsOn({ PUSHD_AGENTS: "off" })).toBe(false);
    expect(agentsOn({ PUSHD_AGENTS: "1" })).toBe(false);
    expect(agentsOn({ PUSHD_AGENTS: "on" })).toBe(true);
    expect(agentsOn({ PUSHD_AGENTS: " ON " })).toBe(true);
  });

  it("passes only the builder's own calls to the engine", () => {
    expect(buildRouteOk("me", "GET")).toBe(true);
    expect(buildRouteOk("agents/0123456789abcdef/run", "POST")).toBe(true);
    expect(buildRouteOk("runs/0123456789abcdef/pay", "POST")).toBe(true);
    // the webhook, sign-in and anything unknown never pass through here
    for (const [p, m] of [
      ["github/webhook", "POST"],
      ["github/oauth", "POST"],
      ["me", "DELETE"],
      ["agents/0123456789abcdef/run", "GET"],
      ["agents/../../v1/admin/status", "GET"],
      ["agents/scout-claude", "GET"],
      ["shipped/a/b", "GET"],
    ])
      expect(buildRouteOk(p, m), `${m} ${p}`).toBe(false);
  });

  it("an agent can be asked to run only the jobs whose whitelist allows a request", () => {
    const spec: AgentSpec = { name: "x", model: "claude", repos: ["a/b"], jobs: [{ job: "secret_check", trigger: "push" }, { job: "release_notes", trigger: "push" }, { job: "small_change", trigger: "request" }] };
    expect(requestable(spec)).toEqual(["release_notes", "small_change"]);
    expect(JOBS.secret_check.triggers).toEqual(["push"]);
  });

  it("no long dashes and none of the owner's never-words in the jobs' words", () => {
    const words = JSON.stringify(JOBS);
    expect(words).not.toMatch(/[\u2013\u2014]/);
    expect(words).not.toMatch(/memecoin|\btax\b|Robinhood Chain|split/i);
  });
});
