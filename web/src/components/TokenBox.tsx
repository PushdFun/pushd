import { chainLabel, chainShort, pairAge, shortAddress, symbolOf, usd } from "@/lib/market";
import { shortDate } from "@/lib/format";
import type { RankToken } from "@/lib/types";

// The token box on a project's page and an item's page: its symbol, chain and address, the DexScreener page as a plain
// link, and the market numbers as PUSHD read them, with the time. Information only: never a buy button here.

export function TokenBox({ token, project }: { token: RankToken; project?: string | null }) {
  const sym = symbolOf(token);
  return (
    <div className="panel token-box" aria-label="The project's token">
      <div className="ptitle">
        <h3>The token</h3>
        <span>as read{token.readAt ? ` ${shortDate(token.readAt)}, ${token.readAt.slice(11, 16)} UTC` : ""}</span>
      </div>
      <div className="tb-head">
        <span className="tb-sym">{sym ?? token.name ?? "token"}</span>
        <span className="tag chain-tag">{chainLabel(token.chain)}</span>
        {project && <span className="tb-name">{project}</span>}
      </div>
      <dl className="tb-facts">
        <div>
          <dt>trading for</dt>
          <dd>{pairAge(token.pairDays)}</dd>
        </div>
        <div>
          <dt>liquidity</dt>
          <dd>{usd(token.liquidityUsd)}</dd>
        </div>
        <div>
          <dt>24h volume</dt>
          <dd>{usd(token.volumeUsd)}</dd>
        </div>
      </dl>
      <div className="tb-foot">
        <span className="mono muted" title={token.address}>
          {shortAddress(token.address)}
        </span>
        {token.url && (
          <a className="textlink" href={token.url} target="_blank" rel="noopener noreferrer">
            DexScreener -&gt;
          </a>
        )}
      </div>
      <p className="footnote">Market numbers as DexScreener showed them when PUSHD read them. Information, not advice.</p>
    </div>
  );
}

/** The small "$SYM  Chain" pair beside a project's name in lists. */
export function TokenTag({ token, compact = false }: { token?: RankToken | null; compact?: boolean }) {
  if (!token) return null;
  const sym = symbolOf(token);
  return (
    <span className="ttag">
      {sym && <span className="tsym">{sym}</span>}
      <span className="tchain" title={chainLabel(token.chain)}>
        {compact ? chainShort(token.chain) : chainLabel(token.chain)}
      </span>
    </span>
  );
}
