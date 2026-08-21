<h1 align="center">Leeway</h1>

<p align="center">
  Know whether an upgrade changes how a model uses your dependency —<br/>
  before you take the upgrade.
</p>

<p align="center">
  <img alt="status" src="https://img.shields.io/badge/status-early%20development-orange?style=flat-square" />
  <img alt="license" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" />
  <img alt="typescript" src="https://img.shields.io/badge/TypeScript-strict-3178c6?style=flat-square&logo=typescript&logoColor=white" />
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D20-339933?style=flat-square&logo=nodedotjs&logoColor=white" />
</p>

---

`npm install` succeeds. `tsc` exits 0. Your tests pass. The wire returns `200`.
And your product quietly stops working.

Leeway compares two versions of a package and tells you whether a model
consuming its tools will behave differently.

## Install

```bash
npx leeway <package> <from> <to>
```

No account, no setup, nothing to configure.

## Usage

```
$ npx leeway @scope/example-sdk 1.4.0 1.5.0

  @scope/example-sdk · 1.4.0 → 1.5.0

  VERDICT  behaviour-breaking
           The create path stops being reachable on most requests.

  Run with --json for the full report.
```

Exit codes: `0` clean, `1` behaviour-breaking, `2` extraction failed.

## Status

Early development. Not yet published to npm.

| | |
|---|---|
| ✅ | Contract extraction and normalization |
| 🔨 | Version comparison |
| ⬜ | CLI |

## Development

```bash
npm install
npx tsc --noEmit
npx vitest run
```

---

<p align="center"><sub>MIT</sub></p>
