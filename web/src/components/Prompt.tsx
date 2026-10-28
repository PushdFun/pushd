import type { ReactNode } from "react";

/** The shell prompt above a heading: path, dollar, command. */
export function Prompt({ path, cmd, children }: { path: string; cmd: string; children?: ReactNode }) {
  return (
    <div className="prompt">
      <span className="path">{path}</span>
      <span className="dollar">$</span>
      <span className="cmd">{cmd}</span>
      {children}
    </div>
  );
}
