import { ImageResponse } from "next/og";
import { TILE_DATA } from "@/lib/brand-files";

// The app icons for the install manifest (src/app/manifest.ts): the mark on its black tile at 192 and 512. The tile
// keeps the mark inside the middle two thirds, so the same picture is safe as the maskable icon (a phone may crop to a
// circle).
const SIZES: Record<string, { px: number }> = {
  "192": { px: 192 },
  "512": { px: 512 },
  maskable: { px: 512 },
};

export async function GET(_req: Request, ctx: { params: Promise<{ size: string }> }) {
  const s = SIZES[(await ctx.params).size];
  if (!s) return new Response("no such icon", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  const img = new ImageResponse(
    (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={TILE_DATA} width={s.px} height={s.px} alt="" />
    ),
    { width: s.px, height: s.px },
  );
  img.headers.set("cache-control", "public, max-age=86400");
  return img;
}
