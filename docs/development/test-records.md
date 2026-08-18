# Test-run records

Every execution of every test in this repository produces one record — its
identity, outcome, and duration — shipped with the run's context to a public
store. [The spec](../specs/test-records.md) is the contract (identity
rules, line formats, store guarantees, trust boundaries); the design
reasoning and execution state are in
[the plan](../plans/test-run-telemetry.md). This document is how the
running system is operated: what gets recorded, the environment surface,
how to opt a workstation in, and how to read the data.

## What a record is

A test's identity is the triple of **kind** (`unit`, `browser`, `pattern`,
`integration`, `typecheck`, `lint`, `format`, `gate`), **scope** (the owning
workspace member, or `repo`), and **name** (whatever the test's own runner
reports — a bdd describe chain, a pattern file path, a task name, a script
section). One record is one JSON line; one uploaded object is a run's
context line followed by its record lines. The schema, the line codecs, and
their validators live in `packages/test-support/src/records/`.

Records carry only public-repository material: names, hashes, durations. No
usernames, hostnames, tokens, or log text — that discipline is what makes
the store publicly readable, and the schema validators drop anything else
at every read boundary. Publicly readable means the whole internet:
branch names, agent labels, and repository-relative test file paths in
records are world-visible, the same as the repository itself. A branch
whose name should not be public should not report from a workstation.

Renaming a test renames its identity and splits its history. When the
continuity matters, append a line to `tasks/test-identity-aliases.jsonl`
mapping the old identity (or a whole scope, for a package rename) to the
new one with the date; `deno task check-test-aliases` holds that file to
append-only, no-double-mapping, acyclic rules.

## The environment surface

- `CF_TEST_RECORDS_DIR` — the active run's spool directory. Producers
  append record fragments here; when it is unset, recording is off
  everywhere. CI jobs set it to a workspace directory; local entry points
  set it themselves when they own a run. Never point two concurrent runs
  at one directory by hand — each run owns its own spool.
- `CF_TEST_RECORDS_KEY_FILE` — a personal reporting key
  (see below). Its presence is the local opt-in: with it, `deno task
  test`, `deno task integration`, and `deno task run-recorded` stamp a
  spool, ship it when the run ends, and sweep any orphaned spools a killed
  run left behind.
- `CF_TEST_AGENT` — an opaque label for the operating agent, recorded
  verbatim in the run context. Set it to tell an agent fleet's runs apart
  from a person's; it is never required.
- `CF_TEST_RECORDS_SPOOL_ROOT` — overrides the per-user spool root, which
  is otherwise under the user cache directory
  (`~/.cache/common-fabric/test-records`). The root is deliberately not in
  the temporary directory: a spool must survive a reboot to be swept.
- `TEST_RECORDS_BUCKET` / `TEST_RECORDS_PREFIX` — the store coordinates,
  defaulting to the infra-managed `cf-ci-metadata` bucket and this
  repository's `labs/test-records` dataset. The workflows read them from
  Actions variables managed by the infra repository.

## Getting a key

A key is what lets a team member's local runs report, and every team
member is urged to set one up — the whole path is self-service and takes
a couple of minutes. Contributing without commit access? Then keys are
simply not part of your workflow yet, and skipping them costs you
nothing: your local tests run identically without one, and CI records
your pull requests' runs on its own, no key involved. The day you have
commit access, the same two commands below are yours.

A key takes only a GitHub identity:

```
deno task test-records-key request
```

generates a delivery identity and dispatches the minting workflow — the
dispatch is the authorization check, which is why it takes repository
write access. With a token that can only read, the tool instead prints
the workflow page to open in a browser and the recipient string to paste
into it. Once the run finishes:

```
deno task test-records-key collect
```

downloads the sealed delivery, installs the key file with owner-only
permissions, and prints the `CF_TEST_RECORDS_KEY_FILE` line to add to your
shell. Keys stay valid while you stay active: a daily janitor disables the
accounts of people with no pull-request activity for a month and re-enables
them when they return — the same key file simply starts working again.

You hold one live key: minting revokes the previous ones, so running
`request` again is how a lost or leaked key is rotated, and a second
machine gets the existing key file copied to it rather than a fresh
mint that would kill the first machine's.

## How records move

Locally, the entry point that owns the run stamps the spool with the
context at start (commit, branch, dirty flag, machine, agent label), holds
an advisory file lock the kernel releases on any process death, and ships
one gzipped object at the end — exactly one attempt, warning and moving on
if it fails. Every opted-in run also sweeps the spool root and ships any
spool whose owner's lock is free. Object names are deterministic, so
shipping twice collides on create and duplicates never come into being.

In CI, jobs hold no credentials: each test job ends with a credential-free
step that gathers the spool and the job's JUnit files into a
`test-records-*` artifact, and the Test Records Relay workflow — the only
CI principal that can write to the store — composes each artifact's context
from the trusted event payload and creates one object per artifact.
Same-repository runs always ship. A fork run ships only when its actor
is on the infra-managed team member list, which is what lets team
members' personal-fork pull requests report while the store accepts
nothing authored by anyone else; other fork runs still run their tests
normally and simply ship no records. Re-running the relay, or
dispatching it with a run id, re-ships idempotently.

## Reading the data

Everything under the dataset is publicly readable:

```
https://storage.googleapis.com/storage/v1/b/cf-ci-metadata/o?prefix=labs/test-records/
```

Objects are gzip-encoded NDJSON served with transcoding, so a plain fetch
receives text. `packages/test-support/src/records/store-reader.ts` is the
validating reader; `deno task` scripts built on it:

- `tasks/test-records-report.ts` — collisions, high-churn identity
  families, and the over-sixty-seconds list (`--gate` turns that list into
  the ratchet's exit status).
- `tasks/test-records-compact.ts` — rewrites each closed day of raw
  records as one rollup under `aggregated/`; `--plan` shows what it would
  do without credentials.
- `packages/dashboard/test-records-history.ts` — the dashboard's collector:
  cached per-identity daily series shaped for `trend.ts`.

Readers that join history across renames apply the alias file through
`loadAliasResolver` in `@commonfabric/test-support/records`, which the
report tool and the dashboard collector already do. Consumers that feed
decisions read only `submissions/ci/`, whose writer credential never
exists as key material, and exclude fork-authored reports the way those
two do. The relay's member gate means everything
stored was authored under the write-access group's trust — `ci.fork`
marks a team member's fork run — so the remaining distinction for a
decision consumer is code provenance, not author trust: pull-request
runs execute unmerged code, and failure-rate or duration baselines come
from `ci.event` `"push"` runs, whose code the tree itself carries. Both
fields are stamped from the trusted event payload.

Two attribution facts worth knowing when reading `local/` prefixes: the
minting workflow takes a username input, so anyone with repository write
access can mint a key for any username. A `local/<username>/` prefix
therefore attributes records to the key's named holder under the trust
of the whole write-access group, and the minting workflow's dispatch log
is the record of who minted what for whom.

## Covering a new test surface

A runner that already emits JUnit needs nothing but a `--junit`
specification on its job's ship step. A harness with per-result callbacks
appends records through `FragmentWriter` (see the hooks in
`packages/cli/lib/test-runner.ts` and `packages/deno-web-test/runner.ts`).
Anything else wraps its command:

```
deno task run-recorded <kind> <scope> <name> -- <command...>
```

Every test must finish within sixty seconds in CI, not counting setup; a
check that cannot is a container to split, and the report's over-60s list
is the work queue for that.
