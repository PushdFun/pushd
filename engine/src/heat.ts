// The heat score: how meme-able a line looks, 0 to 10, from named signals. Pure: it reads only what it is given.
// The site shows the signals as they are here ({label, points}), so every label is plain words.
import { isSilenceBreak, parseVersion, silenceDays } from "./filter.ts";
import type { Candidate, Context, Heat, Signal } from "./types.ts";

const DAY = 86_400_000;

/** Words traders watch for. In the name they count more than in the text. */
export const HOT_WORDS = ["coin", "token", "meme", "memecoin", "launch", "gm", "gn", "pump", "moon", "airdrop", "degen", "wagmi", "ngmi", "ape", "based", "hodl", "rug", "bonk", "pepe", "doge", "shib", "wojak", "chad"];

/** Words that make a name fun: animals, food, jokes, internet speak. */
export const FUN_WORDS = [
  "frog", "cat", "dog", "doggo", "duck", "goose", "fish", "monkey", "banana", "pizza", "taco", "burger", "potato", "cheese",
  "lol", "lmao", "joke", "toy", "silly", "yolo", "brr", "vibe", "vibes", "wtf", "bruh", "smol", "tiny", "chonk", "uwu",
  "rocket", "lambo", "ghost", "zombie", "wizard", "goblin", "dragon", "unicorn", "rainbow", "sparkle", "party", "dance",
  "magic", "cursed", "haunted", "doom", "tamagotchi", "arcade",
];

/** Words in the text that matter only as a meme, not as everyday tech words ("token" is often an API token). */
export const HOT_TEXT_WORDS = ["coin", "memecoin", "meme", "airdrop", "degen", "wagmi", "gm", "pump", "bonk", "pepe", "doge", "wojak", "moon"];

/** Retro computing: old chips and machines people love to share. */
export const RETRO_WORDS = ["6502", "65c02", "z80", "c64", "commodore", "amiga", "gameboy", "nes", "snes", "atari", "apple2", "msdos", "dos", "breadboard", "8bit", "cassette", "punchcard"];

const JOKE_README = [/\bjust for fun\b/i, /\bfor fun\b/i, /\bas a joke\b/i, /\b(joke|satire|parody|shitpost|meme)\b/i, /\bdo not use (this )?in production\b/i, /\bnot (a|financial) advice\b/i, /\blol\b|\blmao\b/i, /\bbecause why not\b/i];
const EMOJI = /\p{Extended_Pictographic}/u;
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|svg|mp4|webm)$/i;
const IMAGE_MD = /!\[[^\]]*\]\([^)]+\)|<img\s/i;

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** The heat level for a score. The same bands the site's legend shows. */
export function heatOf(score: number): Heat {
  if (score >= 8) return "veryHigh";
  if (score >= 6) return "high";
  if (score >= 4) return "medium";
  return "low";
}

/** Points for the account's size, by followers on GitHub. */
export function sizePoints(followers: number | undefined): Signal | null {
  if (followers == null) return null;
  if (followers >= 20_000) return { label: "account with a big following", points: 3 };
  if (followers >= 3_000) return { label: "well-known account", points: 2 };
  if (followers >= 1_000) return { label: "account with a following", points: 1 };
  return null;
}

const months = (days: number) => (days >= 60 ? `${Math.round(days / 30)} months` : `${days} days`);

export function score(c: Candidate, ctx: Context): { score: number; heat: Heat; signals: Signal[] } {
  const s: Signal[] = [];
  const add = (label: string, points: number) => s.push({ label, points });
  const repo = ctx.repo;
  let fresh = false; // something new, not routine work: only then does the account's size count

  // what happened
  switch (c.sub) {
    case "new-repo":
      add("new repo", 3);
      fresh = true;
      break;
    case "made-public":
      add("repo made public", 3);
      fresh = true;
      break;
    case "gist":
      add("public gist", 2);
      fresh = true;
      break;
    case "release": {
      const v = parseVersion(c.tag ?? "");
      if (v && v[0] >= 1 && v[1] === 0 && v[2] === 0) {
        add(`major release ${c.tag}`, 3);
        fresh = true;
      } else if (v && v[0] === 0 && v[1] <= 1 && v[2] === 0) {
        add(`first release ${c.tag}`, 2);
        fresh = true;
      } else add("release", 1);
      break;
    }
    case "push":
      add("push to an existing repo", 1);
      break;
  }

  // a long silence before it
  if (c.sub === "new-repo" && ctx.prevRepoCreatedAt) {
    const days = Math.floor((Date.parse(c.githubAt) - Date.parse(ctx.prevRepoCreatedAt)) / DAY);
    if (days >= 60) add(`first new repo in ${months(days)}`, 2);
  } else if (c.sub !== "new-repo" && isSilenceBreak(c, ctx)) {
    add(`first push in ${months(silenceDays(c, ctx) ?? 0)}`, 2);
    fresh = true;
  }

  // the name
  const name = c.sub === "gist" ? c.repo.replace(/\.[a-z0-9]+$/i, "") : c.repo;
  const nameWords = words(name);
  const hotInName = HOT_WORDS.find((w) => nameWords.includes(w));
  if (hotInName) add(`word "${hotInName}" in the name`, 3);
  if (nameWords.some((w) => FUN_WORDS.includes(w))) add("fun name", 2);
  else if (name.length <= 10 && nameWords.length <= 2 && !/^\d+$/.test(name) && c.sub !== "push") add("short name", 1);

  // the text: description, topics, README, gist
  const text = [repo?.description, ...(repo?.topics ?? []), repo?.readme?.slice(0, 800), c.gistDescription, c.gistFirstLine, c.releaseName]
    .filter(Boolean)
    .join(" ");
  const textWords = new Set(words(text));
  if (!hotInName) {
    const hotInText = HOT_TEXT_WORDS.find((w) => textWords.has(w));
    if (hotInText) add(`word "${hotInText}" in the text`, 2);
  }
  if (RETRO_WORDS.some((w) => nameWords.includes(w) || textWords.has(w))) add("retro computing theme", 1);
  if (repo?.description && EMOJI.test(repo.description)) add("emoji in the description", 1);
  if (repo?.readme && JOKE_README.some((re) => re.test(repo.readme ?? ""))) add("joke README", 2);
  if ((repo?.files ?? []).some((f) => IMAGE_FILE.test(f)) || (repo?.readme && IMAGE_MD.test(repo.readme))) add("images in the repo", 1);

  // who
  const size = sizePoints(ctx.entry.followers);
  if (size && fresh) add(size.label, size.points);

  const total = Math.min(10, s.reduce((n, x) => n + x.points, 0));
  return { score: total, heat: heatOf(total), signals: s };
}
