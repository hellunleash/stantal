"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

/**
 * The prompt somebody pastes into their agent.
 *
 * A block rather than a line, because it is a sentence and wrapping it into a
 * terminal strip would make it look like a command to type. The copy button is
 * the whole point: nobody transcribes three lines of prose by hand, and asking
 * them to select it exactly — without catching the quote marks — is friction at
 * the moment they had decided to try it.
 *
 * The clipboard write can fail on an insecure origin or a locked-down browser.
 * It is caught, the button stays unchanged, and the text is still selectable. A
 * button that claims to have copied when it has not is worse than no button.
 */
export function CopyablePrompt({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Nothing claimed that did not happen.
    }
  }

  return (
    <div className="relative rounded-r-lg border border-l-[3px] border-zinc-200 border-l-violet-500 bg-zinc-50 py-4 pl-5 pr-14 dark:border-zinc-800 dark:border-l-violet-400 dark:bg-zinc-900/50">
      <p className="text-[15px] leading-relaxed text-zinc-800 dark:text-zinc-200">{text}</p>
      <button
        type="button"
        onClick={copy}
        aria-label="Copy prompt"
        className="absolute right-3 top-3 rounded-md p-2 text-zinc-400 transition-colors hover:bg-zinc-200/60 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
      >
        {copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
      </button>
    </div>
  );
}
