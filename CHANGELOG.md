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

### Known limitations

- **Layer 2 is single-turn.** A request is one user message with no history, so
  only first-turn failures are visible. Failures that depend on what the
  conversation already contains cannot be reproduced yet.

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
