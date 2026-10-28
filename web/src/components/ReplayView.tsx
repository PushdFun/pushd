import Link from "next/link";
import { dayWords } from "@/lib/brief";
import { neighbours } from "@/lib/data-days";
import type { DayDetail, DaySummary } from "@/lib/day-types";
import { num } from "@/lib/format";
import { DayStrip } from "./DayStrip";
import { Prompt } from "./Prompt";
import { ReplayPlayer } from "./ReplayPlayer";

// The replay page around the player: the head, the strip of days, the player, and the way to the day's brief.

export function ReplayView({ day, days }: { day: DayDetail; days: DaySummary[] }) {
  const { older, newer } = neighbours(days, day.day);
  // a sample day is illustrative: it is never "today"
  const today = !day.sample && day.asOf.slice(0, 10) === day.day;
  return (
    <>
      <section className="page-head days-head">
        <div className="wrap">
          <div className="page-head-row">
            <div>
              <Prompt path="~/pushd/replay" cmd={`pushd replay ${day.day} --in 60s`} />
              <h1>
                Replay<span className="acc">.</span>
              </h1>
              <p className="lede">
                {dayWords(day.day, true)}, played back in 60 seconds. Every public event the watcher stored for that day, in the order it
                happened on GitHub{today ? ", up to the public view's moment" : ""}.
              </p>
            </div>
            <div className="statusbar">
              <span>
                <b>{num(day.totalEvents)}</b> events
              </span>
              <span>
                <b>{num(day.lines.length)}</b> feed lines
              </span>
              {today && <span className="tag acc live">today, so far</span>}
              {day.sample && <span className="tag sample">Sample data</span>}
            </div>
          </div>
        </div>
      </section>
      <section className="wrap days-body">
        <DayStrip days={days} current={day.day} base="/replay" older={older} newer={newer} />
        <ReplayPlayer key={day.day} day={day} today={today} />
        <div className="days-foot">
          <p>
            {day.truncated ? `The log plays the earliest ${num(day.events.length)} of ${num(day.totalEvents)} events. ` : ""}
            Times are when GitHub says each thing happened. The watcher reads each account in turn, so a day fills in as it is read.
          </p>
          <Link className="textlink" href={`/brief/${day.day}`}>
            the brief for {dayWords(day.day)} -&gt;
          </Link>
        </div>
      </section>
    </>
  );
}

/** When there is no day to show: the watcher is silent, or nothing is stored yet. */
export function DaysEmpty({ what, offline }: { what: "replay" | "brief"; offline: boolean }) {
  return (
    <>
      <section className="page-head days-head">
        <div className="wrap">
          <Prompt path={`~/pushd/${what}`} cmd={`pushd ${what}`} />
          <h1>
            {what === "replay" ? "Replay" : "The brief"}
            <span className="acc">.</span>
          </h1>
          <p className="lede">{what === "replay" ? "A day of pushes, played back in 60 seconds." : "What the projects shipped, day by day."}</p>
        </div>
      </section>
      <section className="wrap days-body">
        <div className="days-empty">
          <pre aria-hidden="true">{`  .-----------------.\n  |  ${offline ? "watcher offline" : "no days stored "} |\n  '-----------------'`}</pre>
          <p>{offline ? "PUSHD's watcher did not answer just now. The days come back on the next look." : "Nothing is stored yet. Days show here once the watcher has read some accounts."}</p>
          <Link className="btn btn-line" href="/feed">
            Open the feed
          </Link>
        </div>
      </section>
    </>
  );
}
