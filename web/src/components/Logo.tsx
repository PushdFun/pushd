import Link from "next/link";

// The logo: the green P mark (public/brand/pushd-mark.png on a clear ground, pushd-tile.png on its black tile). The
// header, the footer, the holders page, the favicon, the app icons and the share pictures all draw it from here.

/** The mark. `src` defaults to the file on the site; the pictures drawn on the server hand in a data address. */
export function Mark({ size, src = "/brand/pushd-mark.png" }: { size?: number; src?: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} width={size} height={size} alt="" aria-hidden="true" draggable={false} style={{ display: "block" }} />;
}

/** The mark leading home; with the PUSHD wordmark beside it unless `word` is off (the header shows the mark alone). */
export function Brand({ word = true }: { word?: boolean }) {
  return (
    <Link className={word ? "brand" : "brand mark-only"} href="/" aria-label="PUSHD home">
      <span className="mark">
        <Mark />
      </span>
      {word && (
        <span className="word">
          PUSHD<i aria-hidden="true">_</i>
        </span>
      )}
    </Link>
  );
}

/** The colours around the mark where there is no theme (the install manifest). */
export const MARK_COLORS = { accent: "#a6ff4d", ink: "#0a0c0b", bg: "#0a0c0b" };
