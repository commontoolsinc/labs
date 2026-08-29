# Test-run records

When recording is enabled, a top-level test run produces one record per test.
Each record contains the test's identity, outcome, and duration. The run ships
those records with its context to a public store. A repository test that drives
a harness as a library over fixture files produces its own record, not records
for the fixture runs.
[The spec](../specs/test-records.md) is the contract (identity
rules, line formats, store guarantees, trust boundaries), and the
reasoning that produced it is in [the archived
plan](../history/plans/test-run-telemetry.md). This document is how the
running system is operated: what gets recorded, the environment surface,
how to opt a workstation in, and how to read the data.

## What a record is

A test's identity has three required parts: **kind** (`unit`, `browser`,
`pattern`, `integration`, `typecheck`, `lint`, `format`, `gate`), **scope**
(the owning workspace member, or `repo`), and **name** (whatever the test's
own runner reports — a bdd describe chain, a pattern file path, a task name,
a script step). An optional **variant** separates the same test running
in a non-default configuration. The default configuration is unmarked. Since
the server-execution flip (2026-08-28) the default deployed-topology lanes
run the ON posture unmarked — continuing the history of the previously
unmarked default jobs — and the surviving explicit OFF regression-guard jobs
use `server-execution-off`. The pre-flip explicit-ON jobs'
`server-execution` marker is retired; their history stays queryable under
it. The single-process default jobs (the unit suites, `cf test`, the
no-server pattern-unit lane) never read that default and stay ambient-OFF,
so they are unmarked for the older reason: the flip does not reach them
(`docs/specs/test-records.md`). One record is one JSON line; one uploaded
object is a run's
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
append-only, no-double-mapping, acyclic rules. The same rename applies to
every variant.

## The environment surface

- `CF_TEST_RECORDS_DIR` — the active run's spool directory. Producers
  append record fragments here; when it is unset, recording is off
  everywhere. CI jobs set it to a workspace directory; local entry points
  set it themselves when they own a run. Never point two concurrent runs
  at one directory by hand — each run owns its own spool.
- `CF_TEST_RECORDS_KEY_FILE` — a personal reporting key (see below), put in
  the shell's profile and in each agent harness's configuration by `deno
  task test-records-key setup`. Its presence is the local opt-in: with it,
  `deno task test`, `deno task integration`, and `deno task run-recorded`
  stamp a spool, ship it when the run ends, and sweep any orphaned spools a
  killed run left behind. It has to reach shells nobody is typing into,
  since that is what an agent's run is, so the export goes in `.zshenv`
  rather than `.zshrc`. A harness that runs its commands through no shell at
  all is covered by its own configuration instead, which the setup command
  writes; the harnesses it knows are listed in
  `tasks/test-records-agent-config.ts`, and one whose directory is not
  there is left alone. Anything else — a bash workstation whose agents run
  non-interactive shells, a harness nothing here knows — puts the variable
  in whatever starts the agent.
- `CF_TEST_AGENT` — an opaque label for the operating agent, recorded
  verbatim in the run context. Set it to tell one agent from another, or
  one checkout of a fleet from the next; it is never required. Left
  unset, a run started by an agent is still labeled, by the harness that
  started it — `claude-code`, `cursor`, `codex`, or `agent` for anything
  that announces itself only as one. A person's own terminal carries
  none of those, so their runs stay unlabeled, and a consumer that wants
  human runs alone reads the ones with no `agent` field.
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
commit access, the one command below is yours.

A key takes only a GitHub identity, and one command:

```
deno task test-records-key setup
```

generates a delivery identity, dispatches the minting workflow, watches
until the run delivers, installs the key file with owner-only
permissions, and puts `CF_TEST_RECORDS_KEY_FILE` where the things that
run tests will find it: the shell's profile, and the configuration of
every agent harness installed here, since an agent that runs its
commands without a shell is reached only by telling its harness to
carry the variable. Every shell opened after that records, and so does
every agent. A profile that
already sets the variable is reported and left alone, whether it points
somewhere else or sets it without exporting it, and so is a login
profile that does not exist yet, since creating one is what stops a
login shell reading the file it falls back to. Rerun the command and it
takes up whatever run is already minting for you rather than starting a
second one, which is what makes an interrupted setup resume.

The dispatch is the authorization check, which is why it takes
repository write access.
With a token that can only read, the command prints the workflow page to
open in a browser and the recipient string to paste into it, then keeps
watching for the run that click starts. The wait has no bound, since a
run takes as long as it takes; Ctrl-C stops watching and running the
command again picks up where it left off. Run it on a workstation that
already holds a key and it re-checks the shell profile rather than
minting a second one — unless a run is already minting for you, which it
takes up, because the key that run delivers is the one replacing what is
installed.

`request` and `collect` are the same path in two invocations, for
somewhere a watching command is unwanted — a shell without a terminal to
interrupt, or a delivery collected on a different day than it was asked
for:

```
deno task test-records-key request
deno task test-records-key collect
```

The key travels sealed. The delivery identity is an X25519 key pair whose
public half is the `cfr1...` recipient string the tool prints and the
workflow takes as its input; the private half stays in
`~/.config/common-fabric/test-records-identity.json` and never leaves the
workstation. The workflow seals the minted key to that recipient —
ephemeral-sender X25519, HKDF-SHA256, AES-256-GCM, with both public keys
bound into the derivation — and publishes the box as a workflow artifact
named by the recipient's fingerprint. Everyone who can read the
repository's artifacts, GitHub included, holds a box that only the
requester's stored identity opens. What comes out is then checked
against the collector's own GitHub login, so a key minted for one person
does not install for another.

Keys stay valid while you stay active: a daily janitor disables the
accounts of people with no pull-request activity for a month and
re-enables them when they return — the same key file simply starts
working again.

You hold one live key: minting revokes the previous ones before it
creates the new one, so `deno task test-records-key setup --rotate` is
how a lost or leaked key is rotated, and a second machine gets the
existing key file copied to it rather than a fresh mint that would kill
the first machine's. A mint that fails after the revocation leaves you
with no key rather than two; the next run says so, and running setup
again mints one.

A key file on disk is not the same thing as a key that works, so setup
asks whether the one installed here is still accepted before it stands
down. A key that has been revoked — by a rotation from another machine,
or by a mint that failed after revoking the key it was replacing — is
replaced rather than mistaken for a working one, and no flag is needed
to recover. Where the question cannot be put at all, setup says so and
leaves the key alone.

## Taking it off a workstation

```
deno task test-records-key uninstall
```

removes what setup put there — the key file, the delivery identity, the
export it added, and the entry in each harness's configuration —
leaving any line or value a person set themselves alone.

Both commands write a profile the way a profile should be written. A
profile that is a symbolic link, which is what a dotfiles repository
leaves behind, is followed: the link stays a link and the file it points
at is what changes. A file's permissions carry over, so one kept
readable only by its owner comes back that way, and a file either of
them creates is readable only by its owner. Each replacement happens in
one step, because a shell startup file left half written is a shell that
will not start. And a file whose state cannot be read — permissions
withdrawn, a directory closed off — is reported and left alone rather
than guessed at.
Records that were spooled and never shipped stay where they are, since a
later key ships them; the command says where they sit and what removing
them would throw away.

Two things it deliberately does not do. The service account and its key
still exist, so a key that has leaked is made useless by minting a
replacement, from this machine or any other, and not by uninstalling.
And records already in the store stay there: they carry no personal
material, and no key this tool installs can change or remove anything
that is already stored.

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

The shared `test-records-ship` action accepts an optional `variant` input.
It applies the value to every spooled and JUnit-derived record in that job.
Leave it unset for the default configuration.

The relay runs its parser from the default branch. Land parser, relay, reader,
and action support for a new optional record field before any test workflow
starts emitting it. Enabling a field in the same change makes the old relay
drop it from that change's pull-request artifacts before writing them to the
create-only store.

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

A harness that is also a library — one this repository's own tests drive
over fixture files — takes the decision to record from its caller, not
from the environment alone. Its entry point asks for records; a test
driving the same function does not, since the files it hands over are that
test's fixtures. `recordsSpooledBy` from
`@commonfabric/test-support/records` pins both halves of that: it points
recording at a fresh spool, runs the function, and hands back every record
the function left there.

A harness a test drives as a child process takes it the other way round,
since the child reads its own environment: the test hands the child an
empty `CF_TEST_RECORDS_DIR`, which is recording off. `tasks/integration.ts`
does that for the `cf` children whose files it times itself, and
`packages/deno-web-test/test/utils.ts` for the fixture projects it runs the
browser harness over.

Every test must finish within sixty seconds in CI, not counting setup; a
check that cannot is a container to split, and the report's over-60s list
is the work queue for that.
