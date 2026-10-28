import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BriefView } from "@/components/BriefView";
import { DaysEmpty } from "@/components/ReplayView";
import { dayWords } from "@/lib/brief";
import { DAY_RE, getDay, getDays } from "@/lib/data-days";

type Props = { params: Promise<{ day: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { day } = await params;
  if (!DAY_RE.test(day)) return { title: "PUSHD Brief" };
  return {
    title: `PUSHD Brief . ${dayWords(day, true)}`,
    description: `What the watched projects shipped on ${dayWords(day, true)}: the hottest lines, the busiest projects, quiet and busy camps.`,
    alternates: { canonical: `/brief/${day}` },
  };
}

export default async function BriefDay({ params }: Props) {
  const { day } = await params;
  if (!DAY_RE.test(day)) notFound();
  const [list, detail] = await Promise.all([getDays(), getDay(day)]);
  if (!list) return <DaysEmpty what="brief" offline />;
  if (!detail) notFound();
  return <BriefView day={detail} days={list.days} />;
}
