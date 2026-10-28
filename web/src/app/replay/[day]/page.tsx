import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DaysEmpty, ReplayView } from "@/components/ReplayView";
import { dayWords } from "@/lib/brief";
import { DAY_RE, getDay, getDays } from "@/lib/data-days";

type Props = { params: Promise<{ day: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { day } = await params;
  if (!DAY_RE.test(day)) return { title: "PUSHD Replay" };
  return {
    title: `PUSHD Replay . ${dayWords(day, true)}`,
    description: `${dayWords(day, true)}: the watched projects' public GitHub activity, played back in 60 seconds.`,
    alternates: { canonical: `/replay/${day}` },
  };
}

export default async function ReplayDay({ params }: Props) {
  const { day } = await params;
  if (!DAY_RE.test(day)) notFound();
  const [list, detail] = await Promise.all([getDays(), getDay(day)]);
  if (!list) return <DaysEmpty what="replay" offline />;
  if (!detail) notFound();
  return <ReplayView day={detail} days={list.days} />;
}
