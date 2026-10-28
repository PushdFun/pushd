import type { Metadata } from "next";
import { DaysEmpty, ReplayView } from "@/components/ReplayView";
import { getDay, getDays } from "@/lib/data-days";

export const metadata: Metadata = {
  title: "PUSHD Replay",
  description: "A day of builders' public GitHub activity, played back in 60 seconds, with the hot moments flagged.",
  alternates: { canonical: "/replay" },
};

/** The latest day with activity. */
export default async function ReplayLatest() {
  const list = await getDays();
  const latest = list?.days[0]?.day;
  const day = latest ? await getDay(latest) : null;
  if (!list || !day) return <DaysEmpty what="replay" offline={!list} />;
  return <ReplayView day={day} days={list.days} />;
}
