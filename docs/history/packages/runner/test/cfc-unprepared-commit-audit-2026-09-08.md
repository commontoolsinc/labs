---
status: historical
created: 2026-09-08
archived: 2026-09-08
reason: "Audit snapshot of the `packages/runner` unit tests that commit a CFC-relevant transaction without preparing it."
---

# Tests that commit a CFC-relevant transaction unprepared

The CFC commit boundary in
`packages/runner/src/storage/extended-storage-transaction.ts` refuses a
transaction CFC holds relevant that reaches commit without having been
prepared. Search for `relevant transaction was not prepared` to find the arm.
It has two shapes. A prepare whose status is `invalidated` carries the reasons
prepare recorded, and where every reason is a verdict the rejection is a
terminal `CfcCommitRefusalError`. A prepare that never ran carries no reasons at
all, so `isTerminalRefusal([])` is false and the rejection takes the retryable
`StorageTransactionAborted` name with no detail.

No runtime commit path produces the second shape. `Runtime.prepareTxForCommit`
calls `tx.prepareCfc()` on any transaction CFC holds relevant, and
`editWithRetry`, the scheduler, the runner, `ensure-piece-running`, the builtins
and the integration harnesses all call it before committing. Tests produce it.

## Method

A `console.error` in the `!isTerminalRefusal(reasons)` branch printing
`this.#cfcState.prepare.status` and a stack trace, then `deno task test` from
`packages/runner`. At labs `42e5154c51` that recorded 43 commits reaching the
arm with status `unprepared` and no reasons, across 17 files. Every stack frame
was `ExtendedStorageTransaction.commit` called from test code.

Each candidate was then held to a mutation: break the gate the case names while
leaving the relevance mark in place, and see whether the case still passes. A
case that already fails under that mutation is reading its gate.

## What the 43 were

| Site | Class |
| --- | --- |
| `cfc-privileged-system-write.test.ts` — root envelope erasure (×3, one looping over 3 shapes) | weak, fixed |
| `cfc-grant-records.test.ts` — unprivileged write to a grant document | weak, fixed |
| `content-addressed-identity-adversarial.test.ts` — "defense is not vacuous" | weak, fixed |
| `profile-owner-cfc.test.ts` — profiles-list truncation seed | seed discarded, fixed |
| `scheduler-pull-handlers.test.ts` — dependency-discovery seed | seed discarded, fixed |
| `oncommit-race.test.ts` — scheduler-prepare seed | seed discarded, fixed |
| `cfc-boundary.test.ts` ×2, `cfc-flow-probe-memo.test.ts` ×1 | named for this refusal already |
| `cfc-boundary.test.ts` outbox, `cell-callbacks.test.ts`, `generate-object-outbox.test.ts` ×2, `navigate-handler.test.ts`, `stream-data-outbox.test.ts` | refusal arranged on purpose |
| `link-ifc-read-relevance.test.ts` ×16, `cfc-label-introspection-channel.test.ts` ×3, `cfc-template-metadata-population.test.ts` ×3, `schema-links.test.ts`, `sqlite-read-labeling.test.ts` | teardown; nothing reads the result |

## The mutations, and what they showed

Deleting the loop in `prepareBoundaryCommit` that turns each recorded
unprivileged system write into a `verdictReason`, while leaving the recording at
the write chokepoint alone, left four cases green: three in
`cfc-privileged-system-write.test.ts` and one in `cfc-grant-records.test.ts`.
The three cases in those files that already prepared failed under it, which is
what says the mutation bites.

Deleting the whole reason is the strong form of that mutation. The weak form —
leaving the reason recorded and dropping only its `verdictReason(...)` wrapper —
was, until these cases read the rejection's name, caught by
`edit-with-retry-classification.test.ts` alone. An untagged reason is not a
terminal refusal, so the rejection arrives as `StorageTransactionAborted`, and
the four gate cases now fail on that too.

Forcing the `writeAuthorizedBy` identity arm never to match left all three
acceptance cases in `content-addressed-identity-adversarial.test.ts` green. Two
of the three could not fail for a second reason as well: they asserted through
`String(result.error)`, and a commit rejection is a plain object whose string
form is `[object Object]` whatever went wrong.

Deleting the seed outright left `profile-owner-cfc.test.ts`'s truncation case,
`scheduler-pull-handlers.test.ts`'s discovery case and `oncommit-race.test.ts`'s
scheduler-prepare case green. In each the seed's commit was refused, so the case
ran against an empty document. The truncation case was therefore not emptying a
list that held anything.

`oncommit-race.test.ts`'s case reads its gate: it fails when the event commit
path stops calling `prepareTxForCommit`. `scheduler-pull-handlers.test.ts`'s
did not — `handlerRuns` is insensitive to whether discovery was gated — so it
gained an assertion that the transaction `populateDependencies` receives is
held read-only, which is what keeps a labeled read out of CFC gating; it now
fails when the scheduler stops marking it.

## What the audit turned up outside the tests

Preparing one of the three malformed envelopes in
`cfc-privileged-system-write.test.ts`'s "reader reports as absent" case does not
reach the S18 gate. A record at the reserved position carrying no `version` is
absent to `cfcMetadataPresent()` and unreadable to the prepare pass's
`storedMetadataFor()`, and the second reader's throw replaces every reason the
pass had collected, the S18 verdict among them, so the commit is refused as
`CommitPreparationError`. That name is in neither `TERMINAL_REJECTION_NAMES` nor
`isRetryableCommitRejection`, so `Runtime.editWithRetry` does not retry it while
the scheduler's action path spends its bounded retry budget on it — where the
verdict would have stopped at the first attempt. That shape moved to a case of
its own, which states what it takes.

## What was left alone

The five cases that arrange a refusal on purpose go through one helper, which
raises a transaction below `enforce-explicit` to it, since that is the lowest
rung at which the refusal exists. They pass at all four rungs rather than at
whichever the fleet default resolves to.

Twenty-four of the 43 are commits in an `afterEach`, or trailing a case's
assertions, whose result nothing reads. They assert nothing, so no gate is
mis-measured; the writes they stage were never wanted durable. Three more are
cases named for the arrival-unprepared refusal, which is their subject rather
than their setup, and they read its message.
