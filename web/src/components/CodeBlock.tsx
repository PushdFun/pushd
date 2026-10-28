import { CopyButton } from "./CopyButton";

/** A small terminal window holding code, with a copy button. */
export function CodeBlock({ title, code, note }: { title: string; code: string; note?: string }) {
  return (
    <div className="term codeblock">
      <div className="term-bar">
        <div className="tabs">
          <span className="tab on">{title}</span>
        </div>
        <div className="right">
          {note && <span>{note}</span>}
          <CopyButton text={code} />
        </div>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}
