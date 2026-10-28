import { ImageResponse } from "next/og";
import { TILE_DATA } from "@/lib/brand-files";

// The home-screen icon: the mark on its black tile.
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
   
  return new ImageResponse(<img src={TILE_DATA} width={180} height={180} alt="" />, size);
}
