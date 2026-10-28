import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Unit tests for the site's own logic (src/**/*.test.ts): the launch page's checks and calldata. The built site has
// its own smoke test (test/smoke.test.mjs).
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { include: ["src/**/*.test.ts"], environment: "node" },
});
