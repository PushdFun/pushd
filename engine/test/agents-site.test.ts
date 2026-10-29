// The site keeps its own copy of the agents' jobs and triggers (web/src/lib/build.ts): it must say exactly what the
// engine's whitelist says (src/agents/spec.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "../src/config.ts";
import { JOB_IDS, JOBS, TRIGGER_LABEL, TRIGGERS } from "../src/agents/spec.ts";

test("the site's jobs and triggers are the engine's, word for word", async () => {
  const web = (await import(pathToFileURL(join(ROOT, "..", "web", "src", "lib", "build.ts")).href)) as { JOB_IDS: typeof JOB_IDS; JOBS: typeof JOBS; TRIGGERS: typeof TRIGGERS; TRIGGER_LABEL: typeof TRIGGER_LABEL };
  assert.deepEqual(web.JOB_IDS, JOB_IDS);
  assert.deepEqual(web.JOBS, JOBS);
  assert.deepEqual(web.TRIGGERS, TRIGGERS);
  assert.deepEqual(web.TRIGGER_LABEL, TRIGGER_LABEL);
});
