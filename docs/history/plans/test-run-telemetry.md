---
status: historical
created: 2026-08-17
archived: 2026-08-19
reason: "Executed plan; every test run is recorded and the store is applied."
superseded-by: docs/specs/test-records.md
---

# Tracking every test run

This document designs a system that records, for every test of every kind in
this repository, each individual execution: whether it passed, where it ran,
against which commit, and how long it took. The record store is readable
without credentials, appendable only with a credential, and that credential
cannot alter anything already recorded. The design is written for the whole
team; it covers the identity scheme, the record format, the recording and
upload paths, the storage backend, and the sequencing of the work.

**Status:** in execution. Written 2026-08-17; implemented 2026-08-17 (see
[Execution state](#execution-state) for what is live, what awaits the infra
apply, and where the implementation settled details this document had left
open).

## The vocabulary, briefly

- A **test** is a named check with a pass or fail outcome: a unit test case, a
  pattern test file, an integration case, a type-check task, a lint task, a
  repository gate. Builds and deploys are not tests.
- A **run** is one execution context that executes tests: one CI job, or one
  local invocation of a test task. A GitHub workflow run contains many runs
  in this sense, one per job.
- A **record** is one line of data stating that one test executed once in one
  run, with its outcome and duration.
- An **identity** is the durable name of a test: the triple of kind, scope,
  and name defined below. Two records with the same identity describe two
  executions of the same test.
- The **spool** is a local directory where producers drop records during a
  run.
- The **store** is the durable backend that uploaded records land in.
- A **team member** is a person in the GitHub organization's Team group or
  one of its subgroups; a **new contributor** is a person we do not know
  yet who sends pull requests. Employees are not a category this design
  uses: they matter only as the people who can perform the initial cloud
  administration.

## The problem

The repository already measures a lot and keeps almost none of it:

- Five CI job families emit per-test JUnit XML and upload it as
  `test-timing-*` artifacts (`.github/workflows/deno.yml`), but nothing
  automated reads those artifacts and they expire after 90 days. The sharding
  weight tables (`tasks/test-timing-weights.ts`,
  `tasks/select-pattern-integration-files.ts`) are hand-refreshed from CI
  logs and local measurement, because the lanes those tables serve emit no
  JUnit and the artifacts need an admin token to fetch
  (`docs/development/CI_PERFORMANCE.md`).
- The workspace unit-test runner (`tasks/workspace-tests.ts`) measures every
  package's duration and prints a `Package timings:` block to the log, which
  scrolls away.
- The core CLI integration sections time every `cf` invocation into an
  ad-hoc `[cf-timing]` log; the `acl` and `fuse` scripts time nothing. The
  browser harness (`packages/deno-web-test`) and `cf test` print console
  text only. The type-check, lint, format, and `check-*` gates report an
  exit code and nothing else.
- Flakiness is visible only at run granularity: the dashboard's ci-trust tile
  counts main runs that were green on the first attempt. Which test caused a
  rerun is reconstructed by hand, and the findings live as prose postmortems
  under `docs/history/`.

So none of the questions this system exists to answer are answerable today:
how many times has this test ever run, when did it last fail, does it fail at
a steady background rate, is it slower than it was last month, does it fail
only on CI or also locally. Fixing a flake starts with an afternoon of
archaeology instead of a query.

## What a solution must satisfy

1. **Every kind of test is covered** — unit, browser, pattern, integration,
   the CLI script suites, type checks, lint, format, and the repository
   gates, in every workflow that runs them. Anything that can fail a run is
   a test.
2. **Identity survives refactors of the test code.** Moving a test between
   files, splitting a test file, renaming a test file, and reformatting must
   not change a test's identity. No per-test annotation (a UUID, a registry
   entry) may be required to write a test.
3. **Records are cheap.** Only metadata the runner already has: outcome,
   duration, commit, run context, agent label. No log capture, no artifacts.
4. **The store is readable by anyone, without any credential, and
   appendable only with a key, and the append key gives no power over
   pre-existing data.** Public read is the shipped state, not a later
   option.
5. **Reporting is as light as possible.** Producers append lines to a local
   file; one upload per run ships everything. A reporting failure never
   fails the run. No retries, no sleeps: one attempt, and a lost record is
   an acceptable loss.
6. **Local and CI runs both report**, distinguishably. Local reporting is
   inert unless credentials are present. Fork pull requests — where most CI
   test executions happen — must be able to report despite holding no
   secrets and no identity token. Reporting also survives the realities of
   a workstation: concurrent runs at high load keep their records apart,
   and a run killed without warning loses at most its newest unflushed
   lines, with everything already spooled recovered under its true
   context.
7. **A reporting key takes only a GitHub identity to get and keep.** Team
   members and new contributors alike obtain their key without Common
   Tools accounts of any kind and without handling secrets by hand, and
   keeping it costs nothing while they stay active. The path must work for
   a person whose `GH_TOKEN` grants read access only, triggering
   privileged steps from their web browser.
8. **Every test takes at most 60 seconds in CI, not counting setup; most take
   milliseconds.** Where today's checks are coarser than that, the design
   must name them and provide the direction to split them.

## The design

### Identity is the reported name, not the file or a UUID

A test's identity is the triple:

- **kind** — the class of check: `unit`, `browser`, `pattern`,
  `integration`, `typecheck`, `lint`, `format`, `gate`.
- **scope** — the workspace member that owns the test (`runner`, `cli`,
  `patterns`, `tasks`, ...), or `repo` for repository-level checks.
- **name** — the full name the test's own runner reports for it.

The principle behind **name**: every runner already has a durable,
human-meaningful name for each test, and we adopt it rather than invent one.
For Deno tests written with `@std/testing/bdd`, the runner reports the
describe chain joined to the test description with `" > "`, and that whole
string is the name. For bare `Deno.test`, the name is the string given to
`Deno.test`. An invented example:

```json
{ "k": "unit", "s": "bakery", "n": "glaze > thickens when heated" }
```

Per surface, concretely:

| Surface | kind | scope | name |
| --- | --- | --- | --- |
| Package unit tests (`deno test`) | `unit` | package | reported test name |
| Browser tests (`deno-web-test`) | `browser` | package | `Deno.test` name |
| Pattern tests (`cf test`) | `pattern` | package | test file path, relative to the repository root |
| Integration tests (`deno test`) | `integration` | package | reported name |
| CLI script suites | `integration` | `cli` | script and section, as in `integration.sh piece-values` |
| Whole-tree type check | `typecheck` | `repo` | `deno-check` |
| CFC pattern check | `typecheck` | `repo` | `cfcheck`, later one identity per pattern file |
| Lint / format | `lint` / `format` | `repo` | `deno-lint` / `deno-fmt` |
| `check-*` gates, compat, vintage, coverage | `gate` | `repo` | the task name, as in `check-docs` |

Both producers of `pattern` records (the CI orchestrator and `cf test`
itself) normalize the file path to repository-root-relative with forward
slashes, so local and CI records of one pattern test join. A sectionless
CLI script (`acl.sh`, `fuse-exec.sh`) is one test named by the script alone
until it grows sections; the section name is the one the script itself
knows (`CF_CLI_INTEGRATION_SECTION`), not the CI matrix label built from
it.

What this identity survives: moving a test between files, splitting a test
file, renaming a test file, reformatting, editing the test body, resharding
(shard labels are run context, never identity), and the same test running
under two different jobs — those are two runs of one test, not two tests.

What it does not survive: any change to the reported name. That boundary is
wider than "a human deliberately renames the test", and the document is
explicit about the ways names change in this repository:

- The unit-test style (`docs/development/unit-test-coding-style.md`)
  requires the top-level describe title to be the source file or class name,
  so renaming a source file or class renames the identities of its
  style-conforming tests. The rename of the subject is deliberate; the
  identity change rides along with it.
- Migrating a bare `Deno.test` file to the mandated bdd style rewrites every
  reported name in the file.
- Parameterized names built from fixture positions, tunable constants, or
  code identifiers (describe titles interpolating a function's `.name`, and
  positional `#${i}` counters, both exist today) change when those inputs
  change. Test authors should prefer stable content-derived keys over
  positions and counters in names; the analysis side flags high-churn
  identities so these get found and fixed.

A name change splits a test's history: records before and after remain
intact but no longer join. When continuity matters, the split is bridged by
the alias file; when nobody bridges it, the cost is a broken trend line, not
data loss. No scheme without per-test annotations can avoid this, because
the reported name is the only durable, author-visible handle a test has.

**The alias file.** `tasks/test-identity-aliases.jsonl` is an append-only
file in the repository; each line maps an old identity to its replacement
and carries the date of the rename. A line may map one full identity, or a
whole scope (for package renames, which this repository has done). Readers
resolve aliases transitively; the guarding CI check — patterned on
`tasks/check-baselines-append-only.ts` — verifies append-onlyness, rejects
cycles, and rejects a second mapping from the same identity. Readers apply
an alias only to records older than its date, so an identity vacated by a
rename and later reused by a new test does not inherit the old history.
Writers never consult the file.

**Collisions.** Nothing enforces that two files in one package avoid
registering the same full name — and the style convention deduplicates by
source file, not by test file, so a source file whose tests are split across
several test files is the expected collision source. Collisions are detected
by the analysis side, which joins all uploaded objects of one workflow run:
two records of one identity inside a single job, or one identity reported
with two different source files, is a collision (the same identity in two
different jobs is not — that is two runs of one test). Detection is
best-effort where the file metadata is (see below); the report makes the
residue visible so names get fixed, and if the residue does not dry up, a
uniqueness gate graduates from report to CI check.

The source file path is deliberately excluded from identity but recorded as
metadata when the producer reliably knows it. JUnit-derived file attribution
is unreliable for any bdd-nested case — Deno attributes nested cases to the
bdd registration frame, and under the clock preload to the preload module
(`docs/development/CI_PERFORMANCE.md`) — so records ingested from JUnit
carry a file only when the classname looks like a repository path, and the
harness-native producers (which know the real path) are the durable source
of file metadata.

### The record and the run context

An uploaded object is newline-delimited JSON: one context line, then one line
per record. Producers write only record lines, so they stay trivial; the
context comes from the run's owner — stamped into the spool when a local
run starts, composed by the relay for CI.

```ts
// Shown at module scope.
/** First line of every uploaded object. */
interface RunContext {
  schema: 1;
  line: "context";
  /** ULID; unique per uploaded object. */
  reportId: string;
  /** Canonical repository name, as in "commontoolsinc/labs". */
  repo: string;
  /** Full hash of the commit the tests ran against. */
  commit: string;
  /** True when the working tree had uncommitted changes. */
  dirty: boolean;
  branch?: string;
  env: "ci" | "local";
  /** Present when env is "ci". */
  ci?: {
    /** GitHub workflow run id; spans every job of the workflow run. */
    workflowRunId: string;
    runAttempt: number;
    workflow: string;
    /** Job identity including matrix leg, as in "Test (3/8)". */
    job: string;
    /** Shard label like "3/8" when the job is sharded. */
    shard?: string;
    /** Pull request head commit; `commit` is the ephemeral merge commit. */
    headCommit?: string;
  };
  /** Opaque label for the operating agent, from CF_TEST_AGENT. */
  agent?: string;
  os: string;
  arch: string;
  denoVersion: string;
  /** ISO 8601 UTC. */
  startedAt: string;
}

/** Every subsequent line. */
interface TestRecord {
  line: "record";
  /** Identity triple: kind, scope, name. */
  test: { k: string; s: string; n: string };
  outcome: "pass" | "fail" | "skip";
  durationMs: number;
  /** Source file, when reliably known. Metadata, not identity. */
  file?: string;
}
```

On pull request runs the checked-out commit is the ephemeral merge commit,
which survives in no branch history; `ci.headCommit` carries the pull
request's head commit so analysis can join records to a durable commit.
Internal slice labels within one job (the workspace runner splits `cli` into
ten slices, for instance) are deliberately unrecorded: they are scheduling
detail below the run-context granularity.

The `repo` field exists so that other repositories of the organization can
later adopt this system against the same store. It carries the canonical
repository name as a constant owned by the adopting repository's tooling,
never derived from git remotes — clones and forks carry misleading remote
names. An identity is scoped within a repository: the full address of a
test is the repository plus the triple, with the repository supplied by
the context, so record lines stay small.

Field discipline: everything in a record is public-repository material —
test names, commit hashes, branch names, durations. Records must never carry
usernames, hostnames, tokens, or log excerpts. The `agent` label is an
opaque string chosen by whoever sets the environment variable. This
discipline is what makes flipping the store to public read a non-event.

Durations come from the runner's own measurement (the JUnit `time`
attribute, or the orchestrator's wall clock), not from `Date.now()` inside
the test process: two packages (`runner`, `background-piece-service`) run
under an auto-advancing fake clock where `Date.now` and `performance.now`
are fake, and a third (`html`) freezes timers
(`packages/test-support/test/clock-preload.ts`), so only runner-side
measurement is trustworthy there.

Failure detail (assertion messages, stack traces) is deliberately not
recorded. Requirement 3 says cheap; the commit hash plus CI run identifiers
are enough to reach the full log when a human investigates.

### Recording: spool locally, ship once

Producers append record lines to a fragment file they create under a
per-run spool directory named by `CF_TEST_RECORDS_DIR`. When the variable is
unset, recording is disabled and producers do nothing — that is the entire
local opt-out. Each producer process writes its own fragment file (named
with a ULID), so concurrent producers never contend, no matter how many run
at once; producers append line by line as results arrive, so a killed run
still leaves the records of every test that finished. A producer that
cannot write — a full disk, a vanished directory — warns once and stops
recording; it never fails the tests. This mirrors how `DENO_COVERAGE_DIR`
already fans coverage output into per-source files.

The spool has an explicit lifecycle, built for concurrency and sudden
death. The entry point that owns a run creates a fresh directory for it —
locally under a fixed per-user spool root, in CI inside the job workspace —
and, locally, stamps the run's context into it at start: the report id,
the repository, the
commit, the dirty flag, the branch, the start time, all captured while they
are certainly true. The owner also holds an advisory file lock inside its
directory for the run's duration. The operating system releases that lock
on any process death, a power loss included, so whether a spool is live is
a fact the kernel reports, never a guess from timestamps. An entry point
that finds `CF_TEST_RECORDS_DIR` already set joins the enclosing run as a
producer instead of opening its own run. Whatever ships a spool consumes
exactly that directory and deletes it afterward; fragments are read line by
line, never concatenated as bytes, and a torn final line from a killed
producer is dropped with a warning and costs only itself.

There are three producer classes, and every test surface in every workflow
falls into one of them:

1. **Jobs that already produce JUnit XML.** Five job families do: four
   (generated-patterns, package-integration, pattern-integration,
   pattern-reload) via `deno test --junit-path`, and pattern-unit via the
   XML that `tasks/integration.ts` synthesizes around per-file `cf test`
   runs. The uploader ingests JUnit directly: an invocation flag supplies
   the kind and scope, and each leaf testcase becomes a record — container
   testcases (Deno emits one per describe level, with overlapping times)
   are dropped, and classnames that are not repository paths are not
   recorded as files. These jobs need no producer change, only shipping.
2. **In-repo harnesses.** `cf test` (`packages/cli/lib/test-runner.ts`),
   `deno-web-test` (`packages/deno-web-test/reporter.ts`), and the CLI
   script suites get a small recording hook that appends record lines to a
   spool fragment. `cf test` already tracks file, duration, and outcome in
   memory; `deno-web-test`'s reporter already sees every result. Of the CLI
   scripts, only `integration.sh` has the per-invocation timing wrapper
   today, and only its `core-*` CI suites enable it; the hook lands in that
   wrapper, and the `acl` and `fuse` scripts get a wrapper added (each is
   one sectionless test until then). The workspace unit-test runner's role
   is plumbing, not recording: it threads the spool and JUnit flags down to
   its leaf `deno test` invocations, which report via class 1.
3. **Command-level checks.** A wrapper task,
   `tasks/run-recorded.ts <kind> <scope> <name> -- <command>`, runs the
   command, measures it, and spools one record from the exit code. This
   covers the `check` job's steps (format, lint, `deno-check`, and every
   `check-*` gate), the gate checks running outside it (`cfcheck`,
   `pattern-compat`, `pattern-vintage`, `baselines-append-only`,
   `coverage-check` — however CI groups them into jobs, since identity is
   the task, not the job), the
   Dashboard workflow's tests job (`.github/workflows/dashboard-image.yml`),
   and the bare `deno test` step for `test/piece-integration.test.ts` inside
   the CLI integration job (which can alternatively take `--junit-path` and
   report via class 1). The wrapper is also the escape hatch for anything
   future that has no native reporter.

One CI job is exempt: the `Status` aggregator only folds the other jobs'
conclusions into the single required check and executes nothing; every input
to it is already recorded.

The shared record-writing library lives in `packages/test-support` (already
the home of cross-package test infrastructure); the wrapper and uploader are
`tasks/` scripts like the rest of the CI tooling.

### Shipping from CI: artifacts and a relay

CI jobs do not talk to the store, because they cannot: `pull_request` runs
from forks — the majority of test executions, and the runs where flakes
actually surface — receive neither repository secrets nor an OIDC identity
token, so no credential design puts an upload inside every test job. The
repository already has the answer in production for exactly this shape: the
coverage gate writes an artifact and `coverage-comment.yml`, a
`workflow_run` follower with base-repository credentials, performs the
privileged write.

So each test job ends with one credential-free step: gather the spool (and
the job's JUnit files), and upload the result as a GitHub artifact named
`test-records-<job-slug>`, `if: always()` so failing runs still record
(failures are the interesting records). The artifact name carries the job
and shard labels — there is no reliable environment variable for either
(`GITHUB_JOB` is the shared YAML key, identical across matrix legs, and
matrix values are not in the default environment), so the workflow
interpolates its matrix values into the artifact name, the same plumbing
every `test-timing-*` and `coverage-profile-*` artifact already uses. Per
the workflow-shape gate (`tasks/ci-workflow.test.ts`), the step carries a
shutdown-phase marker; anchored step timeouts are required only of
work-phase steps, and the shipping step deliberately carries none.

A new follower workflow — the relay — triggers on the CI and Dashboard
workflows' completion, downloads every `test-records-*` artifact of the
triggering run, composes each artifact's context line (repository, workflow
run id,
attempt, commit and pull request head from the event payload, job and shard
from the artifact name), and writes one object per artifact to the store
with the writer credential. The relay is the only CI principal that can
write, its identity token comes from a Workload Identity Federation provider
pinned to the relay workflow file alone, and it runs with base-repository
credentials regardless of where the pull request came from. A relay failure
is visible in the Actions UI and loses at most one workflow run's records.

Records arrive minutes after the run instead of during it. For telemetry
that is free; nothing gates on the store.

**Locally**, the task entry points (`tasks/test.ts`, `tasks/integration.ts`,
the wrapper) invoke the uploader themselves when credentials are present
(`CF_TEST_RECORDS_KEY_FILE`, minted as the next section describes), so a
developer or agent who has opted in reports without any extra command. The
context was stamped into the spool when the run started — so it names the
commit and branch the run actually began against, and a branch switch
mid-run cannot mis-stamp it — and the uploader only gathers, gzips,
performs a single object-create request, and deletes the directory. The
object's name derives from the stamped report id, which makes shipping
idempotent: a spool shipped twice collides on create the second time and
is simply treated as already shipped. On any failure the uploader prints a
warning and exits zero. It makes exactly one attempt per invocation: this
is telemetry, the analysis tolerates missing runs, and a retry loop would
violate repository policy (`AGENTS.md`) to mask a problem the warning
should surface instead. The token-exchange mechanism for using a
service-account key from Deno without gcloud exists in
`packages/dashboard/gcp.ts` (its hardwired read-only scope parameterized
when it moves into the shared library).

The same machinery recovers from sudden death. A run killed without
warning — a crash, a kill signal, the machine rebooting — leaves its spool
directory behind with its stamped context and every line its producers had
flushed. Each opted-in run also sweeps the spool root: it tries the lock
of every directory it does not own, skips each one whose owner still holds
its lock (which is what makes sweeping safe with any number of parallel
runs on a loaded machine), and ships each orphan it can lock under that
orphan's own stamped context — one attempt per sweep, with the idempotent
naming making a half-shipped orphan harmless. The records arrive late but
attributed to the right commit, branch, and start time; the loss is
bounded to the newest unflushed lines and any torn tail. An orphan whose
shipping fails just stays, warned about, until a later sweep succeeds.

**What still goes unrecorded.** A job that wedges and is killed at the step
bound loses whatever its producers had not yet spooled — for the JUnit
families that is the whole job, since `deno test` writes the XML only at
process end. The hanging test itself can never record its own duration
under any producer. Both gaps shrink as surfaces move to incremental spool
hooks (class 2), and the second is ultimately answerable only by the
sixty-second ratchet forcing wedge-prone work into small tests; the design
accepts the residue rather than adding watchdog machinery to every runner.

### Keys for people: minting and the activity lease

Local reporting needs a key file, and the people who need one are team
members and new contributors alike. The only identity both groups are
guaranteed to share is a GitHub account, so the whole credential path is
anchored on GitHub. Each key holder gets their own service account,
`test-records-gh-<username>`, holding the creator-only grant pinned to that
person's own prefix, `v1/local/<username>/`. Per-person accounts make
revocation individual, make attribution structural (a suspect prefix names
its holder), and sidestep the ten-key cap a shared account would hit.

**Minting.** A `workflow_dispatch` workflow in this repository mints keys.
Dispatching a workflow requires write access to the repository, which team
members hold through the Team group, so the ability to trigger it is the
authorization check and the workflow can trust the actor: no membership
lookups, no extra tokens. Its inputs are a delivery recipient (an age
public key — public-key material, safe to paste anywhere) and, optionally,
a username to mint for. With its federated identity the workflow creates or
reuses the person's service account, binds the prefix-conditioned grant,
mints a key, encrypts the key file to the recipient, and publishes the
ciphertext as a workflow artifact named by a fingerprint of the recipient,
so the requester's tool can find its own delivery. Team members mint for
themselves; a new contributor's first key is one dispatch by any team
member, with the contributor's recipient string pasted from the
pull-request thread where they shared it. Everything after that first act
is automatic. Issuance stays gated because an unconditionally automatic
mint would make a spam pull request a credential ceremony — but the
containment described under the store does not depend on who holds keys,
so loosening this later is a policy dial, not a redesign.

**The activity lease.** A key's validity window is fixed when it is minted;
Google Cloud has no way to extend it. So the intended one-month lifetime is
a lease enforced by a scheduled janitor rather than by key expiry: daily,
with the same federated identity, the janitor reads each key holder's
recent pull-request activity in this repository from the public GitHub API,
disables the service accounts of people with none in the past month, and
re-enables accounts whose people are active again. A disabled account's key
file goes inert, not destroyed: when a lapsed contributor returns, their
next pull request revives the file already on their machine, with nothing
to re-download. Renewal is not an act anyone performs; it is a fact about
their activity. A janitor outage fails in the right direction — nothing is
disabled, nobody active is locked out. Key material itself never rotates
automatically; rotation is minting again, on demand or on compromise, and
an uncollected delivery needs no cleanup beyond the lease itself.

**The key tool.** `deno task test-records-key` (a `tasks/` script) turns
the flow into two short invocations, with no waiting built in. The first
generates and stores a fresh age identity and either dispatches the minting
workflow directly, when the person's `GH_TOKEN` is allowed to trigger
workflows, or prints the exact page to open and the recipient string to
paste — the supported minimum of a read-only token and a web browser. The
second invocation finds the completed run's artifact by the recipient
fingerprint, downloads it (the one step that needs the token at all:
GitHub requires authentication to download artifacts even from public
repositories), decrypts it with the stored identity, installs the key file
with owner-only permissions, and prints the `CF_TEST_RECORDS_KEY_FILE`
line to add to the shell. If the run has not finished, the tool says so and
exits; running it again is the retry, in keeping with the repository's
no-polling policy.

### The store: one bucket, create-only writes

The store is a new Google Cloud Storage bucket in the `commontools-core`
project, managed by OpenTofu in the infra repository. No service sits in
front of it. The requirement set maps directly onto GCS IAM primitives:

- **Append with a key, no edit of pre-existing data:** each writer principal
  holds `roles/storage.objectCreator`, whose only object-data permission is
  `storage.objects.create` — it can neither read, list, overwrite, nor
  delete stored objects (overwriting requires `storage.objects.delete`,
  which it lacks). The append credential physically cannot modify or remove
  anything already stored.
- **Read without a key:** `roles/storage.objectViewer` (get and list)
  granted to `allUsers` from day one, with the bucket's public-access
  prevention disabled — both part of the initial infra change. The field
  discipline above is what makes publishing the data a non-event.
- **Precedents:** the infra repository has worked examples of the
  neighboring mechanisms — a tofu-managed bucket with uniform access,
  versioning, and lifecycle rules (`tofu/pattern-drafter/main.tf`), a
  write-without-read custom role (same file), an `allUsers` public-read
  grant (`tofu/gke/artifact-registry.tf`), and a GitHub OIDC federation for
  this repository pinned to one workflow file
  (`tofu/labs-github-actions/main.tf`). The objectCreator/objectViewer pair
  itself is new ground there; its properties rest on GCS semantics, not on
  an existing infra module.

Object layout: `v1/<source>/<yyyy>/<mm>/<dd>/<name>.ndjson`, gzip-encoded
(`Content-Encoding: gzip`, so plain HTTPS readers receive NDJSON via
transcoding). `<source>` is `ci/<repo>` or `local/<username>`, and IAM
conditions pin each writer principal to its prefix: a relay's service
account can create only under its own repository's `v1/ci/<repo>/`, and
each person's account only under their own `v1/local/<username>/` (a
personal prefix spans repositories; the context carries the repo). Object
names are deterministic: locally the spool's report id, in CI the workflow
run id, attempt, and artifact name — unique because run ids are only
unique within a repository and the repository is in the path (plus a
human-readable slug either way). Shipping the same records twice
therefore collides on create — which is not overwrite — and the duplicate
never comes into being; re-running the relay and re-sweeping an orphan are
both idempotent by construction. The date comes from the run's start, so a
late-shipped orphan lands in the partition its run belongs to; a reader
tailing the store re-lists a trailing window of partitions rather than
only the newest, which is also what picks those late arrivals up. The `v1`
prefix is the schema version boundary: an incompatible schema writes under
`v2/` and readers migrate at their own pace.

Volume is small — a few megabytes gzipped per full CI run, tens of
gigabytes per year — so raw objects are never deleted. What does need
planning is read amplification: the raw layout accretes hundreds of
thousands of small objects over years, and the design's own headline
questions span all history. A periodic compactor (a reader-side job with its
own creator-only principal) writes rollup objects under a `rollup/` prefix —
one object per day and per month of raw data — so full-history consumers
read rollups plus the recent raw tail instead of every object ever written.

Two writer principal shapes exist, and the split is load-bearing:

- **CI:** the relay's keyless Workload Identity Federation principal,
  mintable only by the relay workflow on the base repository. Test jobs
  hold nothing.
- **People:** one service account per key holder, creator-only on that
  person's own prefix, whose key arrives through the minting workflow
  above and is referenced by `CF_TEST_RECORDS_KEY_FILE`. Absent variable,
  no upload. An agent running on a person's workstation reports under that
  person's key; the `agent` label is what tells its records apart.

What a leaked personal key buys an attacker, honestly: not modification —
pre-existing objects are untouchable by construction — but fabrication of
schema-valid new records under that person's `v1/local/<username>/`
prefix. Schema validation filters malformed junk, not plausible lies, and
local records are unverifiable against any other system by design (the
field discipline strips everything identifying). Two structures contain
this. The prefix split: consumers that feed decisions — the sharding
weight tables, the sixty-second ratchet, any future gate — read `v1/ci/`
only, whose writer credential never leaves Google-managed federation. And
the per-person accounts: a poisoned prefix names its holder, is disabled
in one act, and can be skipped wholesale by readers while history
everywhere else stays clean. Readers can additionally cross-check an
object's storage-layer creation time against its path date and its claimed
workflow run against the public GitHub API; both checks bound backdating,
neither is load-bearing.

The bucket, providers, conditions, and grants are an infra-repository
change and are sequenced there; this repository's relay and uploader only
need the bucket name and credentials in the environment.

### The sixty-second rule

Every test must complete within 60 seconds in CI, not counting setup; most
should take milliseconds. This is a definition pressure, not just a budget:
anything that cannot meet it is not one test, it is a container that should
be split into tests.

The known violators today, and the split direction for each — they are not
all the same shape:

- **The whole-tree type check** (`tasks/check.sh`, one `deno check` over a
  hand-maintained path list with an 8 GB heap). Direction: shard it into
  per-package type checks, each its own `typecheck`-kind test, the way
  `tasks/cfcheck.ts` already shards pattern type-checking.
- **The CLI script suites** (`packages/cli/integration/*.sh`, minutes per
  section, and `acl.sh` and `fuse-exec.sh` have no sections at all).
  Direction: the section — or sectionless script — is the recorded test
  now; `integration.sh`'s per-invocation timing wrapper is the seam for
  breaking sections into named steps that record individually, and the
  other scripts get the wrapper on the way.
- **`pattern-compat`** loops per pattern file with per-file timing already;
  per-file identities are purely a recording change.
- **`cfcheck`** attributes failures per file but type-checks each shard as
  one batched TypeScript program precisely because the per-program bind
  dominates cost, so per-file durations do not exist and would require
  restructuring the batch. Its per-file records carry outcome without
  duration until someone decides that restructuring is worth it.
- **`pattern-vintage`** replays fixtures, and one fixture covers several
  patterns, so its natural unit is the fixture, not the pattern file; it
  measures no durations today. Per-fixture identities are the recording
  change; anything finer is a redesign.

Enforcement follows the data rather than preceding it: once records flow,
the analysis side lists every identity whose CI duration exceeds 60 seconds,
that list drives the splitting work, and when it is short enough a `gate`
test turns the rule into a ratchet the same way the coverage debt gate
ratchets uncovered lines. One structural blind spot is named above: a test
that wedges rather than finishing slowly never records a duration, so the
ratchet sees slow finishers only; wedges keep surfacing through job
failures, and shrinking that blind spot is part of why surfaces migrate to
incremental spool hooks.

### Reading the data

Reading is deliberately out of scope for the first phases beyond the format
guarantee: the store is listable and fetchable NDJSON that anyone at all
can aggregate with a shell loop. Three consumers are anticipated and
shape nothing about the write path:

- The compactor above, which is also where reader-side validation lives:
  records are untrusted input, malformed lines are ignored, and rollups
  carry only what validated.
- A dashboard collector, following the existing benchmark-history pattern
  (`packages/dashboard/benchmark-history-cache.ts`): pull on its own
  schedule, cache locally, render per-test pass-rate and duration trends
  with the robust trend fitting that already exists in
  `packages/dashboard/trend.ts`. Any surface built there follows the
  dashboard's stated values (`packages/dashboard/README.md`): no
  leaderboards, no blame surfaces — the point is localizing flakes and
  drift so they get fixed, and replacing the weight tables' hand-refresh
  with measurement.
- The collision, high-churn-identity, and over-60-seconds reports described
  above.

Readers must apply the alias file when joining history across renames.

## How the design holds up

Against the requirements:

1. *Every kind covered:* the three producer classes cover every test surface
   in both workflows that run tests, enumerated job by job in Ordering; the
   only exemption (`Status`) executes nothing of its own.
2. *Identity survives test-code refactors:* moves, splits, test-file
   renames, and reformatting verified case by case. The document is explicit
   that name changes — including source renames propagating through the
   describe-title convention and style migrations — split history, and
   bounded aliases bridge the splits that matter.
3. *Cheap:* a record is one short JSON line of data the runner already had;
   the marginal cost per test is an in-memory append.
4. *Store semantics:* objectCreator cannot touch pre-existing objects; the
   read grant goes to `allUsers` on day one, so reading needs no key
   material at all; both are IAM grants, not custom code.
5. *Light reporting:* line appends during the run; one artifact upload per
   CI job with the relay doing the single privileged write, or one gzipped
   request locally; fail-open, single attempt, no credentials in test jobs.
6. *Local and CI, including forks:* same spool, same record shape; the relay
   runs on base-repository credentials for every pull request regardless of
   origin; local upload is gated on the key file being present. Concurrent
   runs are isolated by per-run directories and per-producer fragments;
   sudden death is recovered by the lock-guarded sweep, which ships an
   orphan under its own stamped context with idempotent naming.
7. *Keys on a GitHub identity alone:* minting is a workflow dispatch gated
   by repository access, delivery is encrypted to a requester-held identity
   and collected with a read-only token, and the lease runs on public
   activity data — no Common Tools account appears anywhere in the path,
   and staying active is the only maintenance.
8. *Sixty seconds:* the rule is stated, current violators are named with
   their actual split shapes, and enforcement is driven by the recorded
   data, with its wedge blind spot named rather than papered over.

Failure cases considered:

- **A job dies before shipping.** Spooled fragments survive to the artifact
  step for incremental producers; JUnit-only jobs lose that job's records.
  Visible as a hole (the workflow run exists with no matching objects), and
  the analysis tolerates holes.
- **The relay fails.** One workflow run's records are lost, visibly in the
  Actions UI. No retry; rerunning the relay workflow re-ships, idempotently,
  since CI object names are deterministic.
- **A workstation reboots mid-run.** The lock dies with the machine; the
  spool, its stamped context, and every flushed line survive. The next
  opted-in run ships it all, attributed to the original commit, branch,
  and start time. Lost: the newest unflushed lines.
- **Many runs at once on one machine.** Each run owns its own directory
  and lock, producers never share files, sweeps skip every directory whose
  owner is alive, and deterministic names make an accidental double-ship a
  no-op.
- **A leaked personal key.** Fabrication confined to that one person's
  prefix, which no decision-feeding consumer reads; disable the account,
  mint again, and readers can drop the prefix wholesale. The CI prefix's
  writer never exists as distributable key material.
- **Clock skew or wrong local clocks.** Timestamps are informational; no
  logic orders records by them across runs.
- **Two tests with one name.** Detected by the reader-side join, reported,
  fixed by renaming; a lasting residue graduates the report to a gate.

## Ordering

Each stage lands independently and is useful without the ones after it.

1. **Store (infra repository).** The bucket, publicly readable from day
   one (`allUsers` viewer, public-access prevention disabled); the relay's
   WIF provider; a provider and a scoped broker role for the minting and
   janitor workflows (create a person's account, bind its prefix grant,
   disable and enable it, mint its keys). This is the one stage that takes
   cloud administration — the only place being an employee matters.
2. **Library, wrapper, relay (this repository).** The record-writing
   library in `packages/test-support`, `tasks/run-recorded.ts`, the spool
   gatherer and JUnit ingester, the relay workflow and its object composer,
   the local uploader. Wrap and ship the `check` job's steps, the gate
   checks running outside it (`cfcheck`, `pattern-compat`,
   `pattern-vintage`, `baselines-append-only`, `coverage-check`), the
   Dashboard workflow's tests job, and the CLI job's `piece-integration`
   step: from this point every type check, lint, format, and gate
   execution on CI is recorded.
3. **JUnit-producing jobs.** Add the artifact step to the five job families
   that already produce JUnit; per-case records for pattern-unit,
   pattern-integration, pattern-reload, package-integration, and
   generated-patterns start flowing with no producer changes.
4. **Keys for people (this repository).** The minting workflow, the lease
   janitor, and the `test-records-key` tool: from this point anyone with a
   GitHub account can hold a working key.
5. **Remaining leaves.** `--junit-path` threaded through the workspace
   runner to its leaf `deno test` invocations and set on the runner lane;
   recording hooks in `cf test` and `deno-web-test`; the timing-wrapper
   hook in `integration.sh` and wrappers added to `acl.sh` and
   `fuse-exec.sh`; local upload wired into the task entry points.
6. **Splitting the monoliths.** Per-package type-check tests replacing the
   single `deno-check` identity; per-file identities for `pattern-compat`;
   per-file outcomes for `cfcheck`; per-fixture identities for
   `pattern-vintage`; named steps inside the CLI scripts.
7. **Adoption by other repositories.** An adoption guide, written for an
   agent implementing this in another repository of the organization,
   covering what already exists to lean on — the bucket and its prefixes,
   the record schema, the record-writing library, personal keys (scoped to
   people, not repositories, so a key minted once works everywhere), the
   minting workflow, the compactor — and what the repository must add for
   itself: its canonical `repo` constant, a relay workflow with its own
   federation provider writing under its own `v1/ci/<repo>/` prefix, spool
   wiring in its test entry points, an identity table for its test
   surfaces, and producers for them. The lease janitor widens to count
   pull-request activity across adopting repositories.
8. **Analysis.** The compactor and rollups; dashboard collector and trends;
   collision and high-churn-identity reports; the over-60-seconds report
   and, once the list is short, the ratchet gate; the alias file plus its
   append-only check; retiring the hand-maintained weight tables
   (`tasks/test-timing-weights.ts`,
   `tasks/select-pattern-integration-files.ts`) in favor of measured
   durations.

## Execution state

Updated 2026-08-17. The eight stages are implemented; what remains is
activation and the follow-through that needs live data.

1. **Store** — written as the infra repository's `tofu/test-records` root,
   which lands the dataset inside the `cf-ci-metadata` bucket that the
   infra `ci-metadata` module created (independently, the same day this
   document was written) rather than as a second bucket: the store is the
   `<repo>/test-records/` dataset area, with `submissions/ci/` (relay-only
   writer), per-person `submissions/local/<username>/` folders, and
   `aggregated/` for rollups, all publicly readable. The org-wide
   ci-metadata submitter holds no grant on these folders, so the
   decision-grade property of `ci/` survives. **Not yet applied** — the
   infra change follows that repository's land-on-main-then-apply rule.
2. **Library, wrapper, relay** — live:
   `@commonfabric/test-support/records`, `deno task run-recorded`,
   `tasks/test-records-gather.ts`, the `test-records-ship` composite
   action, `tasks/test-records-relay.ts`, and the Test Records Relay
   workflow. Every check, gate, and dashboard-test execution on CI
   records.
3. **JUnit-producing jobs** — live, and the pattern-reload job's JUnit
   path bug (the XML landed under `packages/patterns/` where the artifact
   step never looked) is fixed on the way. One scope change against
   requirement 6's "fork pull requests must be able to report": the
   relay ships a fork run only when the run's actor is on the
   infra-managed team member list. Team members work from personal
   forks, so this keeps every run the team produces; what it excludes
   is fork runs authored by anyone else, closing the one channel where
   arbitrary accounts could author content into a public store whose
   objects nothing can delete. An unlisted fork pull request still runs
   its tests normally and ships no records.
4. **Keys for people** — live: `test-records-mint.yml`,
   `test-records-janitor.yml`, and `deno task test-records-key`. Delivery
   uses an X25519+HKDF+AES-GCM sealed box implemented on Web Crypto in
   `tasks/test-records-crypto.ts` (recipient strings are `cfr1...`),
   rather than the age tool, which runners and workstations cannot be
   assumed to have; the tool is both ends of the channel, and the
   requester-generated-recipient property is unchanged. The shipped
   guidance sets the issuance dial at team members: they are urged to
   self-service a key, and a person contributing without commit access
   is told, accurately, that they need none — their local tests run
   identically and CI records their pull requests' runs keylessly. The
   design's new-contributor delivery path (a team member dispatching
   with a contributor's recipient string) remains a capability of the
   workflow, exercised at team discretion rather than documented as a
   path; widening issuance stays the policy dial this document already
   names.
5. **Remaining leaves** — live: the workspace runner threads
   `--junit-path` to every leaf whose test task accepts it whole and
   ingests the XML itself (the curated list in `tasks/workspace-tests.ts`
   documents each exception); `cf test`, `deno-web-test`, and the CLI
   shell suites spool their own records; the task entry points own local
   runs. Leaves that cannot take the flag yet — `patterns` and `ui`
   (two-command tasks), `cli` (three invocations per slice), the
   task-graph packages — record nothing at the case level until their
   runners grow a seam, and the browser harness covers `identity`,
   `iframe-sandbox`, and `dashboard`.
6. **Splitting the monoliths** — live: per-package type checks
   (`tasks/typecheck.ts`, also faster in wall clock than the monolith),
   per-file `pattern-compat` records, per-file `cfcheck` outcomes (zero
   durations, as designed), per-fixture `pattern-vintage` records, and
   named steps in the CLI integration sections.
7. **Adoption** —
   [the guide](../../development/test-records-adoption.md) is written;
   [`test-records.md`](../../development/test-records.md) documents operating
   the system in this repository, and the normative contract lives in
   [the spec](../../specs/test-records.md), which is what remains live when
   this plan is eventually archived.
8. **Analysis** — the alias file and its gate, the collision, high-churn,
   and over-60-seconds reports (`tasks/test-records-report.ts`, whose
   `--gate` flag is the ratchet, advisory until the violator list is
   short), the compactor (`tasks/test-records-compact.ts`, awaiting its
   infra principal), and the dashboard collector
   (`packages/dashboard/test-records-history.ts`). Remaining, and
   data-dependent by design: flipping the ratchet in CI, rendering the
   dashboard trends from the collector, and retiring the hand-maintained
   weight tables once measured durations cover them.

Details settled differently than sketched, recorded here so the document
stays honest: the run context's merge commit comes from each job's
`job.json` in the artifact rather than from the relay's event payload,
which does not carry it (the payload stays authoritative for run identity,
and job display names travel in `job.json` because artifact names cannot
carry spaces or slashes); the pattern-unit surface records through the
orchestrator's spool everywhere rather than through its synthesized JUnit,
whose file remains for the timing artifact; the `cf test` hook and the
orchestrator are kept to one producer per run by the orchestrator clearing
the records variable in its `cf` children; and object layout is
`<repo>/test-records/submissions/<source>/v1/<yyyy>/<mm>/<dd>/...` — the
schema version sits inside each source prefix, since the repository and
source moved into the managed-folder path.

## Considered and set aside

- **Explicit per-test identifiers** (UUIDs, registry files). Excluded by
  requirement: writing a test must not require ceremony, and a registry is a
  merge-conflict generator that would rot.
- **Content-based identity** (hashing the test body or its AST). Any edit
  changes the hash, so history fragments on every refactor — the opposite of
  the requirement.
- **File-path identity.** Breaks on renames and moves, and JUnit file
  attribution is already wrong for every bdd-nested case. Used only where
  the file genuinely is the test (`pattern` kind), because no finer name
  exists there.
- **Direct-to-store uploads from CI test jobs.** Fork pull requests hold no
  secrets and cannot mint identity tokens, so this records main pushes only
  and silently drops the runs where flakes surface; it would also spread
  credentials or auth steps across every test job. The artifact-plus-relay
  path records every run and concentrates the writer credential in one
  workflow.
- **GitHub artifacts as the store.** Already the pattern for coverage and
  benchmarks, but capped at 90-day retention, requires a token to read, and
  every consumer re-downloads zip files. Fails the retention and
  keyless-read requirements. (Artifacts do serve as the intra-run transport
  to the relay, which is what they are good at.)
- **The existing OTLP-to-SigNoz pipeline.** Ingest is tailnet-internal,
  retention is about two weeks, and ClickHouse rows are neither publicly
  readable nor append-only in the required sense.
- **BigQuery with insert-only permissions.** The permission that allows
  streaming inserts also covers DML updates, so the "append key cannot edit"
  property depends on carefully withholding job-creation rights rather than
  on a primitive that simply lacks the power. GCS objectCreator is the
  cleaner primitive. (A reader-side BigQuery external table over the bucket
  would also have to contend with the objects' gzip transcoding; if that
  route is ever wanted, the compactor can write rollups uncompressed.)
- **A custom ingest service.** Adds validation and rate limiting at the cost
  of a deployment, image provenance obligations, and an availability
  dependency; GCS IAM already provides every required property, the relay
  already concentrates the CI write path, and a service can be added in
  front later without changing producers.
- **Committing results to the repository.** Append-only history in git is
  precedented (`packages/patterns/baselines/`), but per-run records would
  bloat every clone and turn every CI run into a commit race.
- **Google Workspace impersonation instead of key files.** Granting
  token-creator rights on a writer account to a Google group would remove
  key files entirely, but it authorizes through Common Tools Google
  accounts, which new contributors do not have, and it would move the
  membership authority away from GitHub, where contribution actually
  happens.
- **GCP-enforced key expiry.** A key's validity window cannot be extended,
  so calendar expiry means a new key file — re-encrypted, re-collected,
  re-installed — every month for every holder. The activity lease delivers
  the same hygiene (inactive keys go inert) with no recurring ceremony, at
  the price of trusting the janitor rather than the clock.
- **Delivery by encrypting to registered SSH keys.** A person's public SSH
  keys are fetchable from GitHub and age accepts them as recipients, but
  not everyone registers SSH keys, and a requester-generated recipient
  additionally proves that whoever collects the artifact is whoever asked
  for it.

## What is not settled here

- ~~The bucket's name.~~ Settled: `cf-ci-metadata`, the ci-metadata
  bucket, with this system as its `test-records` dataset.
- ~~The exact WIF attribute conditions for the relay, minting, and janitor
  workflows~~ — settled in the infra repository's `tofu/test-records`
  root (numeric repository and owner ids, the exact workflow file on
  `refs/heads/main`, and the event names each workflow legitimately runs
  under). The compactor's principal remains to be added there when
  compaction is turned on.
- How much of the infra change is packaged as a reusable module for other
  repositories rather than copied, settled when the second repository
  adopts (the `relay_repositories` map is the current seam).
- Where the `CF_TEST_AGENT` label comes from for the agent fleet, and its
  vocabulary.
- How failure-rate-driven test selection in CI would consume this data.
  The intended eventual use — running only the fraction of tests that
  fail most often — fits the write path as built, but the selector's own
  rules are not designed here beyond the constraints
  [the spec](../../specs/test-records.md) states: an identity with no fresh
  records must run (records exist only for tests that ran, so a selector
  that never revisits the unselected starves its own data), a renamed
  test is unknown until its alias line lands, and baselines come from
  push runs — the member gate keeps unlisted fork runs out of the store
  entirely, so the remaining distinction is code provenance, not author
  trust.
- Whether benchmark executions should also produce records under a `bench`
  kind, or remain solely on the existing artifact pipeline — and the
  classification of the benchmarks workflow's validation step with them;
  nothing in the schema precludes adding either.
- Error-message capture. The schema deliberately omits failure text; if
  investigation friction proves too high, a bounded field can be added in a
  later schema version rather than debated now.
- The compaction cadence and rollup shape, which only matter once there is
  enough raw data to compact.
