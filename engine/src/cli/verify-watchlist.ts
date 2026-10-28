// Checks every handle on the watchlist against GitHub's API: it must exist, be spelled the same, and be the same
// kind of account (person or org). Prints each one's name, site and followers so a person can hold them to the
// `source` line. `--write` also refreshes the followers counts in data/watchlist.json (they drive the heat's
// "account size" signal). Without a token it stops when the hourly limit runs low; run it again after the reset
// (answers already read come from the cache).
//   npm run verify-watchlist [-- --write] [-- --only a,b]
import { writeFileSync } from "node:fs";
import { config } from "../config.ts";
import { arg, log, setup } from "./common.ts";

type GhUser = { login: string; type: "User" | "Organization"; name: string | null; blog: string | null; bio: string | null; followers: number; public_repos: number };

const { wl, gh, accounts, db } = setup();
const write = arg("write") !== undefined;
let bad = 0;
let checked = 0;
for (const e of accounts) {
  if (gh.rate && gh.rate.remaining <= 3 && !gh.authenticated) {
    log(`stopping: ${gh.rate.remaining} requests left until ${new Date(gh.rate.resetAt).toISOString().slice(11, 19)} UTC; run it again after that`);
    break;
  }
  const r = await gh.get<GhUser>(`/users/${e.handle}`);
  checked++;
  if (!r.data) {
    bad++;
    console.log(`MISSING  ${e.handle} (${r.status})`);
    continue;
  }
  const u = r.data;
  const problems = [
    u.login !== e.handle ? `spelled ${u.login} on GitHub` : null,
    (u.type === "Organization") !== (e.type === "org") ? `is a ${u.type} on GitHub` : null,
  ].filter(Boolean);
  if (problems.length) bad++;
  console.log(`${problems.length ? "CHECK   " : "ok      "} ${e.handle.padEnd(20)} ${String(u.followers).padStart(7)} followers  ${u.name ?? "(no name)"}${u.blog ? "  " + u.blog : ""}${problems.length ? "  <- " + problems.join(", ") : ""}`);
  if (write) {
    const target = wl.accounts.find((a) => a.handle === e.handle)!;
    target.followers = u.followers >= 1000 ? Math.round(u.followers / 100) * 100 : u.followers;
  }
}
if (write) {
  writeFileSync(config.watchlistPath, JSON.stringify(wl, null, 2) + "\n");
  log(`followers refreshed in ${config.watchlistPath}`);
}
log(`${checked} of ${accounts.length} checked, ${bad} to look at; ${gh.requests} request(s)`);
db.close();
process.exit(bad ? 1 : 0);
