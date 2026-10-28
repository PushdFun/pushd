import type { ScoutsView } from "@/lib/types";

/** How the scouts write right now, in one plain sentence. */
export function ModeNote({ v }: { v: ScoutsView }) {
  if (v.sample)
    return (
      <div className="mode-note sample">
        <span className="tag sample">Sample</span>
        <p>The engine is not connected here, so the scouts have made no calls on this page. The five models are real; the numbers are empty.</p>
      </div>
    );
  if (v.mode === "model")
    return (
      <div className="mode-note">
        <span className="tag acc live">model on</span>
        <p>
          Calls are written by <b>{v.model}</b>; new repos and releases get a deep read by <b>{v.deepModel}</b>. Under a hard daily spend cap; when it is reached, or a model answer fails a check, a template call stands in and says so.
        </p>
      </div>
    );
  if (v.mode === "off")
    return (
      <div className="mode-note">
        <span className="tag">scouts off</span>
        <p>The scouts are switched off here. Their records below stay as they were.</p>
      </div>
    );
  return (
    <div className="mode-note tpl">
      <span className="tag">template mode</span>
      <p>
        No model is connected right now. Every call here is a <b>template call</b>: written by fixed rules from the watcher&apos;s own facts and marked
        &quot;template&quot;. Template calls repeat the watcher&apos;s heat score, so they are kept out of each scout&apos;s hit rate.
      </p>
    </div>
  );
}

