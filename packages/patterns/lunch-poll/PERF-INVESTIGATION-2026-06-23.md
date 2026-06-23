# Lunch Poll Performance Investigation - 2026-06-23

## Problem

Lunch poll is a representative multi-user, cross-user shared-state workload.
Recent work reduced some graph/render costs, but the current question is
broader: under concurrent users, are the slowdowns and dropped updates caused by
non-idiomatic pattern code, runtime behavior, or an interaction between the two?

This document records the investigation evidence and the measured effect of the
subsequent real lunch-poll refactor.

## Scope and Constraints

- Worktree: `/Users/ben/.codex/worktrees/a587/labs`
- Checked out commit during this pass: `95060a581` (`origin/main`)
- Pattern under investigation: `packages/patterns/lunch-poll/`
- Local worktree server:
  - Toolshed: `http://localhost:9000`
  - Shell: `http://localhost:6173`
- Deployed investigation piece:
  - `http://localhost:9000/lunch-poll-perf-a587/fid1:h3rkJobE_JAna_yV8QSrDM5f1bNftTUMR7A41EwwuSU`
- Source changes made during this phase:
  - This investigation log.
  - `main.tsx` now stores live votes under participant rows and projects the
    public `votes` output from `users[n].votes`.
  - `participant-identity-card.tsx` now records a PerUser append-only
    participant index so handlers can write to the current viewer's row.
  - `reference-shape-experiment.tsx`, an idiomatic reference-addressed
    diagnostic pattern included in the PR as mechanism evidence.
  - Multi-runtime harness support for serializing result cells as `@link` values
    so headless events can pass live references.
  - `lunch-poll-diagnose.ts` support for reference events and serial setup.
  - The earlier string-keyed `storage-shape-experiment.tsx` diagnostic was
    removed from the PR because it violated the documented identity model.
- Local identity file: `cf.key`; ignored by `.gitignore`.

## Prior Context From Git History

Relevant lunch-poll history includes:

- `1f7815684 perf(patterns): add lunch poll scenario diagnostics (#4172)`
- `7860a7897 feat(lunch-poll): migrate visit + vote history to SQLite (#4144)`
- `894ba26d8 Refactor lunch poll into subpatterns (#4166)`
- `c74357002 Fix lunch poll composed UI rendering (#4193)`
- `5abe477c7 fix(memory): gate conflict retries on caught-up local seq (#4237)`
- `c63716fb5 fix(memory,runner): refine commit-conflict granularity (leaf-only + nonRecursive shape reads)`
- `3c482b6c1 Filter votes before mapping... (#4291)`
- `9785c0709 fix(lunch-poll): restore per-voter swatches... (#4295)`
- `95060a581 fix(ts-transformers): lift reactive value-expressions in map/filter/flatMap callbacks (CT-1777) (#4297)`

The old branch `origin/perf/shared-state-write-drops` contains useful prior
analysis. The old evidence identified three cost centers:

- Array vote aggregate graph growth.
- Per-option AI/homepage enrichment on load.
- Concurrent-write conflict/retry exhaustion on shared `votes`.

That branch also concluded that moving vote storage to SQLite did not fix the
core correctness issue because writes still funneled through a shared handle
revision and could drop under conflict. Current main contains runtime conflict
granularity improvements after that branch, so all current results below were
remeasured on `95060a581`.

## Current Pattern Hot Paths

### Join

`packages/patterns/lunch-poll/participant-identity-card.tsx`

```ts
const existing = users.get();
if (existing.some((u) => u.name === trimmed)) return;
const user: User = {
  name: trimmed,
  avatar: override ? "" : (profileAvatar ?? "").trim(),
  color: colorForIndex(existing.length),
  joinedAt: safeDateNow(),
};
users.push(user);
myName.set(trimmed);
if (trimmedName(adminName.get()) === "") {
  adminName.set(trimmed);
}
joinName.set("");
```

Observation: the handler reads the whole shared `users` array, derives
uniqueness and color from that snapshot, then writes the shared users array and
per-user/session cells in one event transaction.

### Vote

`packages/patterns/lunch-poll/main.tsx`

```ts
const current = votes.get();
const existingIdx = current.findIndex(
  (v) => v.voterName === me && v.optionId === optionId,
);
if (existingIdx >= 0) {
  const existing = current[existingIdx];
  if (existing.voteType === voteType) {
    votes.remove(existing);
    return;
  }
  votes.key(existingIdx).key("voteType").set(voteType);
  return;
}
votes.push({ voterName: me, optionId, voteType });
```

Observation: the handler reads the whole shared `votes` array, scans it, and
then mutates the same hot shared array.

## Runtime Event Commit Behavior

`packages/runner/src/scheduler/events.ts` intentionally does not await event
commits after speculative local apply. Exhausted commit failures are logged, but
the event caller is not given a normal application-level failure.

Important lines:

- `tx.commit().then(...)` starts at
  `packages/runner/src/scheduler/events.ts:616`.
- Event commit telemetry is submitted around
  `packages/runner/src/scheduler/events.ts:624`.
- Retry logging occurs around `packages/runner/src/scheduler/events.ts:642`.
- Exhausted retries log
  `"Event handler transaction failed after exhausting all retries"` around
  `packages/runner/src/scheduler/events.ts:661`.

This means a UI can appear to accept work speculatively while durability later
fails after the retry budget.

## Append vs Whole-Array Reads

There are two distinct "why are we reading the array?" questions.

First, lunch-poll explicitly reads the arrays today:

- `joinAs` calls `users.get()` to check name uniqueness and choose
  `colorForIndex(existing.length)`.
- `castVote` calls `votes.get()` to find an existing `(voterName, optionId)`
  vote so it can toggle/remove/update rather than blindly append.

Those explicit reads make each handler depend on the current aggregate array.
That is a pattern authorship issue for a concurrent workload.

Second, the generic `Cell.push()` implementation is not currently a read-free
append either. In `packages/runner/src/cell.ts`, `push()` resolves the link,
calls `this.tx.readValueOrThrow(resolvedLink)`, builds a combined array, and
then calls `diffAndUpdate(...)`. The v2 transaction diff can lower the append to
a tail `splice` patch, but it has already recorded a transaction read of the
array it appended to.

This is an important runtime/API implication. If the runtime had a true
append-only operation that recorded "add this item at the array tail" without
depending on the current array snapshot or concrete pre-append length,
concurrent append-only joins/votes could be much more commutative. Today, simply
deleting a pattern-level `votes.get()` before `votes.push(...)` may not be
enough if `Cell.push()` still widens the transaction read set internally.

For current lunch-poll semantics, a pure append is also not quite enough for
votes: `castVote` models a current vote per `(voterName, optionId)`, with
toggle-off and color replacement. That still needs a localized existence read or
conditional write. The key is that it should read/write the one vote key, not
the whole `votes` array.

## Tooling Notes

The existing diagnostic harness is the best fast test driver for this issue:

```bash
env DENO_DIR=/private/tmp/deno-cache-a587 \
  deno run --cached-only -A packages/patterns/tools/lunch-poll-diagnose.ts \
  --cases=3x10 --rounds=3 --skip-refresh
```

The script does not implement a conventional `--help`; running it with `--help`
executes the default matrix. Inside the sandbox that fails because the
in-process `StandaloneMemoryServer` cannot bind. Run diagnostics outside the
sandbox.

Browser telemetry can be enabled with:

```js
localStorage.setItem("telemetryEnabled", "true");
location.reload();
```

After importing `cf.key`, `globalThis.commonfabric.rt` is present and the shell
debugger controller retains telemetry markers.

## Browser Telemetry Snapshot

After opening the deployed piece, importing `cf.key`, and enabling telemetry:

- Browser URL:
  `http://localhost:9000/lunch-poll-perf-a587/fid1:h3rkJobE_JAna_yV8QSrDM5f1bNftTUMR7A41EwwuSU`
- `globalThis.commonfabric.rt`: present.
- Telemetry enabled: true.
- Retained markers: `761`.
- Graph snapshot after a browser join attempt: `286` nodes, `457` edges.
- Marker type counts:
  - `cell.update`: `324`
  - `scheduler.dependencies.update`: `279`
  - `scheduler.subscribe`: `100`
  - `scheduler.run`: `48`
  - `scheduler.event.preflight`: `4`
  - `scheduler.invocation`: `3`
  - `scheduler.event.commit`: `3`

Negative result: driving the custom input with `agent-browser fill` did not
faithfully reproduce a human join. The join button fired, but the event commit
had zero changed writes. Browser telemetry is useful for observing the mounted
runtime, but the multi-runtime harness is currently the better stress driver.

## Baseline Single-Case Results

### 3 options x 5 users x 3 vote rounds

Command:

```bash
env DENO_DIR=/private/tmp/deno-cache-a587 \
  deno run --cached-only -A packages/patterns/tools/lunch-poll-diagnose.ts \
  --cases=3x5 --rounds=3 --skip-refresh
```

Result:

- Final convergence: true.
- Final users: `5`.
- Final votes: `15` expected, `15` observed.
- Commit conflicts: `856`.
- Commit reverts: `856`.
- Retry warnings: `36`.
- Exhausted event commits: `0`.

Conclusion: this size is correct but already conflict-heavy.

### 3 options x 10 users x 3 vote rounds

Result:

- Final convergence: true across clients, but to the wrong durable state.
- Final users: `10` expected, `7` observed.
- Final votes: `30` expected, `18` observed.
- Commit conflicts: `1309` in the first run, `1723` in the later threshold run.
- Exhausted event commits: `6`.
- Exhausted handlers:
  - `participant-identity-card.tsx:43:2`: `3`
  - `main.tsx:497:3`: `3`

Conclusion: the failure is durable dropped work, not just delayed UI propagation
or client divergence.

### `CF_CONFLICT_ADMISSION=hold`

Command:

```bash
env DENO_DIR=/private/tmp/deno-cache-a587 CF_CONFLICT_ADMISSION=hold \
  deno run --cached-only -A packages/patterns/tools/lunch-poll-diagnose.ts \
  --cases=3x10 --rounds=3 --skip-refresh
```

Result:

- Final users: `10` expected, `7` observed.
- Final votes: `30` expected, `18` observed.
- Commit conflicts: `1841`.
- Commit reverts: `1841`.
- Exhausted event commits: `6`.

Conclusion: `hold` does not mitigate this workload on current main. It increases
conflict churn and leaves the same durable data loss.

## Threshold Matrix: 3 Options, 3 Vote Rounds

Command:

```bash
env DENO_DIR=/private/tmp/deno-cache-a587 \
  deno run --cached-only -A packages/patterns/tools/lunch-poll-diagnose.ts \
  --cases=3x6,3x7,3x8,3x9,3x10 --rounds=3 --skip-refresh
```

| Users | Expected Users | Final Users | Expected Votes | Final Votes | Conflicts | Retry Warnings | Exhaustions | Exhausted Handlers         |
| ----: | -------------: | ----------: | -------------: | ----------: | --------: | -------------: | ----------: | -------------------------- |
|     6 |              6 |           6 |             18 |          18 |       872 |             55 |           0 | none                       |
|     7 |              7 |           7 |             21 |          18 |      1273 |             75 |           3 | `castVote` x3              |
|     8 |              8 |           7 |             24 |          18 |      1254 |             80 |           4 | `joinAs` x1, `castVote` x3 |
|     9 |              9 |           7 |             27 |          18 |      1323 |             85 |           5 | `joinAs` x2, `castVote` x3 |
|    10 |             10 |           7 |             30 |          18 |      1723 |             90 |           6 | `joinAs` x3, `castVote` x3 |

Observations:

- The current correctness threshold is between 6 and 7 users for concurrent
  voting.
- Concurrent join starts dropping durable users at 8 users.
- Once final durable users cap at 7, final durable votes cap at 18 in these
  runs.
- At 7 users, join is still durable, but each vote round loses one `castVote`
  commit.

## Join-Only Matrix: 3 Options, 0 Vote Rounds

Command:

```bash
env DENO_DIR=/private/tmp/deno-cache-a587 \
  deno run --cached-only -A packages/patterns/tools/lunch-poll-diagnose.ts \
  --cases=3x6,3x7,3x8,3x9,3x10 --rounds=0 --skip-refresh
```

This still runs concurrent join and host option creation, but skips voting.

| Users | Expected Users | Final Users | Final Options | Conflicts | Retry Warnings | Exhaustions | Exhausted Handlers |
| ----: | -------------: | ----------: | ------------: | --------: | -------------: | ----------: | ------------------ |
|     6 |              6 |           6 |             3 |       327 |             10 |           0 | none               |
|     7 |              7 |           7 |             3 |       476 |             15 |           0 | none               |
|     8 |              8 |           7 |             3 |       603 |             20 |           1 | `joinAs` x1        |
|     9 |              9 |           7 |             3 |       715 |             25 |           2 | `joinAs` x2        |
|    10 |             10 |           7 |             3 |       999 |             30 |           3 | `joinAs` x3        |

Conclusion: concurrent join itself is reliable through 7 users and then drops
one additional user per extra concurrent joiner above 7, under this workload.

## 7-User Vote Depth

Commands:

```bash
env DENO_DIR=/private/tmp/deno-cache-a587 \
  deno run --cached-only -A packages/patterns/tools/lunch-poll-diagnose.ts \
  --cases=3x7 --rounds=1 --skip-refresh

env DENO_DIR=/private/tmp/deno-cache-a587 \
  deno run --cached-only -A packages/patterns/tools/lunch-poll-diagnose.ts \
  --cases=3x7 --rounds=2 --skip-refresh
```

Combined with the threshold run:

| Vote Rounds | Expected Votes | Final Votes | Conflicts | Retry Warnings | Exhaustions | Exhausted Handlers |
| ----------: | -------------: | ----------: | --------: | -------------: | ----------: | ------------------ |
|           1 |              7 |           6 |       935 |             35 |           1 | `castVote` x1      |
|           2 |             14 |          12 |       963 |             55 |           2 | `castVote` x2      |
|           3 |             21 |          18 |      1273 |             75 |           3 | `castVote` x3      |

Conclusion: at 7 users, the vote path drops one durable vote per concurrent vote
round.

## Graph and Read-Site Findings

Across the 6 to 10 user threshold matrix, final graph sizes are almost flat:

| Users | Final Max Nodes | Final Max Edges |
| ----: | --------------: | --------------: |
|     6 |             463 |            1342 |
|     7 |             465 |            1346 |
|     8 |             464 |            1345 |
|     9 |             464 |            1346 |
|    10 |             464 |            1346 |

Top read sites during vote phases are consistently:

- `sink:result`
- `lunch-poll/poll-option-card`
- `main.tsx:1055:54` (`homePageLookupUrls = options.map(...)`)
- `main.tsx:1752:49` / `main.tsx:1753:49` output snapshots for users

Conclusion: graph/read churn is real and should be optimized, but it does not
explain the durable write loss threshold. The correctness failure correlates
with event commit conflict exhaustion in specific shared-state handlers.

## Storage Shape Experiment: Keyed Records

To test the "array of links / individual cells" direction without first
rewriting the product UI, I first added a local diagnostic-only compatible
variant:

- Local file during investigation: `storage-shape-experiment.tsx`
- Same external handler names used by the harness: `joinAs`, `addOption`,
  `castVote`, etc.
- Same output arrays expected by the harness: `users`, `options`, `votes`.
- Different hot storage shape:
  - `usersByName: Record<string, User | null>`
  - `votesByKey: Record<string, Vote | null>`
- Handlers use `record.key(stableKey).get()` and
  `record.key(stableKey).set(...)` instead of whole-array scans.
- Derived output converts the records back to arrays for harness compatibility.

Important caveat: this experiment used synthetic string keys (`name`,
`optionId`, compound vote keys) so the existing CLI stress harness could drive
it. That is not idiomatic Common Fabric pattern identity. The docs explicitly
prefer live references, `equals()`, and cell links over generated ids or
string-addressed mutation layers. Treat this experiment as evidence about
runtime conflict semantics, not as source to promote into production lunch-poll.
The source file has been removed from the PR.

One setup finding: `Default<Record<PropertyKey, never>>` did not emit a real
`{}` default in the transformed schema for these record inputs. The first manual
multi-runtime probe read the pattern result as `undefined` until the inputs were
changed to `Default<{}>`. That is a separate pattern/schema sharp edge worth
remembering.

Validation:

```bash
env DENO_DIR=/private/tmp/deno-cache-a587 \
  deno task cf check \
  packages/patterns/lunch-poll/storage-shape-experiment.tsx --no-run
```

Manual 2-session harness probe after the default fix:

- Initial outputs were real objects, not `undefined`.
- Host join produced `users=[User 1]`, `adminName=User 1`, host `myName=User 1`.
- Second user join converged to `users=[User 1, User 2]`.
- `myName` stayed per-user scoped (`User 1` in session 1, `User 2` in session
  2).

### 3 options x 10 users x 3 vote rounds

Command:

```bash
env DENO_DIR=/private/tmp/deno-cache-a587 \
  deno run -A packages/patterns/tools/lunch-poll-diagnose.ts \
  --program=storage-shape-experiment.tsx \
  --cases=3x10 --rounds=3 --skip-refresh
```

Compared with the existing-array baseline:

| Shape          | Final Users | Final Votes | Conflicts | Reverts | Exhaustions |
| -------------- | ----------: | ----------: | --------: | ------: | ----------: |
| Current arrays |        7/10 |       18/30 |      1309 |    1309 |           6 |
| Keyed records  |        7/10 |       18/30 |       368 |     368 |           6 |

Result: keyed records materially reduce conflict churn, but do not fix durable
write loss. The workload still converges to the same wrong state.

### Threshold matrix: keyed records, 3 options, 3 vote rounds

Command:

```bash
env DENO_DIR=/private/tmp/deno-cache-a587 \
  deno run -A packages/patterns/tools/lunch-poll-diagnose.ts \
  --program=storage-shape-experiment.tsx \
  --cases=3x6,3x7,3x8,3x9,3x10 --rounds=3 --skip-refresh
```

| Users | Final Users | Final Votes | Conflicts | Baseline Conflicts | Exhaustions | Exhausted Handlers         |
| ----: | ----------: | ----------: | --------: | -----------------: | ----------: | -------------------------- |
|     6 |         6/6 |       18/18 |       185 |                872 |           0 | none                       |
|     7 |         7/7 |       18/21 |       264 |               1273 |           3 | `castVote` x3              |
|     8 |         7/8 |       18/24 |       342 |               1254 |           4 | `joinAs` x1, `castVote` x3 |
|     9 |         7/9 |       18/27 |       328 |               1323 |           5 | `joinAs` x2, `castVote` x3 |
|    10 |        7/10 |       18/30 |       362 |               1723 |           6 | `joinAs` x3, `castVote` x3 |

### Join-only matrix: keyed records, 3 options, 0 vote rounds

Command:

```bash
env DENO_DIR=/private/tmp/deno-cache-a587 \
  deno run -A packages/patterns/tools/lunch-poll-diagnose.ts \
  --program=storage-shape-experiment.tsx \
  --cases=3x6,3x7,3x8,3x9,3x10 --rounds=0 --skip-refresh
```

| Users | Final Users | Conflicts | Baseline Conflicts | Exhaustions |
| ----: | ----------: | --------: | -----------------: | ----------: |
|     6 |         6/6 |        50 |                327 |           0 |
|     7 |         7/7 |        75 |                476 |           0 |
|     8 |         7/8 |       105 |                603 |           1 |
|     9 |         7/9 |       164 |                715 |           2 |
|    10 |        7/10 |       227 |                999 |           3 |

Conclusion: keying the roster reduces join churn, but the join correctness
threshold is unchanged.

## Real Lunch Poll Child-Vote Refactor

The merge-relevant change is now in `packages/patterns/lunch-poll/main.tsx`, not
only in a diagnostic fixture.

What changed:

- `User` rows now optionally contain `votes?: UserVote[]`.
- `castVote` writes to `users.key(myUserIndex).key("votes")` instead of the
  global `votes` array.
- `resetVotes`, `clearMyVote`, and `removeOption` clear vote state from
  participant child cells.
- `votesForUsers(users)` projects the public `Vote[]` compatibility output.
- `ParticipantIdentityCard` stores the viewer's append-only participant index in
  PerUser state during join.

This keeps the existing UI and public `Vote.optionId` shape, so it is not the
final no-string-ID model. It specifically tests whether moving the hot vote
write path out of the aggregate `votes` array improves the real lunch poll.

### Real `main.tsx`, 3 options x 10 users x 3 vote rounds, serial setup

Commands:

```bash
deno run -A packages/patterns/tools/lunch-poll-diagnose.ts \
  --program=main.tsx \
  --cases=3x10 --rounds=3 --skip-refresh \
  --event-mode=id --join-mode=serial
```

Results from `/private/tmp/lunch-main-real-baseline.log` and
`/private/tmp/lunch-main-real-child-votes.log`:

| Shape                           | Elapsed | Final users | Final votes | Conflicts | Reverts | Vote round 3 max nodes | Vote round 3 max edges | Vote round 3 max workset | Vote round 3 trace |
| ------------------------------- | ------: | ----------: | ----------: | --------: | ------: | ---------------------: | ---------------------: | -----------------------: | -----------------: |
| Original `main.tsx` array votes |   36.0s |       10/10 |       18/30 |      1923 |    1923 |                    467 |                   1361 |                       24 |               1680 |
| Real `main.tsx` child votes     |   28.1s |       10/10 |       30/30 |      1309 |    1309 |                    479 |                   1380 |                       16 |                915 |

Result: the real lunch poll now preserves all expected votes in this workload.
It also cuts elapsed diagnostic time by about 1.28x, conflicts/reverts by about
1.47x, final vote-round scheduler workset by 1.5x, and final vote-round trace
entries by about 1.84x.

This does not prove that the full lunch-poll graph is fixed. The final graph is
slightly larger after the refactor because the real UI still renders and derives
through the same broad surfaces. The proof is narrower: removing the global
`votes` hot array fixes the durable vote loss in this scenario and reduces
runtime churn on the production pattern source.

## Reference-Addressed Pattern Experiment

The PR now includes an idiomatic fixture:

- File: `packages/patterns/lunch-poll/reference-shape-experiment.tsx`
- No generated `id`, `optionId`, or string-keyed mutation maps.
- Options are addressed by live option cell references.
- Each viewer's PerUser `viewer` state stores an append-only participant index,
  not a generated app ID. This is safe for the diagnostic fixture because
  participants are only appended during serial setup.
- Vote handlers write below that participant child cell rather than mutating a
  global `votes` array.
- Vote matching uses `equals(vote.option, option)`.

One rejected intermediate shape stored PerUser participant cells in a shared
PerSpace roster. That is not valid: a space-scoped read cannot follow a narrower
user-scoped link, so other clients see `undefined`. The working shape keeps
participant data in PerSpace and stores only the viewer's append-only roster
position in PerUser state.

Another attempted shape stored the viewer's live `ParticipantCell` directly in
PerUser state. With the current transformer/schema surface that either
materialized as a plain participant value, so writes did not reach the shared
`participants` array, or failed once `Participant` itself contained
`Vote.option: Cell<Option>`. The current reference fixture keeps the important
hot-path property, child-cell vote writes, without introducing string IDs.

The diagnostic harness was extended with:

- `--event-mode=reference`: send option `@link` values instead of `optionId`.
- `--join-mode=serial`: make setup deterministic so the measured contention is
  concurrent voting, not concurrent roster creation.
- `MultiRuntimeSession.linkValue(path)`: serialize a result cell via
  `getAsLink({ includeSchema: true })`.
- Field-by-field result reads when whole-result materialization is `undefined`
  for reference-heavy outputs.

### Fixture comparison, 3 options x 10 users x 3 vote rounds, serial setup

Commands:

```bash
deno run -A packages/patterns/tools/lunch-poll-diagnose.ts \
  --program=main.tsx \
  --cases=3x10 --rounds=3 --skip-refresh \
  --event-mode=id --join-mode=serial

deno run -A packages/patterns/tools/lunch-poll-diagnose.ts \
  --program=reference-shape-experiment.tsx \
  --cases=3x10 --rounds=3 --skip-refresh \
  --event-mode=reference --join-mode=serial
```

Earlier fixture results from `/private/tmp/lunch-main-3x10.json` and
`/private/tmp/lunch-ref-3x10.json`:

| Shape                 | Elapsed | Final Users | Final Votes | Conflicts | Reverts | Vote round 3 max nodes | Vote round 3 max edges | Vote round 3 max workset | Vote round 3 trace |
| --------------------- | ------: | ----------: | ----------: | --------: | ------: | ---------------------: | ---------------------: | -----------------------: | -----------------: |
| Current arrays        |   35.9s |       10/10 |       18/30 |      1797 |    1797 |                    466 |                   1350 |                       24 |               1645 |
| Reference child cells |    8.0s |       10/10 |       30/30 |       350 |     350 |                     80 |                    186 |                        4 |                152 |

Result: the reference fixture is useful mechanism evidence. With the same
runtime patch and deterministic setup, it preserves all expected votes, cuts
end-to-end diagnostic time by about 4.5x, cuts conflicts/reverts by about 5.1x,
and reduces the final vote-round scheduler workset by about 6.0x. It is not the
merge proof for lunch poll; the real `main.tsx` result above is.

This does not mean the runtime work is unnecessary. The reference fixture still
records conflict/revert churn, and the runtime change is still what lets
independent object-child writes avoid false conflicts when reads are
non-recursive. The evidence points to a joint fix: tighten runtime conflict
semantics and move lunch-poll away from global aggregate hot arrays.

### Keyed-record runtime implication

The warning payloads still show conflicts on the same root entity id, even when
the handler writes a keyed path:

- `joinAs` (`storage-shape-experiment.tsx:191`) still exhausts at 8+ users.
- `castVote` (`storage-shape-experiment.tsx:259`) still exhausts one vote per
  concurrent vote round at 7+ users.
- The transaction operation is a `patch` on the root record entity, and the
  conflict reports a stale confirmed read of that same root entity.

So this experiment weakens the idea that simply moving from arrays to keyed
objects/cells is sufficient under the current runtime semantics. It helps
performance/churn, but the current conflict detector/retry path still treats
these point writes as conflicting once the root record read is stale.

## Current Hypotheses

### H1: Hot shared arrays are over-conflicting under concurrent event handlers

Confidence: medium-high.

Evidence:

- `joinAs` reads all `users` and writes the shared users array.
- `castVote` reads all `votes` and writes the shared votes array.
- Exhausted handler IDs match those two handlers exactly.
- Join-only runs fail at 8+ users with `joinAs` exhaustions.
- 7-user vote-depth runs fail one `castVote` per concurrent vote round.
- The keyed-record experiment reduces conflicts by roughly 4-5x, so the pattern
  shape does affect churn.

Counter-evidence:

- The keyed-record experiment does not improve the correctness threshold.
- Point writes under one record root still exhaust retries.

### H2: Runtime retry behavior turns conflicts into silent durable drops

Confidence: high.

Evidence:

- Exhausted commits log in `scheduler/events.ts`.
- Event commits are intentionally async after speculative local apply.
- Harness sessions converge to the same wrong durable state, meaning the state
  loss is not just propagation lag.
- `send()`-style interaction does not surface the exhausted durability failure
  as a normal pattern-level failure.
- Keyed-record point writes still drop at the same threshold, which points to
  conflict/retry semantics beyond just non-idiomatic array scans.

### H2b: Current record/path writes are not commutative enough

Confidence: high after the keyed-record experiment.

Evidence:

- `record.key(k).set(v)` reduced conflict count but not durable correctness.
- Exhausted warnings still identify stale confirmed reads on the root record
  entity.
- The runtime reports patch operations on the root record id, not independent
  child-cell commits that can merge in any order.
- Engine conflict validation uses
  `validateConfirmedReads -> findConflictSeq -> patchOverlapsRead`.
  `patchOverlapsRead` asks whether any touched patch path prefix-overlaps the
  read path.
- For `add` and `remove`, `touchedPathsForPatch` returns both the leaf path and
  the parent path. That means adding `/value/usersByName/Alice` is treated as
  touching `/value/usersByName` as well as Alice's key.
- `pathsOverlap` is bidirectional prefix overlap, so the parent touch overlaps
  every sibling-key read under the same record.

Implication: an "array of links" or keyed-record shape will only fix correctness
if each concurrent mutation can avoid a stale read dependency on a shared root,
or if the runtime can merge independent path patches under the same root after a
stale root read.

### H2c: Distinct object-key inserts currently conflict through the parent path

Confidence: high.

Engine-only probe:

- Seeded `entity:poll` with `{ value: { usersByName: {} } }`.
- Session A read missing `/value/usersByName/Alice` at seq 1 and patched
  `add /value/usersByName/Alice`; this committed at seq 2.
- Session B had independently read missing `/value/usersByName/Bob` at seq 1 and
  patched `add /value/usersByName/Bob`; this was rejected with
  `stale confirmed read: entity:poll at seq 1 conflicted with seq 2`.
- Repeating the same two sibling `add` patches with no confirmed reads allowed
  both commits. This isolates the failure to stale-read validation, not a
  write-write inability to replay the patches.

Runner storage probe:

- A missing-child read through `readValueOrThrow` is recorded narrowly:
  `["value", "usersByName", "Bob"]`.
- `replica.buildReads(...)` preserves that exact confirmed read path.
- So the false dependency is not introduced by transaction read compaction or a
  pattern-level root snapshot for the keyed-record case. The widening occurs
  when the engine validates an intervening sibling `add` using the parent path.

Spec/history:

- `docs/specs/memory-v2/03-commit-model.md` says path-aware validation should
  not reject unrelated paths on the same entity, but also says structural
  collection edits may be treated conservatively as overlapping the whole
  collection subtree and that implementations may over-approximate overlap.
- The March path-aware conflict test only covers sibling `replace` writes. It
  does not cover stale reads of distinct missing sibling keys followed by `add`.
- Commit `038b36e176` fixed the same parent-path sibling-overlap problem for
  persisted scheduler dirtying by switching scheduler write extraction to
  leaf-only paths. Its message explicitly left `patchOverlapsRead` untouched.

Interpretation:

- This is now more runtime/spec than pattern authorship. The array version is
  non-idiomatic for high-contention writes and creates excessive churn, but the
  keyed-record version exercises a reasonable CRDT-like expectation: two users
  inserting different object keys should commute.
- The current spec permits the runtime to reject that case. For lunch-poll and
  similar cross-user state, that permissive over-approximation becomes a
  correctness problem because bounded retries eventually drop accepted user
  actions.
- A true child-cell/link design should avoid this specific conflict only if the
  hot path writes independent child-cell entities and does not also mutate a
  shared directory/root during the same concurrent phase.

### H3: Render graph/read-site churn is a secondary performance issue

Confidence: medium-high.

Evidence:

- Graph sizes are relatively flat from 6 to 10 users in the failing matrix.
- Top read sites are stable and dominated by sink/result and option cards.
- The dropped-work threshold is better predicted by handler conflict exhaustion
  than by graph size.

This does not mean graph churn is harmless. It likely still affects perceived
latency and responsiveness, especially with more options or homepage refreshes.

### H4: Homepage enrichment is not the primary dropped-write cause in these runs

Confidence: high for the measured cases.

Evidence:

- All main diagnostic runs above used `--skip-refresh`.
- `main.tsx:1055:54` still appears as a read site, but homepage refresh/network
  work was not part of the dropped-write reproduction.

## Ruled Out or Weakened

- `CF_CONFLICT_ADMISSION=hold` as a mitigation for this workload: weakened. It
  preserved the same wrong durable state and increased conflict churn.
- Browser-only automation as the main stress driver: weakened. It is useful for
  telemetry inspection but less reliable for custom input interaction than the
  multi-runtime harness.
- Pure graph explosion as the primary correctness bug: weakened. Graph/read
  churn exists, but the durable loss tracks exhausted event commits.

## Working Theory

Lunch poll currently mixes pattern-level hot shared array writes with runtime
speculative event commit/retry semantics. The pattern authorship shape causes
many concurrent handlers to read and then rewrite the same logical aggregate.
The runtime handles some conflicts with retries, but above the workload
threshold it exhausts the retry budget. Because event commits are speculative
and asynchronous, the user-facing action can appear accepted even when
durability later fails.

The keyed-record experiment refines this: the pattern shape is not irrelevant,
because narrower writes cut conflict churn sharply. But the current runtime/API
does not make independent keyed writes commutative enough to preserve
correctness. Distinct object-key inserts still conflict because `add` is treated
as touching the shared parent record path.

The result is not random divergence. Clients eventually converge to the same
wrong state.

## Next Best Experiments Before Editing

1. Add a focused characterization/regression test for object sibling adds: stale
   read of missing key B should not be invalidated by add of key A if the parent
   container is a plain object. Keep array insert/remove semantics separate
   because array index shifts are a real overlap hazard.
2. Test a true child-cell/link variant where the hot mutation writes a separate
   cell per user/vote and does not write the shared link array during the hot
   path. If the link directory still needs mutation, preseed or create it
   serially so the concurrent phase only writes child cells.
3. Add a diagnostic mode or temporary script that compares concurrent vs
   serialized `castVote` after the same 7-user join. This would isolate whether
   the loss is exclusively concurrency-driven.
4. Run one larger-option case with low users, for example `10x5`, to separate
   option-card/read graph costs from write contention.
5. Run one homepage-refresh case after correctness investigation, because
   homepage enrichment is a separate cost center and should not be conflated
   with the dropped-write path.

## Candidate Fix Direction

The keyed-record variant is a useful performance direction but is not a complete
correctness fix by itself. The most evidence-supported next edit would need one
of these runtime/API properties:

- Type-aware object `add`/`remove` conflict validation that does not treat
  unrelated sibling-key reads as stale, while preserving conservative behavior
  for array index edits.
- True independent child-cell writes for each user/vote, with no shared
  directory mutation during the concurrent hot path.
- A true append/insert operation whose transaction does not depend on a stale
  aggregate snapshot.
- Runtime merging for independent path patches under the same root entity.

Pattern-side changes still matter:

- Avoid whole-array scans in hot handlers where a live reference or child cell
  can address the item directly.
- Preserve array-shaped outputs for UI compatibility by deriving arrays from
  reference-addressed or linked storage.
- Make event handlers idempotent so retries are safe.

Success criteria for the first edit should be:

- `3x10 --rounds=3 --skip-refresh` converges to `10` users and `30` votes.
- Exhausted event commits are `0`.
- Conflict churn drops materially or at least no longer causes durable loss.
- Existing 2-user integration behavior still passes.

## Runtime Experiment: Shallow Reads + Object-Key Adds

After the keyed-record variant still failed, a subagent tried the first
engine-only half of the theory:

- Preserve object-sibling independence in memory-v2 conflict validation: adding
  `/value/usersByName/Alice` should not invalidate a stale exact read of
  `/value/usersByName/Bob`.
- Keep array adds conservative because array indices shift.

Engine tests passed, but the keyed lunch-poll workload did not improve:

- `3x10 --rounds=3 --skip-refresh` on `storage-shape-experiment.tsx` still
  converged to `7/10` users and `18/30` votes.
- Conflict churn was still high (`405` conflicts in that intermediate run).

The next probe instrumented rejected `joinAs` commits and found the missing
piece:

- Rejected commits still contained a confirmed read of
  `["value", "usersByName"]`.
- A targeted `buildReads` log showed that almost all of those parent reads were
  `nonRecursive: true`.
- `SpaceReplica.buildReads()` was compacting shallow reads and then explicitly
  stripping `nonRecursive` before sending the memory-v2 `ClientCommit`.
- That turned "this parent path only" topology/schema reads into recursive
  subtree preconditions at the server.

The successful runtime experiment is therefore two-part:

1. Keep object-key `add`/`remove` overlap type-aware in the memory engine:
   unrelated object sibling keys do not conflict, arrays remain conservative.
2. Preserve `nonRecursive` through `ClientCommit` and make engine validation
   treat shallow reads as exact/ancestor-only, not descendant-recursive.

Result:

```bash
deno run -A packages/patterns/tools/lunch-poll-diagnose.ts \
  --program=storage-shape-experiment.tsx \
  --cases=3x10 --rounds=3 --skip-refresh
```

- Convergence: `users=[10,10,10,10,10,10,10,10,10,10]`.
- Convergence: `votes=[30,30,30,30,30,30,30,30,30,30]`.
- Churn: `conflicts=243`, `reverts=243`, `rejected=0`.
- This is the first measured run where the 10-user keyed workload preserves all
  joins and all votes.

Control run against the original array-backed `main.tsx` after the same runtime
fix:

```bash
deno run -A packages/patterns/tools/lunch-poll-diagnose.ts \
  --cases=3x10 --rounds=3 --skip-refresh
```

- Convergence remained wrong: `users=[7,...]`, `votes=[18,...]`.
- Churn remained much higher: `conflicts=1517`, `reverts=1517`.

So this is not a free runtime-only fix for the current pattern. The current
array-backed handlers still read/write hot aggregate arrays. The runtime fix
makes the diagnostic keyed storage shape work as intended by preserving
independent object-key mutations and shallow topology reads, but that exact
diagnostic shape is not the desired production pattern API because it is
string-keyed.

## Local Browser Deployment Checkpoint

Deployed local URL:

```text
http://localhost:9000/lunch-poll-perf-a587/lunch-poll-reference-runtime-a587
```

Piece:

```text
fid1:KMMXckIrcnJr7P8JdJWTe6nGkfZzPvo-G0pJJzwhO6s
```

Current deployment target:

- The URL should now be sourced from `packages/patterns/lunch-poll/main.tsx`,
  not the stripped reference fixture.
- The browser check is for real UI smoke testing and event-path confidence.
- The performance/correctness proof comes from the multi-runtime diagnostic
  harness, which drives the same handler workload across 10 clients.

Interpretation:

- The pattern's original array shape is still non-idiomatic for high-contention
  multi-user writes.
- The real pattern now stores live votes below participant child cells and
  preserves all expected votes in the 3x10x3 diagnostic workload.
- The keyed-record diagnostic shape showed the runtime issue, but it is not a
  production target because it relies on synthetic string keys.
- A future production shape should move option identity toward live references,
  and it only works efficiently if the runtime preserves the difference between
  recursive content reads and shallow topology reads.
- The bug was emergent: pattern contention exposed a runtime/protocol gap where
  the runner had precise shallow-read information and the memory engine had
  path-aware validation, but the protocol boundary erased the shallow-read bit.

## Checkpoint

Current understanding:

- The original array-backed `main.tsx` correctness failure is reproducible.
- The branch's real `main.tsx` child-vote refactor preserves `30/30` votes in
  the measured 3x10x3 serial-join workload.
- In the original scaling runs, 6 users is correct but conflict-heavy, 7 users
  loses one vote per concurrent vote round, and 8+ users starts losing joins.
- `hold` mode does not mitigate.
- Keyed-record storage cuts conflict churn substantially but leaves the same
  correctness threshold.
- Engine and runner probes show distinct object-key inserts conflict through
  `add`'s parent-path footprint, even when transaction reads stay at exact
  sibling-key paths.
- The current memory-v2 spec allows this conservative behavior and does not
  document shallow commit reads; lunch-poll is evidence that the spec is too
  loose for cross-user insert-heavy state.
- Preserving `nonRecursive` through `ClientCommit` plus type-aware object-add
  validation makes the diagnostic keyed 10-user workload preserve all joins and
  votes.
- Browser telemetry is wired up, but CLI multi-runtime diagnostics are still the
  most reliable stress driver.

Most likely next step:

- Keep the focused runtime tests, update the memory-v2 spec for shallow reads,
  browser-smoke the real `main.tsx` deployment, and decide whether the remaining
  option identity cleanup belongs in this PR or a follow-up.
