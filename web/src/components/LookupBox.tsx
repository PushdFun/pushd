// "Look up anyone on GitHub": a plain form that opens the search page (/gh?q=). Works without a script.

export function LookupBox({ q = "", autoFocus = false, compact = false }: { q?: string; autoFocus?: boolean; compact?: boolean }) {
  return (
    <form className={compact ? "lookup compact" : "lookup"} action="/gh" method="get" role="search">
      <label className="lookup-in">
        <span aria-hidden="true">gh</span>
        <input
          name="q"
          type="search"
          defaultValue={q}
          placeholder="a username, owner/repo, or a few words"
          aria-label="Look up anyone on GitHub"
          autoComplete="off"
          spellCheck={false}
          autoFocus={autoFocus}
          maxLength={100}
        />
      </label>
      <button className="btn btn-acc" type="submit">
        Look up
      </button>
    </form>
  );
}
