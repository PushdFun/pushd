import Link from "next/link";
import { callHeat, NOT_ADVICE, SCOUT_BY_ID, VERDICT_LABEL } from "@/lib/scouts";
import { HEAT_CLASS, HEAT_LABEL } from "@/lib/groups";
import type { FeedItem, ScoutCall } from "@/lib/types";
import { ScoutAvatar } from "./ScoutAvatar";

// A scout's call, in three sizes: a tag inside a feed row (no link: the row is a button), a chip that links to the
// scout, and the full read (why it matters, what the repo is, the heat call and its reason, the flags).

const shortModel = (m: string | null) => (m ? m.split("/").pop()! : "");

/** Who wrote a call: the model's name, or "template". */
export function SourceTag({ call }: { call: ScoutCall }) {
  return call.source === "model" ? (
    <span className="stag model" title={`Written by ${call.model}`}>
      model . {shortModel(call.model)}
    </span>
  ) : (
    <span className="stag tpl" title="Written by the template writer from the watcher's own facts. No model was used.">
      template
    </span>
  );
}

/** Inside a feed row: the scout's face, its name and its heat call. Plain text (the row itself is a button). */
export function ScoutTag({ call }: { call: ScoutCall }) {
  const s = SCOUT_BY_ID[call.scout];
  return (
    <span className={`scout-tag g-${s.camp}`}>
      <ScoutAvatar id={call.scout} size={18} frame={false} />
      <b>{s.name}</b>
      <span className={`h-${HEAT_CLASS[callHeat(call.heat)]}`}>{call.heat}/10</span>
      {call.source === "template" && <em>template</em>}
    </span>
  );
}

/** The full read, for an opened row and an item's page. */
export function ScoutRead({ item, call, compact = false, bare = false }: { item: FeedItem; call: ScoutCall; compact?: boolean; bare?: boolean }) {
  const s = SCOUT_BY_ID[call.scout];
  const h = callHeat(call.heat);
  return (
    <div className={`sread g-${s.camp}${compact ? " compact" : ""}${bare ? " bare" : ""}`}>
      {!bare && (
      <div className="sread-head">
        <Link href={`/scouts/${s.id}`} className="sread-who">
          <ScoutAvatar id={s.id} size={compact ? 36 : 48} />
          <span>
            <b>{s.name}</b>
            <small>{s.title}</small>
          </span>
        </Link>
        <div className="sread-call">
          <span className={`sread-heat h-${HEAT_CLASS[h]}`}>
            <b>{call.heat}</b>/10
          </span>
          <small>{HEAT_LABEL[h]} heat call</small>
        </div>
      </div>
      )}
      {call.line !== item.summary && <p className="sread-line">{call.line}</p>}
      <p className="sread-why">{call.why}</p>
      <dl className="sread-facts">
        {call.verdict && (
          <>
            <dt>what it is</dt>
            <dd>
              <span className={`verdict v-${call.verdict}`}>{VERDICT_LABEL[call.verdict]}</span> {call.whatItIs}
            </dd>
          </>
        )}
        <dt>heat call</dt>
        <dd>{call.heatReason}</dd>
        <dt>written by</dt>
        <dd>
          <SourceTag call={call} /> {call.deep ? "after reading the README, the file tree and the main files" : call.source === "model" ? "from what the store holds of the repo" : "from the watcher's facts, with fixed rules"}
        </dd>
      </dl>
      {call.flags.length > 0 && (
        <ul className="sread-flags">
          {call.flags.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      )}
      {!bare && (
        <p className="sread-note">
          {call.late ? "Called when the scouts caught up, after the line was stored: its timing is not counted. " : ""}
          {NOT_ADVICE}
        </p>
      )}
    </div>
  );
}
