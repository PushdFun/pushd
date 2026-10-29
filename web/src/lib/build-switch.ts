// The switch for PUSHD Agents on the site: PUSHD_AGENTS=on (the same setting as the engine's). Anything else, or
// nothing, and /build, /shipped, /api/build are 404s and the nav has no Build entry.
export const agentsOn = (env: Record<string, string | undefined> = process.env) => env.PUSHD_AGENTS?.trim().toLowerCase() === "on";

/** The builder's calls the site passes to the engine (src/app/api/build/[...path]); everything else is a 404. */
export const BUILD_ROUTES: { re: RegExp; methods: string[] }[] = [
  { re: /^me$/, methods: ["GET"] },
  { re: /^draft$/, methods: ["POST"] },
  { re: /^agents$/, methods: ["GET", "POST"] },
  { re: /^agents\/[a-f0-9]{16}$/, methods: ["GET", "PATCH", "DELETE"] },
  { re: /^agents\/[a-f0-9]{16}\/run$/, methods: ["POST"] },
  { re: /^runs\/[a-f0-9]{16}\/(pay|approve)$/, methods: ["POST"] },
  { re: /^inbox\/seen$/, methods: ["POST"] },
  { re: /^scouts\/vote$/, methods: ["POST"] },
];

export const buildRouteOk = (path: string, method: string) => BUILD_ROUTES.some((r) => r.re.test(path) && r.methods.includes(method));
