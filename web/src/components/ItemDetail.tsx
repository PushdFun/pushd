import type { ReactNode } from "react";
import { ago } from "@/lib/format";
import { GROUPS, KIND_LABEL } from "@/lib/groups";
import type { FeedItem } from "@/lib/types";
import { Heat } from "./Heat";
import { ScoutRead } from "./ScoutRead";
import { SCOUT_BY_ID } from "@/lib/scouts";

export const repoName = (it: FeedItem) => (it.version ? `${it.repo} ${it.version}` : it.repo);
export const actor = (it: FeedItem) =>
  it.name ? `${it.handle} (${[it.name, it.org].filter(Boolean).join(", ")})` : it.handle;

/** "AI agent projects . Dregg, $DREGG . Sample" */
export function grpLine(it: FeedItem) {
  const who = it.name ? [it.name, it.org].filter(Boolean).join(", ") : null;
  return [GROUPS[it.group].label, who, it.sample ? "Sample" : null].filter(Boolean).join(" . ");
}

/** The link to the line on GitHub, or a note when a sample line has nothing real to link to. */
export function GitHubLink({ item }: { item: FeedItem }) {
  return item.url ? (
    <a href={item.url} target="_blank" rel="noopener noreferrer">
      Open on GitHub -&gt;
    </a>
  ) : (
    <span>Sample handle, no link</span>
  );
}

/** The raw details of one line: what happened, and the signals behind its heat. */
export function ItemDetail({ item, asOf, links, scout = true }: { item: FeedItem; asOf: string; links: ReactNode; scout?: boolean }) {
  return (
    <div className="detail-in">
      <div className="dtop">
        <span>$ pushd show {item.id}</span>
        {item.sample && <span className="tag sample">Sample</span>}
      </div>
      <div className="detail-grid">
        <div>
          <dl className="raw">
            <dt>event</dt>
            <dd>{KIND_LABEL[item.kind]}</dd>
            <dt>actor</dt>
            <dd>{actor(item)}</dd>
            <dt>repo</dt>
            <dd className="cy">{repoName(item)}</dd>
            <dt>group</dt>
            <dd>{GROUPS[item.group].label}</dd>
            <dt>seen</dt>
            <dd>{ago(item.githubAt, asOf)} ago, public view</dd>
            <dt>summary</dt>
            <dd>written from the repo only</dd>
            {item.call && (
              <>
                <dt>scout</dt>
                <dd>
                  {SCOUT_BY_ID[item.call.scout].name} . {item.call.source === "model" ? "model call" : "template call"}
                </dd>
              </>
            )}
          </dl>
        </div>
        <div>
          <ul className="signals">
            {item.signals?.map((s) => (
              <li key={s.label}>
                <span>{s.label}</span>
                <b>+{s.points}</b>
              </li>
            ))}
            <li className="total">
              <span>{item.score != null ? `heat ${item.score}/10` : "heat"}</span>
              <Heat heat={item.heat} />
            </li>
          </ul>
        </div>
      </div>
      {scout && item.call && <ScoutRead item={item} call={item.call} compact />}
      <div className="links">{links}</div>
    </div>
  );
}
