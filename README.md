<h1 align="center">Stantal</h1>

<p align="center">
  <b>Your tests pass. Your types check. The model still gets it wrong.</b><br/>
  Stantal finds the upgrade that did it.
</p>

<p align="center">
  <a href="https://github.com/hellunleash/stantal/actions/workflows/ci.yml"><img alt="ci" src="https://img.shields.io/github/actions/workflow/status/hellunleash/stantal/ci.yml?branch=main&style=flat-square&label=ci" /></a>
  <a href="https://www.npmjs.com/package/stantal"><img alt="npm" src="https://img.shields.io/npm/v/stantal?style=flat-square&color=cb3837&logo=npm" /></a>
  <img alt="status" src="https://img.shields.io/badge/status-early%20development-orange?style=flat-square" />
  <img alt="license" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" />
  <img alt="typescript" src="https://img.shields.io/badge/TypeScript-strict-3178c6?style=flat-square&logo=typescript&logoColor=white" />
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D20-339933?style=flat-square&logo=nodedotjs&logoColor=white" />
</p>

---

`npm install` succeeds. `tsc` exits 0. Your tests pass. The wire returns `200`.
And your product quietly stops working.

When the consumer of an API is a language model, the tool descriptions *are* the
contract. Deleting a sentence of prose is a breaking change with no type
signature. Nothing in your toolchain is looking at it.

Most of the time the answer is *"this one is fine, take it."* That is the point.
Everyone already tells stranded users to upgrade. They don't, because nobody can
tell them whether the new version breaks something else.

## Install

```bash
npx stantal <package> <from> <to>
```

No account, no setup, nothing to configure.

## Usage

```
$ npx stantal @scope/example-sdk 1.4.0 1.5.0

  @scope/example-sdk · 1.4.0 → 1.5.0

  VERDICT  prose-risk
           `target` is optional, has no description, and the tool
           description never says when to pass it.

  ./pack  2 tool(s)
    medium  undocumented_optional  build.target  unconfirmed
      `target` is optional, has no description, and the tool description
      never says when to pass it

  run with --json for the full report
```

Exit codes: `0` clean, `1` something to look at, `2` could not read enough to say.

### Reading a surface on its own

A package can open several doors — an MCP server, a host tool pack, a framework
shim — and they do not always agree. Each is read and compared separately.

```bash
npx stantal @scope/example-sdk 1.4.0 1.5.0 --surface ./pack
```

### The judge

Findings that depend on meaning rather than text are marked `unconfirmed` until a
model confirms them. Set any one of `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or
`GEMINI_API_KEY` and they get checked. No key is a normal run, not an error.

The judge answers a closed question about one finding at a time, and must quote
the text it relied on. Quotes are verified against the source, so an invented
justification is discarded rather than reported.

### Models

The judge (Layer 1) and the behavioural caller (Layer 2) each default to one
model per provider:

| provider | Layer 1 judge | Layer 2 caller |
|---|---|---|
| anthropic | `claude-opus-5` | `claude-sonnet-5` |
| openai | `gpt-5.4-mini` | `gpt-5.4` |
| gemini | `gemini-3.6-flash` | `gemini-3.6-flash` |

Pick a provider with `STANTAL_JUDGE` / `STANTAL_CALLER` (either also accepts
`none`, which turns that layer off regardless of which keys are set), and a
model with `STANTAL_JUDGE_MODEL` / `STANTAL_CALLER_MODEL`. Both read the same
three keys — `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` (or
`GOOGLE_API_KEY`) — to decide which providers are even available.

**Gemini is pinned on purpose.** Every judge cassette on disk was recorded
against `gemini:gemini-3.6-flash`, and the findings this project reports
replay from those recordings with no key and no network call at all. A newer
`gemini-3.7-flash` exists and works, but that is not a reason to move the pin.
Repinning would strand every recording on disk and force the whole judged
history to be answered again for no benefit. OpenAI's default moved because
`gpt-4o` was two generations stale, not because gemini needed to catch up to
it.

**Tested live against the OpenAI API on 2026-08-26**, not exhaustively:
`gpt-5.4`, `gpt-5.4-mini`, and `gpt-5.5` call tools normally. `gpt-5-mini`
declined to call a tool at all. The `gpt-5.6` family rejects function tools
on the chat-completions endpoint outright. That is a spot check on one date,
not a compatibility matrix — it is more honest, and it will still be correct
after the next model release, which a matrix would not be.

Each layer caches what it calls out for: `STANTAL_JUDGE_CACHE` and
`STANTAL_BEHAVIOUR_CACHE` (`record` by default, or `replay`, or `off`; the
CLI's `--replay` flag is shorthand for `STANTAL_JUDGE_CACHE=replay`).
`replay` never reaches the network, so a recorded run repeats for free — that
is how the `gemini-3.6-flash` recordings above stay reproducible with no key
at all.

**Gemini through Vertex AI.** AI Studio and Vertex serve the same models and
bill separately; only Vertex draws on Google Cloud credits. Set
`STANTAL_VERTEX_PROJECT` and both layers route there. It is a transport, not a
provider — the id stays `gemini:<model>`, so recordings made through one route
still answer questions asked through the other. Auth is an OAuth token rather
than an API key: `GOOGLE_ACCESS_TOKEN` if you have one, otherwise the `gcloud`
CLI is asked. `STANTAL_VERTEX_LOCATION` defaults to `global`, which is where the
current flash models actually live.

`STANTAL_SERVICE_TIER` (OpenAI only) requests cheaper, slower processing from
the API. It is opt-in and **unverified**: nobody has confirmed against the
live API that it changes anything, so it stays off unless you set it
yourself.

## In CI

There is a GitHub Action, so the check runs on the pull request that proposes
the upgrade rather than after someone takes it.

```yaml
name: Contract check
on: pull_request

jobs:
  stantal:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: stantal/stantal@v0
        with:
          package: "@modelcontextprotocol/server-filesystem"
          from: "2025.7.1"
          to: "2025.8.21"
```

It fails the job when a change would be read differently by a model, writes a
summary to the run, and exposes `verdict`, `findings`, `reaches` and `report`
as outputs for a later step.

No key is required. The run works with none, and a key only upgrades findings
from leads to confirmed — see [The judge](#the-judge).

`repo` defaults to the checkout, so the summary also says which of *your* files
the findings actually touch. That scan is local, read-only, and never calls out.
Set `repo: none` to skip it.

| input | default | |
|---|---|---|
| `package`, `from`, `to` | — | The dependency and the two versions. |
| `manifest` | — | Two space-separated sides instead, for a contract that never reached a registry. Each side may list several documents, comma-separated, catalog first. |
| `surface` | every door | Space-separated subpaths, e.g. `. ./ai-sdk`. |
| `repo` | `.` | Directory to scan for call sites. `none` to skip. |
| `fail-on` | `found` | `found`, `unreadable`, or `never`. |
| `replay` | `false` | Answer only from committed recordings. Cannot call out, so it cannot spend. |
| `behaviour` | `false` | Also put the contract in front of a model. Costs k calls per request per side. |
| `version` | pinned | Which release of the CLI to run. |

Two things worth knowing before you turn it on:

**Start with `fail-on: unreadable`.** On an existing dependency the first run
usually finds real things, and a check that blocks every pull request on day one
gets switched off by the end of the week. `unreadable` fails only when too
little could be read to say anything, which is the blind spot worth stopping
for. Move to `found` once the backlog is clear.

**`replay: true` makes the run free and deterministic.** Recordings are keyed on
the text of the question, so a check that runs on every pull request asks about
an unchanged parameter once, ever. Commit `.stantal/judge` and CI never calls
out at all.

## For API providers

Run it against a release you have not published yet. Nothing has shipped, so
there is nothing to defend. You see which of your changes a model will read
differently, while it still costs minutes to fix.

## What it does not do

It never runs the package it is reading. Contracts are parsed out of the
published files, so nothing from an untrusted package is executed on your
machine.

It withholds claims it cannot support. Where extraction could not read part of a
contract, the affected findings are listed as withheld rather than reported or
silently dropped.

## Status

Early development. The name is reserved on npm and the code runs, but nothing
about the CLI's interface is stable yet. See [CHANGELOG.md](CHANGELOG.md).

| | |
|---|---|
| ✅ | Contract extraction, per surface, without executing the package |
| ✅ | Fetch and unpack published versions |
| ✅ | Layer 0 — structural comparison |
| ✅ | Layer 1 — prose comparison, with an optional model judge |
| ✅ | CLI, and the release-history walk |
| ✅ | Layer 2 — behavioural comparison, single and multi-turn |
| ⬜ | Verdict URLs, CI check, blast radius |

**What Layer 2 can and cannot say.** A request may carry prior turns, so a
failure that only appears once a conversation is under way is reachable — some
are, and they are invisible to a first-turn-only harness, because on turn one
leaving a field out is the correct answer. What it reports is what *this* model
did on *this* pair, at the confidence the sample supports. A finding whose two
rates do not separate is labelled `underpowered` rather than promoted.

## Development

```bash
npm install
npx tsc --noEmit
npx vitest run
```

---

<p align="center"><sub>MIT</sub></p>
