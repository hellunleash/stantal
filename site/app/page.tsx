import { Terminal, type Frame } from "@/components/terminal";
import { Reveal } from "@/components/reveal";
import { Copyable } from "@/components/copyable";
import { CopyablePrompt } from "@/components/copyable-prompt";
import { GitHubMark, NpmMark } from "@/components/logo";

/**
 * Every line below was captured from a real run against real published
 * packages. Nothing here is illustrative.
 */
const DEMO: Frame[] = [
  {
    command: "npx stantal connect",
    output: [
      { text: "" },
      { text: "  connected  Claude Code", tone: "good" },
      { text: "    .mcp.json  — left alone: github", tone: "dim" },
      { text: "" },
      { text: "  2 of your dependencies give an AI tools it can call:" },
      { text: "    @modelcontextprotocol/server-filesystem  14 tools", tone: "accent" },
      { text: "    tavily-mcp                                5 tools", tone: "accent" },
      { text: "" },
      { text: "  No account, no key, no signup.", tone: "dim" },
    ],
    hold: 2200,
  },
  {
    command: "npx stantal pin @modelcontextprotocol/server-filesystem",
    output: [
      { text: "" },
      { text: "  wrote 1 file, recording what it does today" },
      { text: "    stantal/…server-filesystem.contract.test.ts", tone: "accent" },
      { text: "      64 checks", tone: "dim" },
      { text: "" },
      { text: "  Passes now. Fails if an update takes any of it away.", tone: "dim" },
    ],
    hold: 2000,
  },
  {
    command: "npm install @modelcontextprotocol/server-filesystem@0.5.0",
    output: [{ text: "" }, { text: "  changed 1 package", tone: "dim" }],
    hold: 1200,
  },
  {
    command: "npx vitest run",
    output: [
      { text: "" },
      { text: "  ❯ still takes excludePatterns", tone: "bad" },
      { text: "  ❯ still lets callers omit excludePatterns", tone: "bad" },
      { text: "  ❯ still offers list_allowed_directories", tone: "bad" },
      { text: "" },
      { text: "   Tests  33 failed | 31 passed (64)", tone: "bad" },
      { text: "" },
      { text: "  The update took 33 things away. Nothing else noticed.", tone: "warn" },
    ],
  },
];

const THEN = [
  "The contract was names, types and shapes.",
  "A compiler could check all of it.",
  "Documentation sat beside the contract.",
  "You could rewrite every word of it in a patch release and break nobody.",
];

const NOW = [
  "The contract is the text a model reads.",
  "Nothing checks it. Not types, not tests, not semver.",
  "The documentation is the dispatch logic.",
  "Delete one sentence and the call goes wrong, on a green build.",
];

export default function Page() {
  return (
    <main id="top" className="flex-1">
      {/* ---------------------------------------------------------------- hero */}
      <section className="relative isolate overflow-hidden">
        <div
          aria-hidden
          className="grid-backdrop pointer-events-none absolute inset-0 -z-10 text-zinc-900 dark:text-zinc-100"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-[-14rem] -z-10 size-[38rem] -translate-x-1/2 rounded-full bg-violet-500/10 blur-3xl dark:bg-violet-500/15"
        />

        <div className="mx-auto max-w-3xl px-5 pb-16 pt-16 sm:pt-24">
          <Reveal>
            <span className="mb-6 inline-flex items-center gap-2 rounded-full border border-zinc-200 bg-white/60 px-3 py-1 text-[11px] font-medium tracking-[0.02em] text-zinc-600 backdrop-blur dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-400">
              <span className="size-1.5 rounded-full bg-emerald-500" />
              Open source · MIT · no account, no API key
            </span>

            <h1 className="text-balance text-4xl font-bold leading-[1.06] tracking-[-0.033em] sm:text-6xl">
              Self-maintaining dependencies
              <br className="hidden sm:block" /> for AI agents.
            </h1>

            <p className="mt-6 text-pretty text-lg leading-relaxed text-zinc-600 dark:text-zinc-400">
              When the caller is a model, the docs <em className="not-italic font-medium text-zinc-900 dark:text-zinc-100">are</em>{" "}
              the contract. An update rewrites one sentence of it and your agent starts calling the
              tool wrong. Nothing errors, nothing changes type, no test fails, and the version
              number still says patch.
            </p>

            <p className="mt-4 text-lg font-medium text-zinc-900 dark:text-zinc-100">
              Stantal finds it, proves it, and puts it back.
            </p>
          </Reveal>

          <Reveal className="mt-10" delay={0.06}>
            <Terminal frames={DEMO} />
          </Reveal>

          {/* The prompt leads, because it is the path with nothing to learn.
              Typing a command means knowing there is a command; pasting a
              sentence does not. */}
          <Reveal className="mt-12" delay={0.1}>
            <p className="mb-1 text-xs font-semibold uppercase tracking-[0.1em] text-zinc-400 dark:text-zinc-600">
              Paste this into Claude Code, Cursor or Codex
            </p>
            <p className="mb-4 text-sm text-zinc-500">Your agent does the rest. About a minute.</p>
            <CopyablePrompt text="Set up stantal in this repo. Run `npx stantal connect`, then do what it prints. It needs no account and no API key. Tell me what it found." />
          </Reveal>

          <Reveal className="mt-8">
            <p className="mb-1 text-xs font-semibold uppercase tracking-[0.1em] text-zinc-400 dark:text-zinc-600">
              Or run it yourself
            </p>
            <p className="mb-4 text-sm text-zinc-500">
              Claude Code, Cursor and VS Code. Takes about a second.
            </p>
            <Copyable command="npx stantal connect" />
          </Reveal>
        </div>
      </section>

      {/* ------------------------------------------------------- why this is new */}
      <Section id="why">
        <Reveal>
          <SectionLabel>Why this is new</SectionLabel>
          <h2 className="text-2xl font-semibold tracking-[-0.02em] sm:text-3xl">
            Prose was never part of the contract before
          </h2>
          <p className="mt-4 max-w-2xl text-zinc-600 dark:text-zinc-400">
            For thirty years the docs were the part you could change freely. That assumption is
            still baked into semver, into code review, and into every dependency tool you run.
          </p>

          <div className="mt-8 grid gap-4 sm:grid-cols-2">
            <ComparisonCard heading="Before" items={THEN} />
            <ComparisonCard heading="Now the caller is a model" items={NOW} accent />
          </div>

          <p className="mt-8 max-w-2xl text-zinc-600 dark:text-zinc-400">
            Half of this already has a name: <strong className="font-medium text-zinc-900 dark:text-zinc-100">schema drift</strong>,
            meaning a renamed field or a new required parameter. That is the easy half, because
            something somewhere eventually throws. The half nothing checks is the prose.
          </p>
        </Reveal>
      </Section>

      {/* ------------------------------------------------------------- the how */}
      <Section id="how" bordered>
        <Reveal>
          <SectionLabel>How a sentence breaks a product</SectionLabel>
          <h2 className="text-2xl font-semibold tracking-[-0.02em] sm:text-3xl">
            A real tool, from a widely used server
          </h2>
          <p className="mt-4 max-w-2xl text-zinc-600 dark:text-zinc-400">
            Three of its inputs are optional, none are explained, and the description mentions none
            of them:
          </p>

          <div className="mt-6 overflow-hidden rounded-xl border border-white/5 bg-[#07090d] shadow-[0_1px_2px_rgba(0,0,0,.2),0_24px_56px_-24px_rgba(0,0,0,.7)]">
            <div className="flex items-center gap-2 border-b border-white/5 bg-white/[0.03] px-4 py-3">
              <span className="size-2.5 rounded-full bg-zinc-700" />
              <span className="size-2.5 rounded-full bg-zinc-700" />
              <span className="size-2.5 rounded-full bg-zinc-700" />
              <span className="ml-2 font-mono text-[11px] text-zinc-600">list_commits</span>
            </div>
            <pre className="overflow-x-auto px-5 py-4 font-mono text-[13px] leading-[1.75] text-zinc-300">
              <span className="text-zinc-500">description:</span> &quot;Get list of commits of a
              branch in a GitHub repository&quot;
              {"\n\n"}
              owner {"   "}
              <span className="text-zinc-500">required</span>
              {"\n"}
              repo {"    "}
              <span className="text-zinc-500">required</span>
              {"\n"}
              sha {"     "}
              <span className="text-rose-400">optional, no explanation</span>
              {"   "}
              <span className="text-zinc-500">← a commit hash? the branch?</span>
              {"\n"}
              page {"    "}
              <span className="text-rose-400">optional, no explanation</span>
              {"\n"}
              perPage {" "}
              <span className="text-rose-400">optional, no explanation</span>
            </pre>
          </div>

          <p className="mt-6 max-w-2xl text-zinc-600 dark:text-zinc-400">
            A person reads the code and works it out. The AI only ever sees the text above, so it
            guesses. It puts a branch name where a commit hash goes, the call fails, and your user
            sees a feature that doesn&apos;t work. Nothing in your pipeline noticed, because nothing
            was wrong with the code.
          </p>
        </Reveal>
      </Section>

      {/* ----------------------------------------------------------- the numbers */}
      <Section id="numbers" bordered>
        <Reveal>
          <SectionLabel>We went and counted</SectionLabel>
          <h2 className="mb-8 text-2xl font-semibold tracking-[-0.02em] sm:text-3xl">
            Most of it leaves no trace
          </h2>
          <div className="grid gap-8 sm:grid-cols-2">
            <Stat
              n="168"
              label="changes across 487 releases of 22 popular packages that would make an AI call them differently."
            />
            <Stat
              n="145"
              bad
              label="of those broke nothing you could have tested for. No error, no type failure, no breaking version."
            />
          </div>
          <p className="mt-8 max-w-2xl text-zinc-600 dark:text-zinc-400">
            Twelve of the twenty-two packages had at least one. Ten had none, including both
            official reference servers. A tool that found something wrong everywhere would just be
            broken, so the ten matter as much as the number.
          </p>
        </Reveal>
      </Section>

      {/* --------------------------------------------------------- what you get */}
      <Section bordered>
        <Reveal>
          <SectionLabel>The output</SectionLabel>
          <h2 className="mb-6 text-2xl font-semibold tracking-[-0.02em] sm:text-3xl">
            What you get
          </h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <Card
              title="An answer"
              body="Take this update, or don't, and the evidence underneath it."
            />
            <Card
              title="A test you keep"
              body="Records what your dependency does today. Fails the day an update takes it away."
            />
            <Card
              title="A fix"
              body="Puts the deleted sentence back into your installed copy, when no released version is clean."
            />
            <Card title="A link" body="One page you can send to whoever shipped it." />
          </div>
        </Reveal>
      </Section>

      {/* ------------------------------------------------------------ no API key */}
      <Section bordered>
        <Reveal>
          <SectionLabel>Cost</SectionLabel>
          <h2 className="mb-4 text-2xl font-semibold tracking-[-0.02em] sm:text-3xl">
            There is no API key
          </h2>
          <p className="max-w-2xl text-zinc-600 dark:text-zinc-400">
            Tools like this usually need an AI to work, so they need your key, so they need an
            account before you see anything. We don&apos;t.
          </p>
          <table className="mt-6 w-full text-[15px]">
            <thead>
              <tr className="border-b border-zinc-200 dark:border-zinc-800">
                <th className="py-2 pr-3 text-left text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-400">
                  What you do
                </th>
                <th className="py-2 text-left text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-400">
                  Needs a key
                </th>
              </tr>
            </thead>
            <tbody className="text-zinc-600 dark:text-zinc-400">
              {[
                ["See which dependencies give an AI tools", null],
                ["Compare two versions", null],
                ["Write the tests", null],
                ["Find which release broke it", null],
                ["Put the deleted sentence back", null],
                ["Second-guess a borderline call", "yours, only if you want it"],
              ].map(([what, caveat]) => (
                <tr key={what} className="border-b border-zinc-100 dark:border-zinc-900">
                  <td className="py-2.5 pr-3">{what}</td>
                  <td
                    className={
                      caveat === null
                        ? "py-2.5 font-medium text-emerald-600 dark:text-emerald-400"
                        : "py-2.5"
                    }
                  >
                    {caveat ?? "no"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-5 max-w-2xl text-zinc-600 dark:text-zinc-400">
            An AI does one small optional job here: saying yes or no to whether a sentence explains
            an input, and quoting the text it used. Rules do everything else. Your key, your bill,
            never ours.
          </p>
        </Reveal>
      </Section>

      {/* ------------------------------------------------------------ providers */}
      <Section id="providers" bordered>
        <Reveal>
          <SectionLabel>If you&apos;re the one shipping the API</SectionLabel>
          <h2 className="text-2xl font-semibold tracking-[-0.02em] sm:text-3xl">
            You cannot see this from your side
          </h2>
          <p className="mt-4 max-w-2xl text-zinc-600 dark:text-zinc-400">
            The calls succeed. The error rate is flat. The dashboards are green. The customer is
            filling in a field wrong because you deleted the sentence that told them not to, and
            they will not tell you. They will just stop.
          </p>
          <Copyable command="npx stantal check ./ --against 1.4.0" className="mt-6" />
          <p className="mt-3 max-w-2xl text-sm text-zinc-500">
            Run it on a release you haven&apos;t published yet. Nothing has shipped, so there is
            nothing to defend and nobody to blame. You fix it in ten minutes instead of finding out
            in six months.
          </p>
        </Reveal>
      </Section>

      {/* --------------------------------------------------------------- footer */}
      <footer className="mt-8 border-t border-zinc-200 dark:border-zinc-800">
        <div className="mx-auto flex max-w-3xl flex-col gap-4 px-5 py-10 text-sm text-zinc-500 sm:flex-row sm:items-center">
          <p className="flex-1">
            MIT licensed. Runs on your machine. Never executes the packages it reads.
          </p>
          <div className="flex items-center gap-2">
            <FooterLink href="https://github.com/hellunleash/stantal">
              <GitHubMark className="size-3.5" />
              GitHub
            </FooterLink>
            <FooterLink href="https://www.npmjs.com/package/stantal">
              <NpmMark className="size-4" />
              npm
            </FooterLink>
          </div>
        </div>
      </footer>
    </main>
  );
}

function Section({
  id,
  bordered,
  children,
}: {
  id?: string;
  bordered?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      className={bordered ? "border-t border-zinc-200 dark:border-zinc-800" : undefined}
    >
      <div className="mx-auto max-w-3xl px-5 py-16 sm:py-20">{children}</div>
    </section>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-3 text-xs font-semibold uppercase tracking-[0.1em] text-zinc-400 dark:text-zinc-600">
      {children}
    </p>
  );
}

function ComparisonCard({
  heading,
  items,
  accent,
}: {
  heading: string;
  items: string[];
  accent?: boolean;
}) {
  return (
    <div
      className={
        accent
          ? "rounded-xl border border-violet-200 bg-violet-50/60 px-5 py-5 dark:border-violet-900/60 dark:bg-violet-950/20"
          : "rounded-xl border border-zinc-200 bg-zinc-50 px-5 py-5 dark:border-zinc-800 dark:bg-zinc-900/50"
      }
    >
      <h3
        className={
          accent
            ? "text-[13px] font-semibold uppercase tracking-[0.06em] text-violet-700 dark:text-violet-300"
            : "text-[13px] font-semibold uppercase tracking-[0.06em] text-zinc-400"
        }
      >
        {heading}
      </h3>
      <ul className="mt-4 space-y-2.5">
        {items.map((item) => (
          <li
            key={item}
            className="flex gap-2.5 text-[15px] leading-relaxed text-zinc-600 dark:text-zinc-400"
          >
            <span
              aria-hidden
              className={
                accent
                  ? "mt-[0.6em] size-1.5 shrink-0 rounded-full bg-violet-500"
                  : "mt-[0.6em] size-1.5 shrink-0 rounded-full bg-zinc-300 dark:bg-zinc-700"
              }
            />
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Stat({ n, label, bad }: { n: string; label: string; bad?: boolean }) {
  return (
    <div>
      <p
        className={
          bad
            ? "text-5xl font-bold tracking-[-0.035em] text-rose-600 dark:text-rose-400"
            : "text-5xl font-bold tracking-[-0.035em]"
        }
      >
        {n}
      </p>
      <p className="mt-2 text-[15px] leading-relaxed text-zinc-600 dark:text-zinc-400">{label}</p>
    </div>
  );
}

function Card({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-zinc-50 px-5 py-4 transition-colors hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900/50 dark:hover:border-zinc-700">
      <h3 className="text-[15px] font-semibold">{title}</h3>
      <p className="mt-1 text-[15px] leading-relaxed text-zinc-600 dark:text-zinc-400">{body}</p>
    </div>
  );
}

function FooterLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      className="flex items-center gap-1.5 rounded-lg border border-zinc-200 px-3 py-1.5 transition-colors hover:border-zinc-300 hover:text-zinc-900 focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:outline-none dark:border-zinc-800 dark:hover:border-zinc-700 dark:hover:text-zinc-100"
    >
      {children}
    </a>
  );
}
