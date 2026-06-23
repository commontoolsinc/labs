# Lunch Poll Multi-User Performance Handover

Owner handoff target: Bernie

## Summary

Lunch poll is dropping accepted-looking user actions under concurrent multi-user
load. The root cause is not just "the pattern is slow" and not just "the runtime
is wrong"; it is the interaction between a high-contention pattern shape and a
runtime/protocol gap.

The current lunch-poll pattern stores hot shared state in arrays:

- `users: User[]`
- `votes: Vote[]`

Handlers read the aggregate array and then write it back. Under 10 users and
serial setup, concurrent voting still loses durable votes after the runtime
patch:

- `main.tsx --cases=3x10 --rounds=3 --skip-refresh --join-mode=serial`
- Result: `10/10` users, `18/30` votes
- Churn: `1797` conflicts/reverts
- Elapsed diagnostic time: `35.9s`

The PR now includes an idiomatic reference-addressed fixture:

- `packages/patterns/lunch-poll/reference-shape-experiment.tsx`
- No string IDs, generated IDs, `optionId`, or string-keyed mutation maps.
- Option identity is the option cell.
- Participant identity is the participant element cell in the shared PerSpace
  `participants` array.
- PerUser viewer state stores a live link to that participant element.
- Vote writes go under the participant child cell, not a global `votes` array.
- Matching uses `equals()`.

With the same 3x10x3 workload and serial setup:

- Result: `10/10` users, `30/30` votes
- Churn: `281` conflicts/reverts
- Elapsed diagnostic time: `7.5s`
- Final vote-round max workset: `5` versus `24` in current arrays

So this PR is no longer just a runtime speculation. It demonstrates that an
idiomatic reference shape plus the runtime patch materially improves both
correctness and performance.

## Local Validation URL

Local patched runtime and diagnostic piece:

```text
http://localhost:9000/lunch-poll-perf-a587/lunch-poll-reference-runtime-a587
```

Current deployed piece:

```text
fid1:KMMXckIrcnJr7P8JdJWTe6nGkfZzPvo-G0pJJzwhO6s
```

Deployment source:

```text
packages/patterns/lunch-poll/reference-shape-experiment.tsx
```

Browser status: the fresh reference URL renders the header,
`0 joined | 0
options | 0 votes`, name input, join button, restaurant input, and
add button. In-app browser automation and
`cf piece call joinAs '{"name":"Alex"}'` did not mutate durable state, while the
multi-runtime harness does drive the same handlers successfully. Treat the
deployed URL as a render/manual-inspection surface; the measured performance
evidence below comes from the headless multi-runtime harness.

## Evidence

Successful reference fixture with runtime patch:

```bash
deno run -A packages/patterns/tools/lunch-poll-diagnose.ts \
  --program=reference-shape-experiment.tsx \
  --cases=3x10 --rounds=3 --skip-refresh \
  --event-mode=reference --join-mode=serial
```

Result:

- users: `10/10`
- votes: `30/30`
- conflicts/reverts: `281`
- elapsed: `7.5s`
- vote round 3 max nodes/edges: `77/145`
- vote round 3 max workset: `5`
- rejected commits: `0`

Control against current array-backed `main.tsx` with the same runtime patch and
same serial setup:

```bash
deno run -A packages/patterns/tools/lunch-poll-diagnose.ts \
  --program=main.tsx \
  --cases=3x10 --rounds=3 --skip-refresh \
  --event-mode=id --join-mode=serial
```

Result:

- users: `10/10`
- votes: `18/30`
- conflicts/reverts: `1797`
- elapsed: `35.9s`
- vote round 3 max nodes/edges: `466/1350`
- vote round 3 max workset: `24`

So the fix is not runtime-only. The pattern must stop using aggregate arrays as
the hot write path. The reference fixture shows how to do that without
contradicting Common Fabric's no-string-ID guidance.

## Runtime Finding

The runner records some reads as `nonRecursive: true`. Those reads mean "the
container/path itself matters, not all descendants." That is appropriate for
topology/schema/link-probe style reads.

Before this patch, `SpaceReplica.buildReads()` compacted reads and then stripped
`nonRecursive` before sending `ClientCommit` to memory-v2. This widened shallow
parent reads such as `value/usersByName` into recursive subtree preconditions.

That caused independent keyed object writes to conflict:

```text
read value/usersByName as topology
write value/usersByName/User%208
```

The runner knew this was shallow; the server did not.

## Proposed Runtime Change

1. Add `nonRecursive?: boolean` to memory-v2 `ConfirmedRead` and `PendingRead`.
2. Preserve `nonRecursive` through `SpaceReplica.buildReads()`.
3. Validate non-recursive reads as path/ancestor-only:
   - writes to the read path conflict
   - writes to ancestors conflict
   - writes to descendants do not conflict
4. Make object-key `add`/`remove` validation type-aware:
   - unrelated object sibling keys do not conflict
   - arrays remain conservative because insertion/removal shifts indices

Relevant files:

- `packages/runner/src/storage/v2.ts`
- `packages/memory/v2.ts`
- `packages/memory/v2/engine.ts`
- `docs/specs/memory-v2/03-commit-model.md`
- `docs/specs/memory-v2/04-protocol.md`

## Proposed Pattern Direction

Do not promote the old keyed-record diagnostic shape into lunch-poll proper. It
helped isolate the runtime issue, but it relied on synthetic string keys and has
been removed from the PR.

The product refactor should keep the same performance goal while following the
documented identity model:

- Store live cell references or child cells for participants/options/votes, not
  generated `id` fields.
- Keep participant cells in PerSpace if every viewer must read them. A rejected
  PerSpace roster of PerUser participant links failed because space-scoped reads
  cannot follow narrower user-scoped links.
- Let PerUser viewer state point to the viewer's PerSpace participant element.
- Pass option references through handlers and compare with `equals()` where
  lookup is necessary.
- Keep each user's vote state off the global aggregate hot path by writing below
  that participant cell and linking to the option cell.
- Keep output `users: readonly User[]` and `votes: readonly Vote[]` views only
  as derived compatibility surfaces for existing consumers/harnesses.
- Preserve existing UI contracts where possible so subcomponents do not need a
  broad rewrite.

## Risks

- `nonRecursive` must be treated as a protocol-level semantic, not just a runner
  optimization. Hosted clients and servers need to roll forward together.
- Object add/remove independence should not be generalized to arrays.
- Existing deployed lunch-poll state uses arrays. A production migration needs a
  compatibility/migration plan if we update an existing piece in place.
- The local keyed-record diagnostic used string-addressed object keys. That
  source has been removed from the PR because it violates the documented Common
  Fabric identity model.
- Browser auth/manual multi-tab verification is still needed before promoting
  the pattern change. The local URL now renders, but automated clicks have not
  yet confirmed the browser event path mutates durable state.

## Recommended Next Steps

1. Manually open the local URL and verify the reference poll can be joined/voted
   in normal browser tabs. This should be a browser event/durability check.
2. Run a two-browser/two-identity smoke test if practical, after at least one
   manual click confirms the UI event path is live.
3. Promote the runtime patch with the focused engine and runner tests.
4. Convert `packages/patterns/lunch-poll/main.tsx` to a live-reference / child
   cell storage shape, using `reference-shape-experiment.tsx` as the starting
   point for the data model rather than the removed string-keyed diagnostic.
5. Decide whether production lunch-poll should be a fresh piece or an in-place
   migration from array fields to the new reference-addressed model.
