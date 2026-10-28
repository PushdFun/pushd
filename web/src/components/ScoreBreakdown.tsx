import { movementText, movementWords, partsByPoints, rawText } from "@/lib/lookup";
import type { Movement, RankRow } from "@/lib/types";

// Why a project ranks where it does: each part of its activity score with the raw counts behind it, the normalised
// value as a bar, and the points it adds. Works on the server and in the browser (no state).

export function MoveChip({ movement, delta }: { movement: Movement; delta: number }) {
  return (
    <span className={`mv mv-${movement}`} title={movementWords(movement, delta)}>
      <span aria-hidden="true">{movementText(movement, delta)}</span>
      <span className="sr">{movementWords(movement, delta)}</span>
    </span>
  );
}

export function ScoreBar({ score }: { score: number }) {
  const w = Math.max(0, Math.min(100, score));
  return (
    <span className="sbar" aria-hidden="true">
      <i style={{ width: `${w}%` }} />
    </span>
  );
}

export function ScoreBreakdown({ row, compact = false }: { row: Pick<RankRow, "parts" | "score" | "topRepos">; compact?: boolean }) {
  const parts = partsByPoints(row.parts);
  return (
    <div className={compact ? "sbd compact" : "sbd"}>
      <div className="sbd-rows" role="list">
        {parts.map((p) => (
          <div key={p.key} className="sbd-row" role="listitem">
            <span className="sbd-l">{p.label}</span>
            <span className="sbd-bar" aria-hidden="true">
              <i style={{ width: `${Math.round(Math.max(0, Math.min(1, p.norm)) * 100)}%` }} />
            </span>
            <b className="sbd-p">{p.points.toFixed(1)}</b>
            <span className="sbd-raw">
              {rawText(p.raw) || "none"} <span className="sbd-w">x{p.weight}</span>
            </span>
          </div>
        ))}
      </div>
      <div className="sbd-foot">
        <span>
          score <b>{row.score.toFixed(1)}</b> of 100
        </span>
        {row.topRepos.length > 0 && (
          <span className="sbd-repos">
            busiest:{" "}
            {row.topRepos.slice(0, 3).map((r, i) => (
              <span key={r}>
                {i > 0 && ", "}
                <a href={`/gh/${r.split("/").map(encodeURIComponent).join("/")}`}>{r.split("/")[1] ?? r}</a>
              </span>
            ))}
          </span>
        )}
      </div>
    </div>
  );
}
