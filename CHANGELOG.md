# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While the major version is `0`, the **minor** is the breaking one — `^0.1.0`
does not match `0.2.0`. Stantal applies that same rule when deciding whether an
upgrade needs a full re-run.

## [Unreleased]

### Added

- **Layer 2 — behavioural comparison.** A model is shown each version's contract
  and the tool call it makes is recorded. Nothing is executed: no credentials, no
  side effects, no network beyond the model provider.
  - Seed requests are generated from an **anchor** version, never from the pair
    under test. Generating them from the newer contract would mean the request
    was written against the prose being evaluated, and every number it produced
    would be circular.
  - A single differing run is not a finding. Each side runs `k` times and a rule
    fires only when two Wilson score intervals fail to overlap.
  - `k = 5` separates a complete change of behaviour. A partial shift needs
    `k = 8`, so partial shifts are reported and labelled `underpowered` rather
    than dropped.
  - Native tool-calling adapters for Anthropic, OpenAI and Gemini. Temperature is
    left at the provider default on purpose — pinning it to zero makes the `k`
    runs identical, which is a sample of size one wearing a `k`-shaped label.
- `STANTAL_SERVICE_TIER` (OpenAI only), to request cheaper, slower processing
  from the API. Opt-in and **unverified**: nobody has confirmed against the
  live API that it changes anything, so it stays off unless you set it
  yourself.

### Changed

- **OpenAI's default model moves off `gpt-4o`** — it was two generations
  stale. Layer 2's caller now defaults to `gpt-5.4`; Layer 1's judge now
  defaults to `gpt-5.4-mini`. A live probe against the OpenAI API confirmed
  both call tools normally, alongside `gpt-5.5`; `gpt-5-mini` declined to
  call a tool at all, and the `gpt-5.6` family rejects function tools on the
  chat-completions endpoint outright, so neither was a candidate. Override
  either default independently with `STANTAL_CALLER_MODEL` /
  `STANTAL_JUDGE_MODEL`.
- **The judge's gemini model stays at `gemini-3.6-flash`, deliberately.**
  Every judge cassette recorded so far — including the ones behind this
  project's reported findings — is keyed to it, and they replay offline with
  no key and no network call. A newer `gemini-3.7-flash` exists and works,
  but moving the pin would strand every recording on disk for no benefit, so
  it did not move.

- **Prior turns in Layer 2.** A request may carry the conversation it
  continues, so failures that only appear mid-session are reachable. They are
  invisible to a first-turn-only harness: on turn one there is nothing to fill
  an optional field with, so leaving it out is correct and the run comes back
  clean. History is held identical on both sides, exactly like the request
  text, so it cannot be what moved the result.
- **`new_field_used`.** Reports a field the older version never declared and
  the model now fills. A field nothing declares cannot be passed, so the older
  side is not a sample that could have gone the other way — one observation is
  proof it can happen, which is also its limit, so it reports `underpowered`
  unless the two rates separate.

### Known limitations

- **A Layer 2 finding describes one model on one pair.** It is not a claim
  about models in general, and the report names the model that produced it.

## [0.0.1] - 2026-08-26

No code change.

### Added

- `repository`, `homepage`, `bugs` and `keywords` in the manifest. `0.0.0` was
  published without them, so the registry page carried no link back to the
  source and no terms to be found by. npm serves these from the latest version,
  so republishing was enough.
- `CHANGELOG.md` now ships in the published tarball. npm includes `README` and
  `LICENSE` on its own but not this.

## [0.0.0] - 2026-08-26

Name reservation on npm. The code below is present and runs, but nothing about
the CLI's interface is stable yet.

### Added

- **Normalized contract schema.** One shape for every source of tool
  descriptors, so extraction and comparison never need to know where a contract
  came from.
- **Extraction without execution.** Contracts are parsed out of published files.
  The package under test is never imported, called or run.
  - MCP servers, over the official SDK client in a sealed environment.
  - Host tool packs and framework shims, read statically from the entry point
    the manifest resolves to. Literals are folded and constants are followed
    across files and into dependencies, but no function is ever called and no
    branch is ever taken.
  - `bin`-only packages, where the command *is* the interface and there is no
    `exports` or `main` to resolve.
  - Zod schemas, read as declarations rather than evaluated. `z.string()
    .optional().describe("…")` is a sentence about a parameter, and its meaning
    is in the shape of the chain rather than in what the chain returns.
  - Zod namespaces identified by fingerprint, because bundlers rename `z`. An
    identifier counts only after three distinct zod constructors have been
    called on it — one or two would let an unrelated utility object through and
    start inventing parameters.
- **Layer 0 — structural comparison.** Tools, parameters, types and required-ness.
- **Layer 1 — prose comparison.** A fixed taxonomy of rules over tool and
  parameter descriptions, with severity, basis and confidence on every finding.
- **The judge.** Findings that turn on meaning rather than text are marked
  `unconfirmed` until a model settles them. Three guards, all tested:
  - It never chooses a target. Candidates arrive with the target already fixed.
  - Its answer is `yes` / `no` / `unclear`, never prose.
  - It must quote, and the quote is verified against the source. A fabricated
    justification is discarded, leaving the finding `unconfirmed` rather than
    flipping it off.
- **Judge cache.** Answers are recorded once and replayed forever, keyed on the
  text of the question rather than its id — a walk over 40 releases asks about
  an unchanged parameter 40 times, and those are one question. Replay mode
  cannot reach the network, so it cannot spend.
- **Registry access** behind an interface: version history, and unpacking a
  version plus its dependencies into a permanent cache.
- **Release-history walk.** Onset detection for a finding across a package's
  whole published history — first bad version, last clean version, and whether
  it is still present.
- **CLI.** `npx stantal <package> <from> <to>`. No account, no key, no setup.
  Exit `0` clean, `1` something to look at, `2` could not read enough to say.

### Contract guarantees

These are properties of the tool, not features, and breaking one is a bug:

- **Absent is not empty.** A version with no such surface reports an absence. A
  zero-tool contract would diff as "every tool removed".
- **"Could not read it" is not "it is not there."** Unevidenced absences are
  marked as such, and comparison refuses to run against one rather than
  reporting a withdrawal that was never made.
- **Gaps suppress claims.** Every unreadable descriptor emits a note with a
  scope and a `file.js:line`. Claims that depended on it are withheld and
  returned in `suppressed` — listed, never silently dropped.
- **A nullable parameter stays required.** It still has to be passed. Calling it
  optional would invent a finding about a required parameter.
- **Schema operations that change which fields exist are refused**, not guessed.
  `.omit()`, `.partial()` and `.extend()` produce a note carrying a path instead
  of a contract nobody can trust.

[Unreleased]: https://github.com/hellunleash/stantal/compare/v0.0.1...HEAD
[0.0.1]: https://github.com/hellunleash/stantal/compare/v0.0.0...v0.0.1
[0.0.0]: https://github.com/hellunleash/stantal/releases/tag/v0.0.0
