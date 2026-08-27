import { Terminal, type Frame } from "@/components/terminal";
import { Reveal } from "@/components/reveal";
import { Copyable } from "@/components/copyable";
import { CopyablePrompt } from "@/components/copyable-prompt";

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

export default function Page() {
  return (
    <main className="mx-auto max-w-3xl px-5 py-20 sm:py-28">
      <Reveal>
        <span className="mb-6 inline-block rounded-full border border-zinc-200 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.09em] text-zinc-500 dark:border-zinc-800 dark:text-zinc-500">
          Open source · MIT · no account
        </span>
        <h1 className="text-balance text-4xl font-bold leading-[1.06] tracking-[-0.033em] sm:text-6xl">
          They didn&apos;t file a ticket.
          <br />
          They just left.
        </h1>
        <p className="mt-6 text-pretty text-lg leading-relaxed text-zinc-600 dark:text-zinc-400">
          An update changed one sentence in an API&apos;s description. No error. No failed build. No
          version marked breaking. The AI calling it started getting it wrong, the feature quietly
          stopped working, and the customer went away without saying anything.
        </p>
        <p className="mt-4 text-lg font-medium text-zinc-900 dark:text-zinc-100">
          Stantal finds the release that did it.
        </p>
      </Reveal>

      <Reveal className="mt-12" delay={0.1}>
        <Terminal frames={DEMO} />
      </Reveal>

      {/* The prompt leads, because it is the path with nothing to learn. Typing a
          command means knowing there is a command; pasting a sentence does not. */}
      <Reveal className="mt-14">
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-[0.1em] text-zinc-400 dark:text-zinc-600">
          Paste this into Claude Code, Cursor or Codex
        </h3>
        <p className="mb-4 text-sm text-zinc-500">Your agent does the rest. About a minute.</p>
        <CopyablePrompt text="Set up stantal in this repo. Run `npx stantal connect`, then do what it prints. It needs no account and no API key. Tell me what it found." />
      </Reveal>

      <Reveal className="mt-10">
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-[0.1em] text-zinc-400 dark:text-zinc-600">
          Or run it yourself
        </h3>
        <p className="mb-4 text-sm text-zinc-500">
          Claude Code, Cursor and VS Code. Takes about a second.
        </p>
        <Copyable command="npx stantal connect" />
      </Reveal>

      <Divider />

      <Reveal>
        <h2 className="text-2xl font-semibold tracking-[-0.02em] sm:text-3xl">
          How a sentence breaks a product
        </h2>
        <p className="mt-4 text-zinc-600 dark:text-zinc-400">
          A real tool from a widely used server. Three of its inputs are optional, none are
          explained, and the description mentions none of them:
        </p>
        <div className="mt-5 overflow-hidden rounded-xl border border-white/5 bg-[#07090d]">
          <div className="flex items-center gap-2 border-b border-white/5 bg-white/[0.03] px-4 py-3">
            <span className="size-2.5 rounded-full bg-zinc-700" />
            <span className="size-2.5 rounded-full bg-zinc-700" />
            <span className="size-2.5 rounded-full bg-zinc-700" />
            <span className="ml-2 font-mono text-[11px] text-zinc-600">list_commits</span>
          </div>
          <pre className="overflow-x-auto px-5 py-4 font-mono text-[13px] leading-[1.75] text-zinc-300">
            <span className="text-zinc-500">description:</span> &quot;Get list of commits of a branch
            in a GitHub repository&quot;
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
        <p className="mt-5 text-zinc-600 dark:text-zinc-400">
          A person reads the code and works it out. The AI only ever sees the text above, so it
          guesses. It puts a branch name where a commit hash goes, the call fails, and your user
          sees a feature that doesn&apos;t work. Nothing in your pipeline noticed, because nothing
          was wrong with the code.
        </p>
      </Reveal>

      <Reveal className="mt-16">
        <h3 className="mb-6 text-xs font-semibold uppercase tracking-[0.1em] text-zinc-400 dark:text-zinc-600">
          We went and counted
        </h3>
        <div className="grid gap-8 sm:grid-cols-2">
          <Stat n="168" label="changes across 487 releases of 22 popular packages that would make an AI call them differently." />
          <Stat
            n="145"
            bad
            label="of those broke nothing you could have tested for. No error, no type failure, no breaking version."
          />
        </div>
        <p className="mt-7 text-zinc-600 dark:text-zinc-400">
          Twelve of the twenty-two packages had at least one. Ten had none — including both official
          reference servers. A tool that found something wrong everywhere would just be broken, so
          the ten matter as much as the number.
        </p>
      </Reveal>

      <Divider />

      <Reveal>
        <h2 className="text-2xl font-semibold tracking-[-0.02em] sm:text-3xl">What you get</h2>
        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          <Card title="An answer" body="Take this update, or don't — and the evidence underneath it." />
          <Card
            title="A test you keep"
            body="Records what your dependency does today. Fails the day an update takes it away."
          />
          <Card title="A fix" body="Puts the deleted sentence back, when no released version is clean." />
          <Card title="A link" body="One page you can send to whoever shipped it." />
        </div>
      </Reveal>

      <Reveal className="mt-16">
        <h2 className="text-2xl font-semibold tracking-[-0.02em] sm:text-3xl">There is no API key</h2>
        <p className="mt-4 text-zinc-600 dark:text-zinc-400">
          Tools like this usually need an AI to work, so they need your key, so they need an account
          before you see anything. We don&apos;t.
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
        <p className="mt-5 text-zinc-600 dark:text-zinc-400">
          An AI does one small optional job here: saying yes or no to whether a sentence explains an
          input, and quoting the text it used. Rules do everything else. Your key, your bill, never
          ours.
        </p>
      </Reveal>

      <Divider />

      <Reveal>
        <h2 className="text-2xl font-semibold tracking-[-0.02em] sm:text-3xl">
          If you&apos;re the one shipping the API
        </h2>
        <p className="mt-4 text-zinc-600 dark:text-zinc-400">
          You cannot see this from your side. The calls succeed. The error rate is flat. The
          dashboards are green. The customer is filling in a field wrong because you deleted the
          sentence that told them not to, and they will not tell you — they will just stop.
        </p>
        <Copyable command="npx stantal check ./ --against 1.4.0" className="mt-6" />
        <p className="mt-3 text-sm text-zinc-500">
          Run it on a release you haven&apos;t published yet. Nothing has shipped, so there is
          nothing to defend and nobody to blame — you fix it in ten minutes instead of finding out in
          six months.
        </p>
      </Reveal>

      <footer className="mt-24 border-t border-zinc-200 pt-6 text-sm text-zinc-500 dark:border-zinc-800">
        MIT licensed. Runs on your machine. Never executes the packages it reads.{" "}
        <a
          className="text-violet-600 hover:underline dark:text-violet-400"
          href="https://github.com/hellunleash/stantal"
        >
          GitHub
        </a>{" "}
        ·{" "}
        <a
          className="text-violet-600 hover:underline dark:text-violet-400"
          href="https://www.npmjs.com/package/stantal"
        >
          npm
        </a>
      </footer>
    </main>
  );
}

function Divider() {
  return <hr className="my-20 border-zinc-200 dark:border-zinc-800" />;
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
    <div className="rounded-xl border border-zinc-200 bg-zinc-50 px-5 py-4 dark:border-zinc-800 dark:bg-zinc-900/50">
      <h4 className="text-[15px] font-semibold">{title}</h4>
      <p className="mt-1 text-[15px] leading-relaxed text-zinc-600 dark:text-zinc-400">{body}</p>
    </div>
  );
}
