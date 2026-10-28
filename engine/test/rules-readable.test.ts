// The site writes a rule's plain sentence while the holder edits it (web/src/lib/rules.ts): it must be the engine's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "../src/config.ts";
import { readable, type Rule } from "../src/scouts/rules.ts";

test("the site's rule sentence is the engine's", async () => {
  const web = (await import(pathToFileURL(join(ROOT, "..", "web", "src", "lib", "rules.ts")).href)) as { readable: (r: Rule) => string };
  const rules: Rule[] = [
    { builders: ["aeyakovenko", "garious"], camps: [], kinds: ["repo"], keywords: ["tokens", "payments"], heatFloor: 0 },
    { builders: [], camps: ["ai", "oss"], kinds: ["release", "repo", "gist"], keywords: [], heatFloor: 6 },
    { builders: ["a", "b", "c", "d", "e", "f", "g", "h"], camps: ["chain"], kinds: [], keywords: ["coin"], heatFloor: 8 },
    { builders: [], camps: [], kinds: ["push"], keywords: [], heatFloor: 0 },
  ];
  for (const r of rules) assert.equal(web.readable(r), readable(r));
});
