# Lunch Poll Multi-User Performance Handover

Owner handoff target: Bernie

## Summary

Lunch poll is dropping accepted-looking user actions under concurrent multi-user
load. The root cause is not just "the pattern is slow" and not just "the runtime
is wrong"; it is the interaction between a high-contention pattern shape and a
runtime/protocol gap.

The PR now changes the real lunch poll, `packages/patterns/lunch-poll/main.tsx`:

- Live votes are stored under each participant row, `users[n].votes`, instead of
  a global hot `votes` array.
- The public `votes` output is still projected for compatibility.
- Each browser keeps a PerUser append-only participant index, so a vote handler
  can write directly to the current viewer's participant child cell.
- The existing `Option.id` / `Vote.optionId` contract remains. This refactor
  improves the real hot write path, but it does not solve that older identity
  idiom debt.

Measured against the same 3 options x 10 users x 3 vote rounds workload with
serial join setup:

| Shape                           | Final users | Final votes | Conflicts/reverts | Elapsed |     Vote round 3 graph | Workset | Trace |
| ------------------------------- | ----------: | ----------: | ----------------: | ------: | ---------------------: | ------: | ----: |
| Original `main.tsx` array votes |       10/10 |       18/30 |              1923 |   36.0s | 467 nodes / 1361 edges |      24 |  1680 |
| Real `main.tsx` child votes     |       10/10 |       30/30 |              1309 |   28.1s | 479 nodes / 1380 edges |      16 |   915 |

That is the merge-relevant evidence: the real lunch poll now preserves all 30
expected votes in this workload and cuts conflict churn and scheduler work. It
does not collapse the render graph, so this is not the dramatic result from the
smaller fixture.

The PR also keeps `reference-shape-experiment.tsx` as supporting mechanism
evidence. That fixture demonstrates the lower bound when option identity is a
live reference and vote writes go under participant child cells:

- `10/10` users, `30/30` votes
- `350` conflicts/reverts
- `8.0s` elapsed diagnostic time
- Final vote-round max workset `4`

Treat that fixture as a model for future idiomatic cleanup, not as the primary
proof that the real product improved.

## Local Validation URL

Local patched runtime and real lunch poll piece:

```text
http://localhost:9000/lunch-poll-perf-a587/lunch-poll-reference-runtime-a587
```

Current deployed piece:

```text
fid1:KMMXckIrcnJr7P8JdJWTe6nGkfZzPvo-G0pJJzwhO6s
```

Deployment source:

```text
packages/patterns/lunch-poll/main.tsx
```

Browser status: this URL should render the full lunch-poll UI from `main.tsx`,
not the stripped diagnostic fixture. The measured performance evidence below
comes from the headless multi-runtime harness, which is the reliable stress
driver for this workload.

## Evidence

Successful real `main.tsx` child-vote run with runtime patch:

```bash
deno run -A packages/patterns/tools/lunch-poll-diagnose.ts \
  --program=main.tsx \
  --cases=3x10 --rounds=3 --skip-refresh \
  --event-mode=id --join-mode=serial
```

Result:

- users: `10/10`
- votes: `30/30`
- conflicts/reverts: `1309`
- elapsed: `28.1s`
- vote round 3 max nodes/edges: `479/1380`
- vote round 3 max workset: `16`
- vote round 3 trace entries: `915`
- rejected commits: `0`

Control against the original array-backed `main.tsx` with the same runtime patch
and same serial setup:

```bash
deno run -A packages/patterns/tools/lunch-poll-diagnose.ts \
  --program=main.tsx \
  --cases=3x10 --rounds=3 --skip-refresh \
  --event-mode=id --join-mode=serial
```

Result:

- users: `10/10`
- votes: `18/30`
- conflicts/reverts: `1923`
- elapsed: `36.0s`
- vote round 3 max nodes/edges: `467/1361`
- vote round 3 max workset: `24`
- vote round 3 trace entries: `1680`

So the fix is not runtime-only. The real pattern had to stop using the global
`votes` array as the hot write path. The remaining graph size shows that the
real UI still has substantial reactive read cost, but the vote correctness and
contention improvements are measured on the production pattern source.

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

This PR implements the first production slice of the storage-shape change by
moving live votes under participant rows while keeping the existing output
contract. The longer-term product refactor should keep pushing toward the
documented identity model:

- Prefer live cell references or child cells for participants/options/votes over
  generated `id` fields where the product contract allows it.
- Keep participant cells in PerSpace if every viewer must read them. A rejected
  PerSpace roster of PerUser participant links failed because space-scoped reads
  cannot follow narrower user-scoped links.
- Use a PerUser pointer to the viewer's PerSpace participant element. The real
  pattern currently uses an append-only participant index because it keeps the
  deployed UI and schema surface stable.
- In the next cleanup, pass option references through handlers and compare with
  `equals()` where lookup is necessary.
- Keep each user's vote state off the global aggregate hot path by writing below
  that participant cell.
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
- The real pattern still exposes `optionId` in the public contract. This PR
  improves the hot vote path without finishing the no-string-ID cleanup.
- Browser manual multi-tab verification is still needed before promoting the
  pattern change. The local URL now points at the real UI; the multi-runtime
  harness is the durability proof.

## Recommended Next Steps

1. Manually open the local URL and verify the real poll can be joined/voted in
   normal browser tabs after refreshing the redeployed source. This should be a
   browser event/durability check, not the main performance proof.
2. Run a two-browser/two-identity smoke test if practical, after at least one
   manual click confirms the UI event path is live.
3. Promote the runtime patch with the focused engine and runner tests.
4. Decide whether this PR's real-pattern improvement is enough to merge, or
   whether the option identity cleanup must land in the same PR.
5. Decide whether existing deployed lunch-poll pieces need an in-place migration
   for old array-backed vote state.
