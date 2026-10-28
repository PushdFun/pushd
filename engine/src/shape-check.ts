// Type check only: the engine's answers must be exactly the website's shapes, both ways. Nothing here runs.
import type * as Web from "../../web/src/lib/types.ts";
import type * as Engine from "./types.ts";

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Check<T extends true> = T;

export type ShapeChecks = [
  Check<Same<Engine.FeedItem, Web.FeedItem>>,
  Check<Same<Engine.Builder, Web.Builder>>,
  Check<Same<Engine.WatchGroup, Web.WatchGroup>>,
  Check<Same<Engine.Stats, Web.Stats>>,
  Check<Same<Engine.GroupKey, Web.GroupKey>>,
  Check<Same<Engine.Heat, Web.Heat>>,
  Check<Same<Engine.Kind, Web.Kind>>,
  Check<Same<Engine.BuilderStats, Web.BuilderStats>>,
  Check<Same<Engine.BuilderProfile, Web.BuilderProfile>>,
  Check<Same<Engine.Pulse, Web.Pulse>>,
  Check<Same<Engine.ItemMore, Web.ItemMore>>,
  Check<Same<Engine.SearchResult, Web.SearchResult>>,
  Check<Same<Engine.ScoutCall, Web.ScoutCall>>,
  Check<Same<Engine.ScoutRecord, Web.ScoutRecord>>,
  Check<Same<Engine.ScoutsView, Web.ScoutsView>>,
  Check<Same<Engine.ScoutProfile, Web.ScoutProfile>>,
  Check<Same<Engine.CallRef, Web.CallRef>>,
  Check<Same<Engine.ScorePart, Web.ScorePart>>,
  Check<Same<Engine.RankRow, Web.RankRow>>,
  Check<Same<Engine.RankChange, Web.RankChange>>,
  Check<Same<Engine.SchedulePlan, Web.SchedulePlan>>,
  Check<Same<Engine.TopView, Web.TopView>>,
  Check<Same<Engine.ProjectRank, Web.ProjectRank>>,
  Check<Same<Engine.GhUser, Web.GhUser>>,
  Check<Same<Engine.GhUserPage, Web.GhUserPage>>,
  Check<Same<Engine.GhRepoPage, Web.GhRepoPage>>,
  Check<Same<Engine.ScoutRead, Web.ScoutRead>>,
  Check<Same<Engine.ReadAllowance, Web.ReadAllowance>>,
  Check<Same<Engine.LookupResult, Web.LookupResult>>,
  Check<Same<Engine.HolderWatch, Web.HolderWatch>>,
  Check<Same<Engine.HolderWatchView, Web.HolderWatchView>>,
  Check<Same<Engine.Suggestion, Web.Suggestion>>,
];
