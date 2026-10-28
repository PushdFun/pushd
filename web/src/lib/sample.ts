import type { FeedItem, Stats, WatchGroup } from "./types";

// Sample data, shown until the watcher runs. Every line here is marked Sample on the site.
//
// Only toly (Anatoly Yakovenko, Solana) is a real person: his repo dts02-6502-signer is real, new on 27 Oct, and the link
// goes to it.
// PUSHD claims no time for them (shownAt is null: "replay pending" until the 27 Oct replay is measured). Everyone
// else is a made-up handle with made-up activity, so those lines have no link.
//
// The clock times are illustrative: they are set so the page reads "6m", "11m" and so on, counted from SAMPLE_AS_OF.

export const SAMPLE_AS_OF = "2026-10-27T14:23:00Z";

export const SAMPLE_ITEMS: FeedItem[] = [
  {
    id: "frog-oracle",
    handle: "@kaiwren",
    group: "oss",
    kind: "repo",
    repo: "frog-oracle",
    summary: "A price feed that answers in frog emojis, as a joke.",
    heat: "veryHigh",
    score: 9,
    signals: [
      { label: "new repo", points: 3 },
      { label: "fun name", points: 2 },
      { label: "joke README", points: 2 },
      { label: "emoji in the description", points: 2 },
    ],
    githubAt: "2026-10-27T14:11:31Z",
    shownAt: "2026-10-27T14:12:09Z",
    url: null,
    mediaUrl: null,
    sample: true,
  },
  {
    id: "gm-cli",
    handle: "@pixelpunk",
    group: "oss",
    kind: "repo",
    repo: "gm-cli",
    summary: 'A command line tool that prints "gm".',
    heat: "high",
    score: 7,
    signals: [
      { label: "new repo", points: 3 },
      { label: "fun name", points: 2 },
      { label: "one-line joke tool", points: 2 },
    ],
    githubAt: "2026-10-27T14:08:10Z",
    shownAt: "2026-10-27T14:08:52Z",
    url: null,
    mediaUrl: null,
    sample: true,
  },
  {
    id: "launch-txt",
    handle: "@bitsmith",
    group: "launchpads",
    kind: "gist",
    repo: "launch.txt",
    summary: 'A public gist with one line: "soon".',
    heat: "high",
    score: 7,
    signals: [
      { label: "public gist", points: 2 },
      { label: 'word "launch" in the name', points: 3 },
      { label: "one-word teaser", points: 2 },
    ],
    githubAt: "2026-10-27T14:05:00Z",
    shownAt: "2026-10-27T14:05:51Z",
    url: null,
    mediaUrl: null,
    sample: true,
  },
  {
    id: "dts02-6502-signer",
    handle: "toly",
    name: "Anatoly Yakovenko",
    org: "Solana",
    group: "launchpads",
    kind: "repo",
    repo: "dts02-6502-signer",
    summary: "A hardware signer for the old 6502 chip.",
    heat: "veryHigh",
    score: 9,
    signals: [
      { label: "new repo", points: 3 },
      { label: "builder with a big following", points: 3 },
      { label: "retro hardware theme", points: 2 },
      { label: "short, clear README", points: 1 },
    ],
    // Real: GitHub says the repo was created at 03:14:27 UTC on 27 Oct 2026.
    githubAt: "2026-10-27T03:14:27Z",
    shownAt: null,
    url: "https://github.com/aeyakovenko/dts02-6502-signer",
    mediaUrl: null,
    sample: true,
  },
  {
    id: "agent-kit-lite",
    handle: "@orbitlabs",
    group: "ai",
    kind: "repo",
    repo: "agent-kit-lite",
    summary: "A smaller toolkit for building AI agents.",
    heat: "medium",
    score: 5,
    signals: [
      { label: "new repo", points: 3 },
      { label: "AI agents topic", points: 2 },
    ],
    githubAt: "2026-10-27T13:42:00Z",
    shownAt: "2026-10-27T13:42:44Z",
    url: null,
    mediaUrl: null,
    sample: true,
  },
  {
    id: "tiny-wallet",
    handle: "@nullbyte",
    group: "wallets",
    kind: "release",
    repo: "tiny-wallet",
    version: "v2.0",
    summary: "A wallet that fits in one file.",
    heat: "medium",
    score: 5,
    signals: [
      { label: "major release", points: 3 },
      { label: "small, catchy idea", points: 2 },
    ],
    githubAt: "2026-10-27T13:31:00Z",
    shownAt: "2026-10-27T13:31:37Z",
    url: null,
    mediaUrl: null,
    sample: true,
  },
  {
    id: "zk-receipts",
    handle: "@mira-dev",
    group: "wallets",
    kind: "push",
    repo: "zk-receipts",
    summary: "Private receipts for onchain payments, early draft.",
    heat: "low",
    score: 2,
    signals: [
      { label: "push to an existing repo", points: 1 },
      { label: "early draft", points: 1 },
    ],
    githubAt: "2026-10-27T13:20:00Z",
    shownAt: "2026-10-27T13:20:52Z",
    url: null,
    mediaUrl: null,
    sample: true,
  },
];

/** The lines in the home page's terminal: a spread of heat, not just the newest five. */
export const SAMPLE_PREVIEW_IDS = ["frog-oracle", "gm-cli", "launch-txt", "agent-kit-lite", "dts02-6502-signer"];

export const SAMPLE_WATCHLIST: WatchGroup[] = [
  { group: "chain", count: 24, members: [] },
  {
    group: "wallets",
    count: 22,
    members: [
      { handle: "@nullbyte", group: "wallets", sample: true },
      { handle: "@mira-dev", group: "wallets", sample: true },
    ],
  },
  { group: "launchpads", count: 14, members: [{ handle: "toly", name: "Anatoly Yakovenko", org: "Solana", group: "launchpads", sample: false }, { handle: "@bitsmith", group: "launchpads", sample: true }] },
  { group: "ai", count: 20, members: [{ handle: "@orbitlabs", group: "ai", sample: true }] },
  {
    group: "oss",
    count: 20,
    members: [
      { handle: "@kaiwren", group: "oss", sample: true },
      { handle: "@pixelpunk", group: "oss", sample: true },
    ],
  },
];

export const SAMPLE_STATS: Stats = { builders: 100, groups: 5, publicDelayMinutes: 5 };
