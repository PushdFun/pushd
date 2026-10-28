import type { FeedItem, GroupKey, RepoCard } from "./types";

// The shapes of one day, for the replay and the daily brief. The engine answers in the same shapes
// (engine/src/days.ts): GET /v1/days and GET /v1/day/:date.

export type DaySummary = { day: string; events: number; lines: number; catches: number };

export type DayEvent = { handle: string; name?: string; group: GroupKey; type: string; what: string; repo: string | null; at: string };

export type DayDetail = {
  day: string;
  /** the public view's moment */
  asOf: string;
  /** every own event that day, oldest first (at most 2000) */
  events: DayEvent[];
  truncated: boolean;
  totalEvents: number;
  /** the feed lines that happened that day, oldest first */
  lines: FeedItem[];
  catches: number;
  top: { handle: string; name?: string; group: GroupKey; events: number; lines: number }[];
  /** each group that day, its average over the 7 days before, and how many of its accounts the watcher has read */
  groups: { group: GroupKey; events: number; lines: number; avg7: number; accounts: number; read: number }[];
  hours: number[];
  fresh: (RepoCard & { handle: string; group: GroupKey })[];
  active: number;
  sample: boolean;
};
