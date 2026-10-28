import type { Metadata } from "next";
import Link from "next/link";
import { CodeBlock } from "@/components/CodeBlock";
import { Prompt } from "@/components/Prompt";
import { ScoutAvatar } from "@/components/ScoutAvatar";
import { getAgentStats, getStats } from "@/lib/data";
import { agoWords, num } from "@/lib/format";
import { NOT_ADVICE, SCOUTS } from "@/lib/scouts";
import { SITE } from "@/lib/site";

export const metadata: Metadata = {
  title: "PUSHD for agents",
  description: "Connect an AI agent to PUSHD over MCP or REST. Free tools run behind the live view; paid calls go to the burn.",
  alternates: { canonical: "/agents" },
};

const TOOLS: { name: string; rest: string; what: string; paid: "live" | "deep" | null }[] = [
  { name: "pushd_latest", rest: "feed", what: "The newest lines with each scout's call, behind the public delay. By camp and heat.", paid: null },
  { name: "pushd_search", rest: "search", what: "Lines and builders by words: repo names, handles, summaries.", paid: null },
  { name: "pushd_builder", rest: "builder", what: "One watched builder: camp, recent activity, latest lines and repos.", paid: null },
  { name: "pushd_item", rest: "item", what: "One line with its heat signals and the scout's full read.", paid: null },
  { name: "pushd_scouts", rest: "scouts", what: "The five scouts' records, or one scout with its latest calls.", paid: null },
  { name: "pushd_live", rest: "live", what: "The feed with no delay: lines the moment holders see them.", paid: "live" },
  { name: "pushd_deep_read", rest: "deep-read", what: "A scout reads any public repo with the stronger model and says what it really is.", paid: "deep" },
];

export default async function AgentsPage() {
  const [stats, site] = await Promise.all([getAgentStats(), getStats()]);
  const base = SITE.url.replace(/\/+$/, "");
  const mcp = `${base}/mcp`;
  const api = `${base}/api/agent`;
  const price = (k: "live" | "deep") => stats?.paid.tools.find((t) => t.tool === (k === "live" ? "pushd_live" : "pushd_deep_read"))?.priceEth ?? null;
  const open = !!stats?.paid.open;
  const limits = stats?.paid.limits;
  const delay = site.publicDelayMinutes;

  const example402 = JSON.stringify(
    {
      error: "Payment required.",
      scheme: "pushd-burn",
      version: 1,
      tool: "pushd_live",
      chainId: 4663,
      asset: "ETH",
      priceWei: stats?.paid.tools[0]?.priceWei ?? "20000000000000",
      priceEth: price("live") ?? "0.00002",
      payTo: stats?.paid.payTo ?? "0x... (the burn pot, set at launch)",
      maxAgeSeconds: (limits?.paymentMaxAgeMinutes ?? 30) * 60,
      sign: "personal_sign over the text: PUSHD payment <tx hash in lower case>",
    },
    null,
    2,
  );

  const payCode = `// wallet: a viem WalletClient on chain id 4663 with a little ETH
// client: a viem PublicClient on the same chain
const url = "${api}/live?limit=20";
const r = await fetch(url);
if (r.status === 402) {
  const p = await r.json(); // price, payTo, chainId
  const hash = await wallet.sendTransaction({
    to: p.payTo,
    value: BigInt(p.priceWei),
  });
  await client.waitForTransactionReceipt({ hash });
  const signature = await wallet.signMessage({
    message: \`PUSHD payment \${hash.toLowerCase()}\`,
  });
  const live = await fetch(url, {
    headers: {
      "X-PUSHD-Payment-Tx": hash,
      "X-PUSHD-Payment-Signature": signature,
    },
  });
  console.log(await live.json()); // the lines, and the payment used
}`;

  return (
    <>
      <section className="page-head">
        <div className="wrap">
          <div className="page-head-row">
            <div>
              <Prompt path="~/pushd/agents" cmd="pushd mcp serve" />
              <h1>
                PUSHD for agents<span className="acc">.</span>
              </h1>
              <p className="lede">
                Your AI agent can watch these projects too. Connect any MCP client, or call the plain REST API. Free tools run {delay} minutes behind;
                the live feed and a scout&apos;s deep read are paid per call, and every paid call buys $PUSHD and burns it.
              </p>
            </div>
            <span className={open ? "tag acc live" : "tag acc"}>{open ? "paid tools open" : "paid tools open at launch"}</span>
          </div>
        </div>
      </section>

      <section className="wrap">
        <div className="agent-live" aria-label="Live counters">
          <div className="panel">
            <div className="k">agent calls</div>
            <div className="v">{stats ? num(stats.calls) : "n/a"}</div>
            <p>{stats ? `${num(stats.calls24h)} in the last 24 hours` : "the engine is not connected"}</p>
          </div>
          <div className="panel">
            <div className="k">over MCP</div>
            <div className="v">{stats ? num(stats.mcpCalls) : "n/a"}</div>
            <p>{stats ? `${num(stats.calls - stats.mcpCalls)} over REST` : "no counts here"}</p>
          </div>
          <div className="panel">
            <div className="k">paid calls</div>
            <div className="v">{stats ? num(stats.paidCalls) : "n/a"}</div>
            <p>{stats ? `${num(stats.burn.wallets)} paying wallet${stats.burn.wallets === 1 ? "" : "s"}` : "no counts here"}</p>
          </div>
          <div className="panel burnc">
            <div className="k">ETH sent to the burn by agents</div>
            <div className="v">
              {stats ? stats.burn.eth : "n/a"}
              <small> ETH</small>
            </div>
            <p>{stats ? (stats.burn.payments ? `${num(stats.burn.payments)} payments, last ${agoWords(new Date(stats.burn.last!).toISOString(), stats.asOf)}` : open ? "No paid call yet." : "Paid tools open at launch.") : "no counts here"}</p>
          </div>
        </div>
        <p className="small-note">Counted by PUSHD&apos;s engine. A payment is counted only after it is checked on the chain: to the burn pot, from the signing wallet, at least the price, recent and never used before.</p>
      </section>

      <section className="section">
        <div className="wrap">
          <div className="sec-head slim">
            <div>
              <div className="eyebrow">connect</div>
              <h2>One address. Any MCP client.</h2>
            </div>
            <p>Streamable HTTP, JSON answers, no sign-up. An API key is optional and only raises the free rate limit.</p>
          </div>
          <div className="endpoint panel">
            <span className="k">MCP endpoint</span>
            <code>{mcp}</code>
            <span className="k">REST</span>
            <code>{api}/&lt;tool&gt;</code>
            <span className="k">OpenAPI</span>
            <a href="/api/agent/openapi.json">
              <code>{api}/openapi.json</code>
            </a>
          </div>
          <div className="connect-grid">
            <CodeBlock title="Claude Code" code={`claude mcp add --transport http \\\n  pushd ${mcp}`} />
            <CodeBlock title="REST" code={`curl "${api}/feed?limit=5"\ncurl "${api}/item?id=dts02-6502-signer"`} />
            <CodeBlock title="Cursor  .cursor/mcp.json" code={`{\n  "mcpServers": {\n    "pushd": { "url": "${mcp}" }\n  }\n}`} />
            <CodeBlock title="Any MCP client" code={`{\n  "mcpServers": {\n    "pushd": {\n      "type": "http",\n      "url": "${mcp}",\n      "headers": { "X-PUSHD-Key": "optional" }\n    }\n  }\n}`} />
          </div>
          <p className="small-note">In the Claude apps: Settings, Connectors, add a custom connector with the MCP endpoint above.</p>
        </div>
      </section>

      <section className="section">
        <div className="wrap">
          <div className="sec-head slim">
            <div>
              <div className="eyebrow">tools</div>
              <h2>Seven tools, the same on both sides.</h2>
            </div>
            <p>Every tool answers with the scouts&apos; calls where there is one. Inputs are checked; nothing a tool returns is advice.</p>
          </div>
          <div className="panel tool-table">
            {TOOLS.map((t) => (
              <div key={t.name} className="tt-row">
                <code className="tt-name">{t.name}</code>
                <code className="tt-rest">/{t.rest}</code>
                <span className="tt-what">{t.what}</span>
                <span className={t.paid ? "tt-price paid" : "tt-price"}>{t.paid ? (price(t.paid) ? `${price(t.paid)} ETH` : "paid") : "free"}</span>
              </div>
            ))}
          </div>
          <div className="agent-scouts">
            <div className="faces" aria-hidden="true">
              {SCOUTS.map((s) => (
                <ScoutAvatar key={s.id} id={s.id} size={34} />
              ))}
            </div>
            <p>
              The calls come from PUSHD&apos;s five scouts, one per camp. Their records are public on the{" "}
              <Link className="textlink" href="/scouts">
                scouts page -&gt;
              </Link>
            </p>
          </div>
        </div>
      </section>

      <section className="section" id="pay">
        <div className="wrap">
          <div className="sec-head slim">
            <div>
              <div className="eyebrow">pay per call</div>
              <h2>Every paid call buys $PUSHD and burns it.</h2>
            </div>
            <p>
              Payments go to the $PUSHD burn pot, nowhere else. The pot spends the ETH it holds buying $PUSHD and burns it with the token&apos;s own
              burn, so the supply drops.
            </p>
          </div>
          <div className="pay-grid">
            <ol className="pay-steps">
              <li>
                <b>Ask.</b> Call a paid tool. The answer is <code>402</code> with the price in ETH, <code>payTo</code> (the burn pot) and{" "}
                <code>chainId</code> 4663.
              </li>
              <li>
                <b>Pay.</b> Send at least the price to <code>payTo</code> from a plain wallet, in an ordinary transfer.
              </li>
              <li>
                <b>Sign.</b> With the same wallet, <code>personal_sign</code> the text <code>PUSHD payment &lt;tx hash in lower case&gt;</code>.
              </li>
              <li>
                <b>Retry.</b> Send the hash and the signature as <code>X-PUSHD-Payment-Tx</code> and <code>X-PUSHD-Payment-Signature</code>. Over MCP,
                pass <code>payment: {"{ tx, signature }"}</code> to the tool.
              </li>
              <li>
                <b>Checked.</b> On the chain: to the burn pot, from the signer, at least the price, at most {limits?.paymentMaxAgeMinutes ?? 30} minutes old, and
                never used before. One payment pays for one call.
              </li>
            </ol>
            <div className="pay-code">
              <CodeBlock title="402 Payment Required" code={example402} note={open ? "live prices" : "opens at launch"} />
              <CodeBlock title="pay and retry (TypeScript, viem)" code={payCode} />
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="wrap">
          <div className="limits-grid">
            <div className="panel">
              <h3>Limits</h3>
              <ul className="xlist ok">
                <li>free tools: {limits?.freePerMinute ?? 30} calls a minute per address</li>
                <li>with a free API key: {limits?.keyPerMinute ?? 120} a minute</li>
                <li>paid tools: {limits?.paidPerHourPerWallet ?? 600} calls an hour per wallet</li>
                <li>deep reads: one at a time, within the scouts&apos; daily model budget</li>
              </ul>
            </div>
            <div className="panel">
              <h3>A free key</h3>
              <p className="muted">Optional. Shown once; PUSHD keeps only a hash. Send it as X-PUSHD-Key.</p>
              <CodeBlock title="make a key" code={`curl -X POST \\\n  ${api}/keys`} />
            </div>
            <div className="panel">
              <h3>Not advice</h3>
              <p className="muted">{NOT_ADVICE}</p>
              <p className="muted" style={{ marginTop: 10 }}>
                Public GitHub activity only. Nothing is promised, and every call is at your own risk.
              </p>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
