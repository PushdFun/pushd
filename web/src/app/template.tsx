import { ViewTransition } from "react";

// Page transitions. A template mounts afresh on every navigation (a layout does not), so the page that leaves gets an
// exit and the page that arrives an enter: the old one fades out with a touch of blur, the new one fades in with a
// small lift (the "page-out" and "page-in" rules in globals.css, through the browser's View Transitions API; a
// browser without it gets a plain CSS fade-in, and reduced motion gets an instant swap). The header and the live
// stream live in the layout and stay put.
export default function Template({ children }: { children: React.ReactNode }) {
  return (
    <ViewTransition enter="page-in" exit="page-out" default="none">
      <div className="page">{children}</div>
    </ViewTransition>
  );
}
