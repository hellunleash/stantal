"use client";

import { useEffect, useState } from "react";
import { Logo, GitHubMark, NpmMark } from "@/components/logo";
import { cn } from "@/lib/utils";

const REPO = "https://github.com/hellunleash/stantal";
const NPM = "https://www.npmjs.com/package/stantal";

const LINKS = [
  { href: "#why", label: "Why now" },
  { href: "#how", label: "How it breaks" },
  { href: "#numbers", label: "Numbers" },
  { href: "#providers", label: "For API teams" },
];

/**
 * The top bar.
 *
 * Two jobs, and only two. Say the name, and get somebody to the repository.
 * Everything else on this page is asking a sceptical reader to believe a
 * measurement, and the fastest way to settle that is to let them go and read
 * the code, so the repo link is the one thing that never scrolls away.
 *
 * The border appears only once the page has moved. At the top the nav should
 * sit on the hero without drawing a line across it; the moment content slides
 * underneath, the line is what stops the two from blending into each other.
 */
export function Nav() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={cn(
        "sticky top-0 z-50 transition-colors duration-200",
        "bg-white/70 backdrop-blur-xl dark:bg-zinc-950/70",
        scrolled
          ? "border-b border-zinc-200/80 dark:border-zinc-800/80"
          : "border-b border-transparent",
      )}
    >
      <nav className="mx-auto flex h-14 max-w-5xl items-center gap-3 px-5">
        <a
          href="#top"
          className="flex items-center gap-2 rounded-md font-semibold tracking-[-0.02em] outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
        >
          <Logo className="size-[18px] text-violet-600 dark:text-violet-400" />
          <span>Stantal</span>
        </a>

        <span className="hidden rounded-full border border-zinc-200 px-2 py-0.5 font-mono text-[10px] text-zinc-500 sm:inline dark:border-zinc-800">
          v0.5.0
        </span>

        <div className="flex-1" />

        <ul className="hidden items-center gap-6 text-[13px] text-zinc-600 md:flex dark:text-zinc-400">
          {LINKS.map((link) => (
            <li key={link.href}>
              <a
                href={link.href}
                className="rounded transition-colors hover:text-zinc-950 focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:outline-none dark:hover:text-zinc-50"
              >
                {link.label}
              </a>
            </li>
          ))}
        </ul>

        <div className="ml-1 flex items-center gap-1 md:ml-5">
          <a
            href={NPM}
            aria-label="Stantal on npm"
            className="hidden rounded-md p-2 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:outline-none sm:block dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
          >
            <NpmMark className="size-4" />
          </a>
          <a
            href={REPO}
            className="flex items-center gap-2 rounded-lg bg-zinc-900 px-3 py-1.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:outline-none dark:bg-zinc-100 dark:text-zinc-900"
          >
            <GitHubMark className="size-3.5" />
            <span>GitHub</span>
          </a>
        </div>
      </nav>
    </header>
  );
}
