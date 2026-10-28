import { HEAT_BAR, HEAT_CLASS, HEAT_LABEL } from "@/lib/groups";
import type { Heat as HeatLevel } from "@/lib/types";

/** The heat mark: ten blocks, lit by heat, and the word. */
export function Heat({ heat, label = true }: { heat: HeatLevel; label?: boolean }) {
  const [lit, unlit] = HEAT_BAR[heat];
  return (
    <span className={`heat ${HEAT_CLASS[heat]}`} aria-label={`Heat: ${HEAT_LABEL[heat]}`}>
      <span className="bar" aria-hidden="true">
        <b>{"█".repeat(lit)}</b>
        <s>{"█".repeat(unlit)}</s>
      </span>
      {label && <span className="lbl">{HEAT_LABEL[heat]}</span>}
    </span>
  );
}
