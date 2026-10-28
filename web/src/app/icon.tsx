import { ImageResponse } from "next/og";
import { TILE_DATA } from "@/lib/brand-files";

// The favicon: the mark on its black tile.
export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
   
  return new ImageResponse(<img src={TILE_DATA} width={32} height={32} alt="" style={{ borderRadius: 6 }} />, size);
}
