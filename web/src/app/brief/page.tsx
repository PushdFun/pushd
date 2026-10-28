import type { Metadata } from "next";
import { BriefView } from "@/components/BriefView";
import { DaysEmpty } from "@/components/ReplayView";
import { getDay, getDays } from "@/lib/data-days";

export const metadata: Metadata = {
  title: "PUSHD Brief",
  description: "What the watched projects shipped, day by day: the hottest lines, the busiest projects, quiet and busy camps.",
  alternates: { canonical: "/brief" },
};

/** The latest day with activity. */
export default async function BriefLatest() {
  const list = await getDays();
  const latest = list?.days[0]?.day;
  const day = latest ? await getDay(latest) : null;
  if (!list || !day) return <DaysEmpty what="brief" offline={!list} />;
  return <BriefView day={day} days={list.days} />;
}
