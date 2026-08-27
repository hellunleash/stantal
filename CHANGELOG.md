# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While the major version is `0`, the **minor** is the breaking one — `^0.1.0`
does not match `0.2.0`. Stantal applies that same rule when deciding whether an
upgrade needs a full re-run.

## [Unreleased]

### Added

- **The verdict lands on the pull request.** The Action now posts it as a
  comment and edits that same comment on every push, rather than adding a new
  one. It runs even when the check failed the job, which is the case where
  somebody actually needs to read it. A comment that cannot be posted warns and
  leaves the verdict alone. New inputs: `comment`, `github-token`,
  `emit-tests`, `out`.
- **`stantal patch <package> <from>`** puts deleted prose back into the copy of
  a dependency you actually run. This is Layer 4's `patch` remedy made real:
  when every published release carries the defect there is nowhere to upgrade
  to, and the calling code was never wrong.
  - Only prose is restored — never a schema, a type or a required flag. A
    description cannot break a caller, because no caller branches on one.
  - The text is located by exact match and must appear exactly once in the
    whole package. Zero occurrences and more than one are both refused with the
    reason, because choosing between two would be a guess that rewrites
    somebody's dependency.
  - Both string encodings are searched, so a multi-line description whose
    literal is escaped is found rather than silently missed, and the
    replacement is re-encoded to match what it replaces.
  - Nothing is written without `--apply`, and applying re-checks the bytes
    first, so a stale plan skips rather than corrupts.
- **Contract tests you keep.** `stantal pin <package>` reads the version you
  have installed and writes a Vitest suite that records what the package offers
  today. It passes now and fails the day an upgrade takes any of it away. The
  suite reads the contract statically out of `node_modules`, so it never
  reaches the network and never executes the package it is checking.
- `--emit-tests` on a version comparison writes the same kind of suite from
  what the comparison found, pinning the older side so the tests fail on the
  upgrade rather than passing quietly.
- `--out <dir>` sets where emitted tests go. Default `stantal/`, kept apart
  from hand-written tests so a regenerate never overwrites someone's edits.
- `stantal/testkit`, the runtime the generated tests import: `loadContract`,
  `findTool`, `findParam`, `documentsParam`.
- A library entry point. `Report`, `Contract`, the taxonomies and the layer
  functions are importable from `stantal`; everything else stays internal.

### Notes

- An assertion is verified against the contract it pins before it is written.
  A finding proposes a test and the contract confirms it — a generated test that
  fails on a version where nothing is wrong is deleted unread, and it takes the
  real findings in the same file with it.
- Only findings whose meaning has been checked earn a test. An unconfirmed
  finding is a line in a report and never a file in someone's repository.
- A door whose schema could not be read gets no parameter assertions, and a door
  with nothing to pin is skipped rather than written empty.

## [0.1.0] - 2026-08-26

The first release with a stable interface worth using. `0.0.0` and `0.0.1` were
name reservations. This completes the five layers, and adds the two entry points
that make the tool usable by the side of the ecosystem that ships contracts
rather than consumes them.

### Added

- **Layer 3 — blast radius.** `--repo <dir>` answers the only question a
  particular consumer has: does any of this reach me. Four kinds of reach, each
  carrying a `file:line` so the claim can be checked.
  - `dependency` matches on the declared **range**, not the version installed
    today. A caret that resolves clean now picks the defect up on the next
    install, and that is worth knowing before it happens.
  - `surface_import` is the sharpest filter: one package routinely exposes
    several doors carrying different contracts, and a finding on a door you never
    open cannot reach you however true it is.
  - A parameter only counts inside a file that already names its tool. `app`,
    `context` and `limit` are ordinary words; matched across a repository they
    return every file and mean nothing.
  - Findings that cannot reach you are reported **with the reason**, never
    dropped. "We looked and it does not touch you" and "we never looked" are
    opposite claims.
  - Reads the directory you name and nothing else. It never writes, and it never
    calls out.
- **Layer 4 — remedy.** `stantal history <pkg> --current <version>` says what to
  do, not just what changed.
  - The **nearest** clean release, never simply the latest, printed beside the
    latest so the gap is visible. Someone twenty releases back is not taking one
    change, they are taking the accumulated delta of twenty.
  - "There is no clean version" is a real answer. A search that cannot come back
    empty invents a version number, and a fabricated one is checkable, fails, and
    takes the rest of the report with it.
  - A release that could not be read is not a clean release. Those are skipped
    and reported as `unverifiable`, because a hop declined for that reason is a
    different answer from one that was never seen.
  - A pin is a hold, not a remedy. The reason is recorded as a predicate rather
    than a comment, so a later walk re-checks it and the hold lifts itself.
- **`stantal check <dir> --against <version>`** — the provider's gate. Reads the
  build in your working tree, fetches the release you name, and compares. Neither
  other entry point could serve this: comparing two published versions is too
  late, and the manifest form needs a contract already serialized to JSON. The
  package name comes from the build's own manifest, so the two cannot disagree.
- **`stantal manifest <before...> <after...>`** — a contract that never reached a
  registry. Nothing is fetched and no version is resolved, so it reads an
  unpublished release, or a host that writes its own tool set to disk.
  - Format-agnostic: an MCP `tools/list` reply, that reply inside a JSON-RPC
    envelope, a bare array, and a map keyed by tool name all read the same way.
  - Each side takes several documents, catalog first, because a contract is
    often split — schemas generated from routes, prose kept where a person edits
    it. What a model receives is the merge, and reading only the first document
    is wrong in both directions.
  - `--fields-at` names the wrapper a producer nests editable fields under, and
    `--exclude-when` states which tools the runtime withholds. Both are supplied
    rather than guessed: a description read off the wrong object is exactly the
    false finding this tool exists to catch.
- **A GitHub Action**, so the check runs on the pull request that proposes the
  upgrade rather than after someone takes it. Writes a summary and exposes
  `verdict`, `findings`, `reaches` and `report` as outputs. `fail-on: unreadable`
  is the setting to adopt with — a check that blocks every pull request on day
  one gets switched off by the end of the week.

### Changed

- **Layer 2 runs calls concurrently.** They were awaited one at a time, both
  sides included, which made a 55-intent corpus at `k=3` take most of an hour.
  Nobody waits that long for a verdict. The calls were always independent — a
  recording is keyed on the caller, the request and the run index, and no call
  reads another's result. Measured on 330 live calls: 1m3s where the same work
  serial was about fifty minutes. `--concurrency` sets the ceiling, and now means
  the same thing on a history walk and on Layer 2.
- **Results are indexed rather than collected on completion**, so the samples a
  Wilson interval is computed over do not depend on which call returned first.

### Fixed

- **A rate limit no longer ends a run.** Concurrency made a 429 likely rather
  than rare, and one used to leave every remaining intent unmeasured. Retried
  with exponential backoff and jitter, honouring `Retry-After`. A 4xx that is not
  429 is not retried: the request is wrong, and asking again spends the budget
  for the same answer.
- **A judge that cannot answer no longer destroys the verdict.** A rate-limited
  or expired key produced exit 2 and no report, discarding a complete structural
  verdict that had already been computed. The judge is optional everywhere in
  this tool, so the failure now degrades the result to what it would have been
  with no key at all, and the reason is recorded — a run the judge filtered
  nothing out of and a run the judge never answered give the same findings for
  opposite reasons.
- **A withheld structural claim no longer reports as `clean`.** If extraction
  could not read the whole contract and a `tool_removed` claim was suppressed,
  the tool may well be gone; the only reason nothing was said is that reading
  stopped short. Prose gaps already blocked `clean` and structural gaps did not,
  so the two kinds of silence meant different things. Now `unreadable`, exit 2.
- **Vertex AI resolves its token on Windows.** `execFileSync("gcloud")` cannot
  work there in either spelling — the extensionless name is not resolved through
  `PATHEXT`, and Node refuses to spawn `gcloud.cmd` directly as its fix for
  CVE-2024-27980. Both surfaced as "install the gcloud CLI" on a machine where it
  was installed, authenticated and on `PATH`.
- **`--k` and `--concurrency` are validated before anything branches on them**,
  so an argument means the same thing on every path, and neither accepts a value
  `parseInt` would silently truncate.

### Contract guarantees

Added to the list in `0.0.0`; breaking one is a bug:

- **"We did not find it" is not "it is not there."** A repository that could not
  be read properly never presents as one nothing reaches, and
  `canClaimUnaffected()` is the single function that decides it.
- **A release nobody could read is not a clean release.** Recommending an upgrade
  into a version whose contract could not be read would be the worst output this
  tool could produce, so the search skips it and says so.
- **The first run works with no account and no key**, and that is enforced in CI
  rather than asserted here: a job runs the whole tool with every provider
  variable emptied and fails unless a real verdict comes out.

### Privacy

- With no key set, nothing leaves the machine. Extraction, Layers 0, 3 and 4 are
  entirely local, and `--replay` cannot make a network call at all.
- With a key set, a judge question carries a tool name, a parameter name, and
  that tool's description **as shipped in the package** — not your source, your
  file names or your credentials, because it is never given them.
- Private registries need no configuration. Fetching is `pacote`, which is what
  npm itself uses, so `.npmrc`, auth tokens and proxies already work.
### Also in this release (previously unreleased)

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

[Unreleased]: https://github.com/hellunleash/stantal/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/hellunleash/stantal/compare/v0.0.1...v0.1.0
[0.0.1]: https://github.com/hellunleash/stantal/compare/v0.0.0...v0.0.1
[0.0.0]: https://github.com/hellunleash/stantal/releases/tag/v0.0.0
