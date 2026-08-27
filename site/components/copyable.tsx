"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The command, with one click to take it.
 *
 * The whole page exists to get somebody to run one line. Making them select it
 * by hand — and risk catching the `$` — is friction at the exact moment they
 * had decided to try it.
 *
 * The clipboard write can fail: an insecure origin, a browser that refuses, a
 * permission denied. It is caught and the button simply does not change, which
 * leaves the text there to select. A copy button that lies about having copied
 * is worse than no button.
 */
export function Copyable({ command, className }: { command: string; className?: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Left selectable. Nothing is claimed that did not happen.
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={`Copy: ${command}`}
      className={cn(
        "group flex w-full items-center gap-3 overflow-x-auto rounded-xl px-5 py-4 text-left",
        "bg-zinc-900 text-zinc-50 dark:bg-zinc-100 dark:text-zinc-900",
        "font-mono text-[15px] transition-opacity hover:opacity-90",
        className,
      )}
    >
      <span className="select-none opacity-40">$</span>
      <span className="flex-1 whitespace-nowrap">{command}</span>
      {copied ? (
        <Check className="size-4 shrink-0 opacity-70" aria-hidden />
      ) : (
        <Copy className="size-4 shrink-0 opacity-0 transition-opacity group-hover:opacity-50" aria-hidden />
      )}
    </button>
  );
}
