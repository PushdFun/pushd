import { readFileSync } from "node:fs";
import { join } from "node:path";

// SERVER ONLY. The logo files in public/brand as data addresses, for the pictures drawn on the server (favicon, app
// icons, share pictures), which cannot load a page address.
const dataUri = (file: string) => `data:image/png;base64,${readFileSync(join(process.cwd(), "public", "brand", file)).toString("base64")}`;

/** The mark on a clear ground. */
export const MARK_DATA = dataUri("pushd-mark.png");
/** The mark on its own black tile, for icons. */
export const TILE_DATA = dataUri("pushd-tile.png");
