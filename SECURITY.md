# Security

## Reporting a vulnerability

Report privately through GitHub's
[private vulnerability reporting](https://github.com/hellunleash/stantal/security/advisories/new).
It goes to the maintainer and nobody else, and it does not create a public
issue.

If that is not available to you, email **founder@eigenwork.com** with `stantal`
in the subject.

Please do not open a public issue for a vulnerability first.

Expect an acknowledgement within 7 days. Stantal is pre-1.0 and maintained by
one person, so a fix ships as a new release rather than as a backport.

## Supported versions

| version | supported |
|---|---|
| `0.0.x` | yes — the only line that exists |

While the major version is `0`, the **minor** is the breaking one. There are no
long-term support branches.

## What Stantal does with untrusted input

This matters more than usual here, because Stantal's whole job is to read
packages you have not vetted — that is the point of running it before you
upgrade. So the interesting question is not "is Stantal secure" but "what does
Stantal do with a hostile package".

### It does not execute the package

Contracts are recovered by parsing the published files. The package under test
is never imported, required, called, or spawned. Concretely:

- The entry point is parsed to an AST. Literals are folded and constants are
  followed across files and into dependencies.
- **No function is called.** A schema built by a function call is read as a
  declaration — the shape of the chain — or refused. It is never evaluated to
  get its value.
- **No branch is taken.** A descriptor behind a condition is reported as
  unreadable, not guessed.
- Lifecycle scripts do not run. Versions are unpacked from the tarball rather
  than installed, so `preinstall`, `install`, `postinstall` and `prepare` never
  execute.

A package that can only be read by running it is reported as unreadable. That
is a deliberate trade: a gap in coverage instead of arbitrary code execution on
your machine.

### The one place code does run, and how it is contained

Reading an MCP server means speaking the protocol to it, and that means
starting the process. This is the only path that executes anything from the
package under test.

It runs through the official MCP SDK client with a **sealed environment**:
ambient variables are withheld rather than inherited, so a server started for
extraction does not receive your API keys, tokens, or cloud credentials.

**Known limitation, stated plainly:** a sealed environment is not a sandbox.
There is no container or VM isolation yet. A hostile MCP server started this
way runs with your user's filesystem and network access. Real isolation is
planned and not built. Until it is, treat MCP extraction against a package you
do not trust as running that package — because it is.

Every other extraction path — host tool packs, framework shims, `bin`-only
packages, zod schemas — is static and carries no such caveat.

### Network and data

- The registry is reached over HTTPS through `pacote`, npm's own fetcher, so
  your `.npmrc`, proxy settings and private-registry auth apply unchanged.
- Nothing about your packages, contracts or findings is sent anywhere. There is
  no telemetry and no account.
- The optional model judge is the only outbound call besides the registry. It is
  off unless you set an API key, sends only the contract text needed to answer
  one closed question, and can be disabled with `--no-judge` or forced offline
  with `--replay`.

### Cached data on disk

Unpacked versions live in `.stantal/npm` and recorded judge replies in
`.stantal/judge`. Both hold third-party package contents and model replies, not
credentials. Add `.stantal/` to `.gitignore` — a cache of other people's package
contents is not something to commit.

## Scope

In scope: anything that gets a package's code executed on a host running
Stantal, anything that exfiltrates credentials or contract data, and any way to
make Stantal report a finding that its evidence does not support.

Out of scope: vulnerabilities in the packages Stantal reads. Report those to
their maintainers.
