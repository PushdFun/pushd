// The deep read: what a scout opens before it says what a new repo or release really is. Within strict limits:
// the repo's facts (one API request), the README (raw host, at most PUSHD_SCOUT_README_BYTES), the file tree (one API
// request, at most PUSHD_SCOUT_TREE paths) and a few main files (raw host, at most PUSHD_SCOUT_FILES of
// PUSHD_SCOUT_FILE_BYTES each). Binary files are skipped. Everything read here is untrusted (src/scouts/guard.ts).
import type { GhRepo, GitHub } from "../github.ts";
import type { ScoutConfig } from "./config.ts";

export type RepoRead = {
  fullName: string;
  description: string | null;
  topics: string[];
  language: string | null;
  fork: boolean;
  archived: boolean;
  stars: number;
  createdAt: string;
  pushedAt: string | null;
  defaultBranch: string;
  readme: string | null;
  tree: string[];
  treeTruncated: boolean;
  files: { path: string; text: string }[];
  /** characters read from the repo in all */
  chars: number;
};

export type ReadLimits = Pick<ScoutConfig, "readmeBytes" | "files" | "fileBytes" | "tree">;

const SKIP_DIR = /(^|\/)(node_modules|vendor|dist|build|target|\.git|\.next|__pycache__|third_party|deps)\//;
const BINARY = /\.(png|jpe?g|gif|webp|ico|svg|pdf|zip|gz|tar|wasm|bin|so|dylib|dll|exe|mp4|webm|mp3|wav|ttf|otf|woff2?|lock)$/i;

/** The main files worth opening, best first: manifests, then entry points, then the first source files. */
export function pickFiles(tree: string[], n: number): string[] {
  const top = [/^package\.json$/, /^Cargo\.toml$/, /^pyproject\.toml$/, /^go\.mod$/, /^foundry\.toml$/, /^Anchor\.toml$/, /^Move\.toml$/, /^setup\.py$/, /^Makefile$/];
  const entry = [
    /^src\/(main|lib|index)\.(rs|ts|tsx|js|py|go|c|zig|swift)$/,
    /^(main|index|app|cli)\.(rs|ts|js|py|go|c|zig|swift|sh)$/,
    /^src\/[^/]+\.(rs|ts|js|py|go|c|zig|swift)$/,
    /^(contracts|programs|src)\/[^/]+\.(sol|move|rs)$/,
    /^[^/]+\.(asm|s|c|py|js|ts|rs|go|sol)$/i,
  ];
  const out: string[] = [];
  const add = (re: RegExp) => {
    for (const p of tree) if (out.length < n && re.test(p) && !out.includes(p) && !BINARY.test(p)) out.push(p);
  };
  for (const re of top) if (out.length < Math.min(n, 1)) add(re);
  for (const re of entry) add(re);
  for (const re of top) add(re);
  return out.slice(0, n);
}

/** Reads one repo within the limits. Null when the repo cannot be read (missing, private, or GitHub refused). */
export async function readRepoDeep(gh: GitHub, fullName: string, lim: ReadLimits): Promise<RepoRead | null> {
  if (!/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(fullName)) return null;
  const r = await gh.get<GhRepo & { archived?: boolean; topics?: string[] }>(`/repos/${fullName}`);
  if (!r.data || r.data.private) return null;
  const repo = r.data;
  const branch = repo.default_branch || "HEAD";
  const raw = (path: string, max: number) => gh.raw(`https://raw.githubusercontent.com/${repo.full_name}/${encodeURIComponent(branch)}/${path.split("/").map(encodeURIComponent).join("/")}`, max);

  let readme: string | null = null;
  for (const name of ["README.md", "readme.md", "README", "README.markdown", "README.rst", "README.txt", "Readme.md"]) {
    const t = await raw(name, lim.readmeBytes);
    if (t != null) {
      readme = t;
      break;
    }
  }

  let tree: string[] = [];
  let treeTruncated = false;
  if (lim.tree > 0) {
    const t = await gh.get<{ tree?: { path: string; type: string }[]; truncated?: boolean }>(`/repos/${repo.full_name}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
    const all = (t.data?.tree ?? []).filter((e) => e.type === "blob" || e.type === "tree").map((e) => (e.type === "tree" ? `${e.path}/` : e.path));
    const kept = all.filter((p) => !SKIP_DIR.test(p));
    tree = kept.slice(0, lim.tree);
    treeTruncated = !!t.data?.truncated || kept.length > tree.length;
  }

  const files: { path: string; text: string }[] = [];
  for (const path of pickFiles(tree.filter((p) => !p.endsWith("/")), lim.files)) {
    const text = await raw(path, lim.fileBytes);
    if (text != null && !text.includes("\u0000")) files.push({ path, text });
  }

  const chars = (readme?.length ?? 0) + tree.join("\n").length + files.reduce((n, f) => n + f.text.length, 0);
  return {
    fullName: repo.full_name,
    description: repo.description,
    topics: repo.topics ?? [],
    language: repo.language,
    fork: repo.fork,
    archived: !!repo.archived,
    stars: repo.stargazers_count,
    createdAt: repo.created_at,
    pushedAt: repo.pushed_at,
    defaultBranch: branch,
    readme,
    tree,
    treeTruncated,
    files,
    chars,
  };
}
