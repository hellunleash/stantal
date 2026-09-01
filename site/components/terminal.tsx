"use client";

import { useEffect, useRef, useState } from "react";
import { motion, useInView } from "motion/react";
import { cn } from "@/lib/utils";

/**
 * A terminal that replays a real session.
 *
 * Deliberately not a video. Text stays crisp at any zoom, it is selectable and
 * copyable, it weighs a few kilobytes instead of a few hundred, and it is not
 * subject to the rules browsers apply to autoplaying media. It also cannot be
 * quietly re-cut the way an edited screen recording can.
 *
 * **Every line here is output that actually happened.** The frames are captured
 * from real runs against real packages. For a product whose whole claim is that
 * it does not fabricate anything, a mocked-up demo would be the worst asset on
 * the page.
 *
 * **It must never sit empty.** The animation starts when the block scrolls into
 * view, which means it depends on an IntersectionObserver firing. Measured: in a
 * backgrounded tab Chrome does not fire one at all, while timers keep running —
 * so a reader who opens the page in a background tab and comes back would find
 * a terminal showing nothing but a prompt. That is worse than no demo. Two
 * guards below, and between them the finished output always appears.
 */

export type Line = { text: string; tone?: Tone };
type Tone = "dim" | "good" | "bad" | "warn" | "accent";

export type Frame = {
  /** Typed a character at a time, the way somebody would. */
  command: string;
  /** Printed after a pause, the way output arrives. */
  output: Line[];
  /** Extra beat before the next frame, for output worth reading. */
  hold?: number;
};

const TONE: Record<Tone, string> = {
  dim: "text-zinc-500",
  good: "text-emerald-400",
  bad: "text-rose-400",
  warn: "text-amber-300",
  accent: "text-violet-300",
};

const TYPE_MS = 38;
const OUTPUT_MS = 240;

/** How long to wait for the observer before assuming it is not coming. */
const FALLBACK_MS = 2000;

export function Terminal({
  frames,
  title = "bash",
  className,
}: {
  frames: Frame[];
  title?: string;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onScreen = useInView(ref, { once: true, amount: 0.3 });

  const [nudged, setNudged] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [frame, setFrame] = useState(0);
  const [typed, setTyped] = useState(0);
  const [shown, setShown] = useState(0);
  const [done, setDone] = useState(false);

  // Guard one: somebody who asked for less motion gets the finished output
  // straight away. The information is the point; the typing is decoration.
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (query.matches) setReduced(true);
  }, []);

  // Guard two: start anyway if the observer has not spoken. A timer is not a
  // substitute for knowing the block is visible, but an unplayed demo is a
  // worse failure than one that played slightly early.
  useEffect(() => {
    const t = setTimeout(() => setNudged(true), FALLBACK_MS);
    return () => clearTimeout(t);
  }, []);

  const running = (onScreen || nudged) && !reduced && !done;

  useEffect(() => {
    if (!running) return;
    const current = frames[frame];
    if (current === undefined) return;

    if (typed < current.command.length) {
      const t = setTimeout(() => setTyped((n) => n + 1), TYPE_MS);
      return () => clearTimeout(t);
    }
    if (shown < current.output.length) {
      const t = setTimeout(() => setShown((n) => n + 1), shown === 0 ? 400 : OUTPUT_MS);
      return () => clearTimeout(t);
    }
    // Stops on the last frame rather than looping. A loop keeps pulling the eye
    // back while somebody is trying to read the rest of the page.
    if (frame < frames.length - 1) {
      const t = setTimeout(() => {
        setFrame((n) => n + 1);
        setTyped(0);
        setShown(0);
      }, current.hold ?? 1300);
      return () => clearTimeout(t);
    }
    setDone(true);
    return;
  }, [running, frame, typed, shown, frames]);

  const complete = reduced;
  const visible = complete ? frames : frames.slice(0, frame);
  const current = complete ? undefined : frames[frame];

  return (
    <div
      ref={ref}
      className={cn(
        "overflow-hidden rounded-xl border border-white/5 bg-[#07090d]",
        "shadow-[0_1px_2px_rgba(0,0,0,.2),0_24px_56px_-24px_rgba(0,0,0,.7)]",
        className,
      )}
    >
      <div className="flex items-center gap-2 border-b border-white/5 bg-white/[0.03] px-4 py-3">
        <span className="size-2.5 rounded-full bg-zinc-700" />
        <span className="size-2.5 rounded-full bg-zinc-700" />
        <span className="size-2.5 rounded-full bg-zinc-700" />
        <span className="ml-2 font-mono text-[11px] text-zinc-600">{title}</span>
      </div>

      {/* Fixed height, so the page does not reflow under the reader as output
          arrives and push whatever they were reading down the screen. */}
      {/* `overflow-x` as well as `y`: the lines are `whitespace-pre`, and on a
          phone the longest package name runs past the edge. Without this the
          outer `overflow-hidden` clips it with no way to reach the rest. */}
      <div className="h-[24rem] overflow-auto px-5 py-4 font-mono text-[13px] leading-[1.75] sm:h-[26rem]">
        {visible.map((f, i) => (
          <Block key={i} command={f.command} lines={f.output} />
        ))}
        {current !== undefined && (
          <Block
            command={current.command.slice(0, typed)}
            lines={current.output.slice(0, shown)}
            caret={!done}
          />
        )}
      </div>
    </div>
  );
}

function Block({ command, lines, caret }: { command: string; lines: Line[]; caret?: boolean }) {
  return (
    <div className="mb-3 last:mb-0">
      <div className="text-zinc-100">
        <span className="select-none text-zinc-600">$ </span>
        {command}
        {caret && lines.length === 0 && (
          <span className="ml-px inline-block h-[1.05em] w-[7px] translate-y-[2px] animate-pulse bg-zinc-400" />
        )}
      </div>
      {lines.map((line, i) => (
        <motion.div
          key={i}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.15 }}
          className={cn("whitespace-pre", line.tone ? TONE[line.tone] : "text-zinc-300")}
        >
          {line.text === "" ? " " : line.text}
        </motion.div>
      ))}
    </div>
  );
}
