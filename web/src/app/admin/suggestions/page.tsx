import type { Metadata } from "next";
import { connection } from "next/server";
import { AdminLogin, AdminLogout, AdminSuggestions } from "@/components/AdminPanel";
import { Prompt } from "@/components/Prompt";
import { adminSecret, isAdmin } from "@/lib/admin";
import { engineUrl, getAdminStatus, getAdminSuggestions } from "@/lib/data";

export const metadata: Metadata = {
  title: "PUSHD Admin",
  robots: { index: false, follow: false },
};

type Spend = { part: string; resource: string; n: number; free: number };
type Src = { source: string; calls: number; failed: number; bytes: number };
type Status = {
  at?: string;
  watched?: number;
  github?: { authenticated?: boolean; rate?: { limit: number; remaining: number; resetAt: number } | null; lastHour?: Spend[]; lastDay?: Spend[]; plan?: { shares?: { key: string; label: string; perHour: number }[] } };
  sources?: { lastHour?: Src[]; lastDay?: Src[] };
  scouts?: { mode?: string; gated?: number; queued?: number; today?: { usd: number; capUsd: number; leftUsd: number; hourUsd: number; hourCapUsd: number | null; calls: number; perModel?: { model: string; calls: number; usd: number }[]; modelCallsPerDay: number | null } } | null;
  ranking?: { inTop?: number; pool?: { status: string; n: number }[]; archiveHours?: { hours: number; events: number; kept: number; bytes: number }; lastPass?: { at: number; kind: string } | null } | null;
};

const n = (v: number | null | undefined) => (v == null ? "n/a" : v.toLocaleString("en-US"));
const mb = (b: number | null | undefined) => (b == null ? "n/a" : `${(b / 1e6).toFixed(1)} MB`);
const usd = (v: number | null | undefined) => (v == null ? "n/a" : `$${v.toFixed(4)}`);

function Rows({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="adm-rows">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The engine's budgets as numbers that read at a glance: GitHub by part, the outside sources, the scouts, the ranking. */
function StatusPanel({ status }: { status: Record<string, unknown> }) {
  const s = status as Status;
  const g = s.github ?? {};
  const share = (key: string) => g.plan?.shares?.find((x) => x.key === key)?.perHour;
  const part = (list: Spend[] | undefined, key: string, res = "core") => list?.filter((x) => x.part === key && x.resource === res).reduce((a, x) => a + x.n, 0) ?? 0;
  const sc = s.scouts?.today;
  return (
    <div className="admin-status">
      <div className="panel">
        <div className="ptitle">
          <h3>GitHub</h3>
          <span>{g.authenticated ? "with a token" : "no token"}</span>
        </div>
        <Rows
          rows={[
            ["left this hour", g.rate ? `${n(g.rate.remaining)} of ${n(g.rate.limit)}` : "n/a"],
            ...["watch", "lookup", "extra", "enrich", "rank"].map((k): [string, string] => [`${k}, last hour`, `${n(part(g.lastHour, k))} of ${n(share(k))}`]),
            ["search API, last hour", n((g.lastHour ?? []).filter((x) => x.resource === "search").reduce((a, x) => a + x.n, 0))],
            ["core, last day", n((g.lastDay ?? []).filter((x) => x.resource === "core").reduce((a, x) => a + x.n, 0))],
            ["free 304s, last day", n((g.lastDay ?? []).reduce((a, x) => a + x.free, 0))],
          ]}
        />
      </div>
      <div className="panel">
        <div className="ptitle">
          <h3>Scouts</h3>
          <span>{s.scouts?.mode ?? "off"}</span>
        </div>
        <Rows
          rows={[
            ["spent today", sc ? `${usd(sc.usd)} of ${usd(sc.capUsd)}` : "n/a"],
            ["left today", usd(sc?.leftUsd)],
            ["last 60 minutes", sc ? `${usd(sc.hourUsd)} of ${usd(sc.hourCapUsd)}` : "n/a"],
            ["model calls today", n(sc?.calls)],
            ["calls per model, cap", n(sc?.modelCallsPerDay)],
            ...(sc?.perModel ?? []).slice(0, 4).map((m): [string, string] => [m.model, `${n(m.calls)} calls, ${usd(m.usd)}`]),
            ["gated to templates", n(s.scouts?.gated)],
            ["waiting for the model", n(s.scouts?.queued)],
          ]}
        />
      </div>
      <div className="panel">
        <div className="ptitle">
          <h3>Ranking and sources</h3>
          <span>{n(s.ranking?.inTop)} watched</span>
        </div>
        <Rows
          rows={[
            ["pool", (s.ranking?.pool ?? []).map((p) => `${n(p.n)} ${p.status}`).join(", ") || "empty"],
            ["last pass", s.ranking?.lastPass ? `${s.ranking.lastPass.kind}, ${new Date(s.ranking.lastPass.at).toISOString().slice(11, 16)} UTC` : "none yet"],
            ["GH Archive, last day", s.ranking?.archiveHours ? `${n(s.ranking.archiveHours.hours)} hours, ${mb(s.ranking.archiveHours.bytes)}` : "n/a"],
            ...(s.sources?.lastDay ?? []).map((x): [string, string] => [`${x.source}, last day`, `${n(x.calls)} calls${x.failed ? `, ${n(x.failed)} failed` : ""}, ${mb(x.bytes)}`]),
          ]}
        />
      </div>
    </div>
  );
}

export default async function AdminSuggestionsPage() {
  await connection();
  const secret = adminSecret();
  const signedIn = secret ? await isAdmin() : false;
  const [list, status] = signedIn ? await Promise.all([getAdminSuggestions(), getAdminStatus()]) : [null, null];

  return (
    <>
      <section className="page-head">
        <div className="wrap">
          <div className="page-head-row">
            <div>
              <Prompt path="~/pushd/admin" cmd="pushd admin suggestions" />
              <h1>
                Admin<span className="acc">.</span>
              </h1>
              <p className="lede">Suggestions from visitors, and the engine&apos;s budgets. Approving marks it for the owner; nothing is added automatically.</p>
            </div>
            {signedIn && <AdminLogout />}
          </div>
        </div>
      </section>
      <section className="wrap admin" style={{ paddingTop: 40 }}>
        {!secret ? (
          <div className="estate">
            <b>Admin is off.</b>
            <span>PUSHD_ADMIN_KEY is not set in this site&apos;s settings.</span>
          </div>
        ) : !signedIn ? (
          <AdminLogin />
        ) : !engineUrl() ? (
          <div className="estate">
            <b>No engine connected.</b>
            <span>PUSHD_ENGINE_URL is not set, so there are no suggestions to show.</span>
          </div>
        ) : (
          <>
            {list ? (
              <AdminSuggestions list={list} />
            ) : (
              <div className="estate">
                <b>The engine refused or did not answer.</b>
                <span>Check that the engine has the same PUSHD_ADMIN_KEY.</span>
              </div>
            )}
            {status && <StatusPanel status={status} />}
          </>
        )}
      </section>
    </>
  );
}
