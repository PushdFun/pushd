import type { Metadata } from "next";
import { FeedView } from "@/components/FeedView";
import { Heat } from "@/components/Heat";
import { getFeed, getHolder, getStats } from "@/lib/data";

export const metadata: Metadata = {
  title: "PUSHD Feed",
  description: "The live feed of public GitHub activity from the most active crypto projects on GitHub right now.",
  alternates: { canonical: "/feed" },
};

type Props = { searchParams: Promise<{ [key: string]: string | string[] | undefined }> };

export default async function FeedPage({ searchParams }: Props) {
  const [feed, stats, q] = await Promise.all([getFeed(), getStats(), searchParams]);
  const holder = feed.live ? await getHolder() : null;
  const v = Array.isArray(q.view) ? q.view[0] : q.view;
  const urlView = v === "gallery" || v === "log" ? v : null;
  return (
    <FeedView
      feed={feed}
      delayMinutes={stats.publicDelayMinutes}
      urlView={urlView}
      mine={holder ? { follow: holder.prefs.follow, mute: holder.prefs.mute } : null}
      legend={
        <div className="legend">
          <div className="panel">
            <Heat heat="low" />
            <p>Worth a look for people who follow this builder.</p>
          </div>
          <div className="panel">
            <Heat heat="medium" />
            <p>A real release or a new repo with a clear idea.</p>
          </div>
          <div className="panel">
            <Heat heat="high" />
            <p>New, short, catchy. The kind of thing that gets shared.</p>
          </div>
          <div className="panel">
            <Heat heat="veryHigh" />
            <p>Fun name, a joke, or a word like coin. Very meme-able.</p>
          </div>
        </div>
      }
    />
  );
}
