<h1 align="center">Stantal</h1>

<p align="center">
  <b>They didn't file a ticket. They just left.</b><br/>
  Find the release that broke how an AI calls your dependency.
</p>

<p align="center">
  <a href="https://github.com/hellunleash/stantal/actions/workflows/ci.yml"><img alt="ci" src="https://img.shields.io/github/actions/workflow/status/hellunleash/stantal/ci.yml?branch=main&style=flat-square&label=ci" /></a>
  <a href="https://www.npmjs.com/package/stantal"><img alt="npm" src="https://img.shields.io/npm/v/stantal?style=flat-square&color=cb3837&logo=npm" /></a>
  <img alt="license" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" />
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D20-339933?style=flat-square&logo=nodedotjs&logoColor=white" />
</p>

---

## Start here

**Paste this into Claude Code, Cursor or Codex:**

> Set up stantal in this repo. Run `npx stantal connect`, then do what it prints.
> It needs no account and no API key. Tell me what it found.

That is the whole setup. Your agent does the rest.

**Prefer a terminal?** Same thing, one line:

```bash
npx stantal connect
```

```
  connected  Claude Code
    .mcp.json  — left alone: github

  2 of your dependencies give an AI tools it can call:
    @modelcontextprotocol/server-filesystem  14 tools
    tavily-mcp                                5 tools

  Ask your agent:  pin my contract dependencies with stantal

  No account, no key, no signup. Everything above ran on this machine.
```

Nothing to install, no config to write, no signup. It reads what you already
have.

---

## What this is for

An update changes one sentence in a package's tool descriptions. No error. No
failed build. No version marked breaking. The AI calling it starts getting it
wrong, a feature quietly stops working, and nobody tells you.

Types don't catch it. Tests don't catch it. Semver doesn't describe it. When the
thing calling an API is a model, **the descriptions are the contract**, and
deleting a sentence is a breaking change with no signature.

We checked 22 popular packages across 487 releases: **168 changes** a model would
read differently, and **145** of them broke nothing you could have tested for.

---

## The four things you will actually use

### 1. Lock in what a package does today

```bash
npx stantal pin @acme/sdk
```

Writes a test file into your repo recording what that package offers now. It
passes today and fails the day an update takes any of it away. Nothing to
maintain — you own the file, and it keeps working whether or not you ever run
this again.

### 2. Should I take this update?

```bash
npx stantal @acme/sdk 1.4.0 1.5.0
```

```
  VERDICT  prose-risk
           `target` is optional, has no description, and the tool
           description never says when to pass it.
```

Exit `0` clean · `1` something to look at · `2` could not read enough to say.

Add `--repo .` to also see which of **your** files it touches.

### 3. Which release broke it, and where can I go?

```bash
npx stantal history @acme/sdk --current 1.4.0
```

```
  undocumented_optional  build.target
    introduced in 1.5.0, last clean 1.4.0
    31 release(s) affected, still present

  WHAT TO DO  stuck
     1.4.0 is clean, but every release after it carries 1 finding
     — there is nowhere to upgrade to
```

It names the nearest clean release, never just the latest. If none exists it
says so rather than inventing one.

### 4. Put a deleted sentence back

```bash
npx stantal patch @acme/sdk 1.4.0 --apply
```

When no released version is clean, this restores the prose into your installed
copy. Descriptions only — never a schema, a type or a required field. It has to
find the text exactly once or it refuses.

<details>
<summary>Everything else</summary>

```bash
npx stantal check ./ --against 1.4.0    # a release you have not published yet
npx stantal manifest <before> <after>   # a contract that never reached a registry
npx stantal mcp                         # the MCP server itself, over stdio
```

Flags worth knowing: `--surface <subpath>` reads one entry point only ·
`--html <file>` writes the verdict as one shareable page · `--json` prints
everything · `--replay` answers only from recordings and cannot make a network
call.

</details>

---

## Using your own model

**You do not need one.** Everything above runs with no key and no account. That
is the default, and CI checks it on every commit.

A model adds exactly one thing. Some findings are judgement calls — *does this
sentence really explain this input?* Without a key those are reported as
`unconfirmed` leads. With one, they get confirmed or dropped.

Set **any one** of these and it is picked up automatically:

```bash
export ANTHROPIC_API_KEY=...
export OPENAI_API_KEY=...
export GEMINI_API_KEY=...
```

Or put one in a `.env` file in your project — it is read automatically.
[`.env.example`](.env.example) lists every option with comments.

| provider | judge | behaviour runner |
|---|---|---|
| anthropic | `claude-opus-5` | `claude-sonnet-5` |
| openai | `gpt-5.4-mini` | `gpt-5.4` |
| gemini | `gemini-3.6-flash` | `gemini-3.6-flash` |

- `STANTAL_JUDGE=none` turns it off even with a key set.
- `STANTAL_JUDGE_MODEL=...` picks a different model.
- `STANTAL_VERTEX_PROJECT=my-project` routes Gemini or Claude through Google
  Cloud instead, so it bills to your cloud account rather than an API key.

**What gets sent:** one closed question per finding, carrying a tool name, a
parameter name, and that tool's description *as published in the package*. Never
your source, your file names, or anything about your repository.

<details>
<summary>Comparing what a model actually does (opt-in)</summary>

`--behaviour` goes further: it shows a model both versions and compares the tool
calls it makes. Off unless you ask, because it costs several calls per request
per version. Nothing is executed — no credentials and no side effects, just the
call the model would have made.

</details>

---

## In CI

```yaml
name: Contract check
on: pull_request

jobs:
  stantal:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v5
      - uses: hellunleash/stantal@v0
        with:
          package: "@acme/sdk"
          from: "1.4.0"
          to: "1.5.0"
```

It posts the verdict as a comment on the pull request and edits that same
comment on every push. No key required.

| input | default | |
|---|---|---|
| `package`, `from`, `to` | — | The dependency and the two versions. |
| `repo` | `.` | Scan your files for what the findings touch. `none` to skip. |
| `fail-on` | `found` | `found`, `unreadable`, or `never`. |
| `comment` | `true` | Post the verdict on the pull request. |
| `emit-tests` | `false` | Also write the pinned tests. |
| `replay` | `false` | Answer only from committed recordings. Cannot spend. |
| `version` | pinned | Which release of the CLI to run. |

**Start with `fail-on: unreadable`.** On an existing dependency the first run
usually finds real things, and a check that blocks every pull request on day one
gets switched off by Friday.

---

## If you ship an API

Run it against a release you have not published yet:

```bash
npx stantal check ./ --against 1.4.0
```

Nothing has shipped, so there is nothing to defend. You find out which of your
changes will strand customers while it still costs ten minutes to fix.

Already shipped? `npx stantal history <your-package>` gives you the release it
entered, the last one that was safe, and how long anyone on it has had nowhere
to go.

---

## Privacy

- **Nothing leaves your machine unless you ask.** No account, no telemetry.
- **It never runs the package it reads.** Contracts are parsed out of published
  files, so nothing from an untrusted package executes on your machine.
- **`--repo` never calls out.** The scan of your files is a local read.
- **Private registries already work.** Fetching uses `pacote`, which is what npm
  itself uses, so your `.npmrc`, auth token and proxy are handled.
- **`--publish` strips your file paths** before sending, and prints what it
  removed.

It also withholds claims it cannot support. Where a package could not be fully
read, the affected findings are listed as withheld rather than reported or
quietly dropped.

---

## Status

Early development. It runs, it is tested on Linux, Windows and macOS, and the
interface is not stable yet. See [CHANGELOG.md](CHANGELOG.md).

## Development

```bash
npm install
npx tsc --noEmit
npx vitest run
```

---

<p align="center"><sub>MIT</sub></p>
