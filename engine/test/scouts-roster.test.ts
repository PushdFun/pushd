// The site keeps its own copy of the five scouts (web/src/lib/scouts.ts): it must say exactly what the engine says.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "../src/config.ts";
import { SCOUTS } from "../src/scouts/roster.ts";

test("the site's roster is the engine's, word for word", async () => {
  const path = pathToFileURL(join(ROOT, "..", "web", "src", "lib", "scouts.ts")).href;
  const web = (await import(path)) as { SCOUTS: typeof SCOUTS };
  // the site carries everything but the model ids and prices, which only the engine needs
  const siteOnly = (s: (typeof SCOUTS)[number]) => {
    const rest: Record<string, unknown> = { ...s };
    for (const k of ["model", "deepModel", "price", "deepPrice"]) delete rest[k];
    return rest;
  };
  assert.deepEqual(web.SCOUTS, SCOUTS.map(siteOnly));
});
