/**
 * The judge.
 *
 * A deterministic rule can find that a parameter is bare and that no sentence
 * refers to it. It cannot answer whether the description explains the parameter
 * in words that never name it, or whether a field's name reads as the opposite
 * of what it does. Those are the questions that separate a real finding from a
 * lint warning, and they need a reader.
 *
 * Three constraints keep that from becoming a liability:
 *
 * 1. **The judge never chooses what to look at.** Candidates come from the
 *    deterministic layer with the target already fixed. The judge answers a
 *    closed question about one of them and cannot introduce a new target.
 * 2. **The answer is an enum, not prose.** A summary of what changed is not
 *    something a CI job can branch on, and no two runs of it agree.
 * 3. **The judge must quote, and the quote is checked.** Every asserted answer
 *    carries a span that has to appear verbatim in the text it was given. An
 *    answer whose quote is not in the source is discarded, not reported. That
 *    makes a fabricated justification fail closed.
 */

export type JudgeQuestion =
  | {
      id: string;
      kind: "is_parameter_documented";
      tool: string;
      param: string;
      /** The tool description as shipped. The only text the answer may quote. */
      description: string;
    }
  | {
      id: string;
      kind: "name_inverts_behaviour";
      tool: string;
      param: string;
      description: string;
      /** The other parameters, so the judge can see the field in context. */
      siblings: readonly string[];
    };

export type Verdict = "yes" | "no" | "unclear";

export type JudgeAnswer = {
  id: string;
  verdict: Verdict;
  /** A span copied verbatim from the question's text. Checked before use. */
  quote: string | null;
};

export interface Judge {
  /** Provider and model, e.g. "anthropic:claude-opus-5". Part of the cache key. */
  readonly id: string;
  ask(questions: readonly JudgeQuestion[]): Promise<JudgeAnswer[]>;
}

/**
 * The default. Answers nothing.
 *
 * With no judge configured the pipeline still runs and still reports, it just
 * reports every semantic question as unconfirmed. That is what keeps the first
 * `npx` run useful with no key and no account.
 */
export const noJudge: Judge = {
  id: "none",
  async ask(questions) {
    return questions.map((q) => ({ id: q.id, verdict: "unclear" as const, quote: null }));
  },
};

/** The text a given question allows an answer to quote from. */
export function quotableText(question: JudgeQuestion): string {
  return question.description;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Check one answer before it is allowed to become a finding.
 *
 * A `yes` on "is this documented" is a claim that specific words exist, so it
 * must point at them. Everything else may answer without a quote, but any quote
 * it does give still has to be real.
 *
 * Returns null when the answer cannot be trusted. The caller treats that as
 * "unclear", never as the opposite verdict — a judge that misbehaves must not be
 * able to flip a finding on.
 */
export function verifyAnswer(question: JudgeQuestion, answer: JudgeAnswer): JudgeAnswer | null {
  if (answer.id !== question.id) return null;

  const source = normalize(quotableText(question));

  if (answer.quote !== null) {
    const quote = normalize(answer.quote);
    if (quote.length === 0 || !source.includes(quote)) return null;
  }

  // Asserting that guidance exists means being able to point at it.
  if (question.kind === "is_parameter_documented" && answer.verdict === "yes" && answer.quote === null) {
    return null;
  }

  return answer;
}

/**
 * Match answers to questions and drop anything that fails verification.
 *
 * Order is not trusted: answers are matched by id, and a question with no valid
 * answer comes back unclear.
 */
export function reconcile(
  questions: readonly JudgeQuestion[],
  answers: readonly JudgeAnswer[],
): Map<string, JudgeAnswer> {
  const byId = new Map(answers.map((a) => [a.id, a]));
  const out = new Map<string, JudgeAnswer>();

  for (const question of questions) {
    const answer = byId.get(question.id);
    const verified = answer === undefined ? null : verifyAnswer(question, answer);
    out.set(question.id, verified ?? { id: question.id, verdict: "unclear", quote: null });
  }

  return out;
}

/**
 * The question text, rendered once so every provider asks the same thing.
 *
 * Kept here rather than inside each adapter: if the wording drifts per provider,
 * the results stop being comparable and the cache key stops meaning anything.
 */
export function renderQuestion(question: JudgeQuestion): string {
  if (question.kind === "is_parameter_documented") {
    return [
      `Tool: ${question.tool}`,
      `Parameter: ${question.param}`,
      "",
      "Tool description as shipped:",
      "---",
      question.description,
      "---",
      "",
      `Does this description tell a caller when or whether to pass \`${question.param}\`?`,
      "Answer yes only if the description gives guidance a caller could act on for that",
      "specific parameter. A passing mention of the word is not guidance.",
      'If yes, quote the exact sentence from the description that does it.',
    ].join("\n");
  }

  return [
    `Tool: ${question.tool}`,
    `Parameter: ${question.param}`,
    `Other parameters: ${question.siblings.join(", ") || "(none)"}`,
    "",
    "Tool description as shipped:",
    "---",
    question.description,
    "---",
    "",
    `Would a careful caller reading only this contract fill \`${question.param}\` with a value`,
    "when it should be left out, because the name suggests the opposite of its actual role?",
    "Answer yes only if the name itself is misleading given the tool's stated purpose.",
    "If you quote, quote verbatim from the description above.",
  ].join("\n");
}

/** The closed shape every provider must return. Shared so the schema cannot drift. */
export const ANSWER_JSON_SCHEMA = {
  type: "object",
  properties: {
    answers: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          verdict: { type: "string", enum: ["yes", "no", "unclear"] },
          quote: { type: ["string", "null"] },
        },
        required: ["id", "verdict", "quote"],
        additionalProperties: false,
      },
    },
  },
  required: ["answers"],
  additionalProperties: false,
} as const;

export const JUDGE_SYSTEM_PROMPT = [
  "You classify changes to API tool descriptions for a contract-diffing tool.",
  "",
  "Rules:",
  "- Answer only the question asked, for the parameter named. Never comment on other parameters.",
  "- Your verdict must be exactly one of: yes, no, unclear.",
  "- Any quote you give must be copied character-for-character from the description you were shown.",
  "  A quote that is not present in that text will be discarded and your answer ignored.",
  "- If the description does not settle the question, answer unclear. Unclear is a valid",
  "  and useful answer; a confident guess is not.",
].join("\n");
