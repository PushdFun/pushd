"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** Signs out of GitHub on PUSHD (the holder's wallet sign-in stays as it is). */
export function BuildSignOut() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-line"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await fetch("/api/build/signout", { method: "POST" }).catch(() => null);
        setBusy(false);
        router.refresh();
      }}
    >
      Sign out of GitHub
    </button>
  );
}
