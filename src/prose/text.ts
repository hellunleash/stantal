/**
 * Reading a tool description as text.
 *
 * Two operations carry the whole layer: split a description into sentences, and
 * decide whether a sentence refers to a named parameter.
 *
 * The second one is harder than it looks, and getting it wrong produces exactly
 * the false finding this project exists to avoid. A parameter called `app` on a
 * tool that builds apps appears in almost every sentence as an ordinary English
 * word. Matching the bare word would report a parameter as documented when
 * nothing in the prose is about it — or the reverse. So a reference only counts
 * when the text marks it as one.
 */

/** How a parameter was referred to, kept because it is the evidence. */
export type MentionForm = "code-span" | "quoted" | "directive";

export type Mention = {
  param: string;
  form: MentionForm;
  /** The exact span, verbatim from the description. */
  quote: string;
};

/**
 * Sentence split.
 *
 * Deliberately simple. Descriptions are prose written for a model, not prose
 * with citations, and the common abbreviations are handled by refusing to split
 * on them. An em-dash clause is kept with its sentence: "Pass `slot` only when X
 * — the host publishes those" is one instruction, and cutting it in half would
 * let a rule claim half a sentence was removed.
 */
const ABBREVIATIONS = ["e.g.", "i.e.", "etc.", "vs.", "cf.", "approx.", "no."];

export function sentences(text: string): string[] {
  const guarded = ABBREVIATIONS.reduce(
    (acc, abbr) => acc.split(abbr).join(abbr.replace(/\./g, "\u0000")),
    text,
  );

  return guarded
    .split(/(?<=[.!?])[\s\n]+(?=[A-Z`"'(—-])/)
    .map((s) => s.replace(/\u0000/g, ".").replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 0);
}

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Does this text refer to `param` as a parameter?
 *
 * Only marked references count:
 *
 * - a code span — `` `app` `` — the convention nearly every published tool
 *   description uses;
 * - a quoted name — "app";
 * - a directive — "pass app", "omit app", "set app to…" — where a verb that only
 *   makes sense about an argument sits immediately before the name.
 *
 * A bare occurrence of the word is not a reference. That is the whole point.
 */
const DIRECTIVES = [
  "pass",
  "passing",
  "set",
  "provide",
  "supply",
  "omit",
  "omitting",
  "include",
  "including",
  "specify",
  "give",
  "leave out",
  "fill",
  "populate",
];

export function mentionsParameter(text: string, param: string): Mention | null {
  const name = escapeForRegex(param);

  const codeSpan = new RegExp("`\\s*" + name + "\\s*`").exec(text);
  if (codeSpan) return { param, form: "code-span", quote: codeSpan[0] };

  const quoted = new RegExp("[\"'“‘]" + name + "[\"'”’]").exec(text);
  if (quoted) return { param, form: "quoted", quote: quoted[0] };

  const directive = new RegExp(
    "\\b(?:" + DIRECTIVES.join("|") + ")\\b(?:\\s+(?:the|a|an|in|out))?\\s+`?" + name + "`?\\b",
    "i",
  ).exec(text);
  if (directive) return { param, form: "directive", quote: directive[0] };

  return null;
}

/** Every parameter this sentence refers to. */
export function mentionedParameters(text: string, params: readonly string[]): Mention[] {
  return params.map((p) => mentionsParameter(text, p)).filter((m): m is Mention => m !== null);
}

/**
 * Sentences that exist in `before` and not in `after`.
 *
 * Compared on a normalized form so that reflowing, re-indenting or changing
 * whitespace in a build step is not reported as guidance being deleted.
 */
export function removedSentences(before: string, after: string): string[] {
  const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const kept = new Set(sentences(after).map(normalize));
  return sentences(before).filter((s) => !kept.has(normalize(s)));
}

/** Sentences in `after` that were not in `before`. */
export function addedSentences(before: string, after: string): string[] {
  return removedSentences(after, before);
}

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9`_\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2),
  );
}

/** Token overlap, 0 to 1. Cheap, and enough to tell an edit from a deletion. */
export function similarity(a: string, b: string): number {
  const left = tokens(a);
  const right = tokens(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / Math.max(left.size, right.size);
}

/**
 * How much of `part` is made of words from `whole`, 0 to 1.
 *
 * `similarity` divides by the longer side, so a sentence that kept its first
 * half scores as unrelated to the sentence it was cut down from. This asks the
 * one-sided question instead: is the short one mostly built out of the long
 * one. A handful of tokens proves nothing either way, so anything under four
 * scores zero.
 */
export function containment(part: string, whole: string): number {
  const inner = tokens(part);
  const outer = tokens(whole);
  if (inner.size < 4 || outer.size === 0) return 0;
  let shared = 0;
  for (const token of inner) if (outer.has(token)) shared += 1;
  return shared / inner.size;
}

/**
 * Sentences that are genuinely gone, not merely reworded.
 *
 * A description that gets tightened rewrites most of its sentences. Reporting
 * every rewrite as deleted guidance would bury the one case that matters under
 * dozens that do not, and a tool nobody trusts gets switched off.
 *
 * So a removed sentence only counts when nothing resembling it survives.
 */
export function deletedSentences(before: string, after: string, threshold = 0.6): string[] {
  const surviving = sentences(after);
  return removedSentences(before, after).filter(
    (removed) => !surviving.some((kept) => similarity(removed, kept) >= threshold),
  );
}

/**
 * Does this sentence carry a worked example?
 *
 * Examples are load-bearing for a model in a way they are not for a human
 * reader, so their removal is its own rule.
 */
export function looksLikeExample(sentence: string): boolean {
  return /\b(e\.g\.|for example|for instance|such as)\b/i.test(sentence);
}

/**
 * Does this sentence set a mode — "pass X only when…", "leave it out and…"?
 *
 * This is the shape that tells a model which of two behaviours it is asking for.
 * Changing one is how a tool quietly starts doing the other thing.
 */
export function looksLikeModeSwitch(sentence: string): boolean {
  return /\b(only (?:when|if|to)|leave (?:it|them) out|otherwise|instead of|rather than)\b/i.test(
    sentence,
  );
}
