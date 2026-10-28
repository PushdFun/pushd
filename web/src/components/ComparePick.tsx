"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { bare } from "@/lib/format";

// Pick two or three builders to compare; the choice goes in the address (/compare?b=a,b,c), so it can be shared.
export function ComparePick({ all, chosen }: { all: { handle: string; name?: string }[]; chosen: string[] }) {
  const router = useRouter();
  const [pick, setPick] = useState<string[]>([...chosen, "", "", ""].slice(0, 3));
  const go = (next: string[]) => {
    setPick(next);
    const list = [...new Set(next.filter(Boolean))];
    if (list.length) router.push(`/compare?b=${list.map(encodeURIComponent).join(",")}`);
  };
  return (
    <div className="cmp-pick" role="group" aria-label="Builders to compare">
      {pick.map((v, i) => (
        <select key={i} className="select" value={v} aria-label={`Builder ${i + 1}`} onChange={(e) => go(pick.map((p, j) => (j === i ? e.target.value : p)))}>
          <option value="">{i < 2 ? `builder ${i + 1}` : "a third (optional)"}</option>
          {all.map((b) => (
            <option key={b.handle} value={bare(b.handle)}>
              {b.handle}
              {b.name && b.name !== b.handle ? ` (${b.name})` : ""}
            </option>
          ))}
        </select>
      ))}
    </div>
  );
}
