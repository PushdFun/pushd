import type { Metadata } from "next";
import Link from "next/link";
import { Prompt } from "@/components/Prompt";

export const metadata: Metadata = { title: "PUSHD: not found", robots: { index: false } };

export default function NotFound() {
  return (
    <section className="page-head lost">
      <div className="wrap">
        <Prompt path="~/pushd" cmd="cd" />
        <h1>
          No such page<span className="acc">.</span>
        </h1>
        <p className="lede">404. The line or page you asked for is not here. It may never have existed, or it was a typo.</p>
        <div className="hero-cta">
          <Link className="btn btn-acc" href="/feed">
            Open the feed <span aria-hidden="true">-&gt;</span>
          </Link>
          <Link className="btn btn-line" href="/">
            Home
          </Link>
        </div>
      </div>
    </section>
  );
}
