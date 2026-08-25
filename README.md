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
| ✅ | Layer 2 — behavioural comparison (single-turn only, see below) |
| ⬜ | Verdict URLs, CI check, blast radius |

**Layer 2's known limit:** a request is one user message with no history, so
only first-turn failures are visible. A failure that depends on what the
conversation already contains cannot be reproduced yet.

## Development

```bash
npm install
npx tsc --noEmit
npx vitest run
```

---

<p align="center"><sub>MIT</sub></p>
