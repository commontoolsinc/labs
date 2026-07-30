---
status: historical
created: 2026-07-30
archived: 2026-07-30
reason: "Investigation record: why the open-argument update class went unvalidated, and the correction of an earlier measurement that pointed at the wrong mechanism."
superseded-by: plans/pattern-update-state-continuity.md
---

# Open-argument update validation: what was actually broken

A record of one investigation, kept because its conclusion reversed a
measurement this repository had already written down as fact. The behaviour it
describes has since changed; read
[`docs/plans/pattern-update-state-continuity.md`](../../plans/pattern-update-state-continuity.md)
for the current system.

## The gap

`packages/piece/src/schema-compatibility.ts` waives one pattern-evolution class:
over an OPEN argument object (`additionalProperties: true`) a candidate may
declare a brand-new optional field of any type. The waiver's soundness rested
entirely on the runner validating the piece's stored argument against the new
schema inside the setup transaction.

Measured on the production repair path, it did not. A vintage storing
`{count: "seven"}` legally under an open object, updated to a version declaring
`count?: number`, landed with no refusal: the bytes survived on disk and nothing
reading through the new contract could see them.

## The earlier conclusion, and why it was wrong

The plan recorded that the miss took TWO gates, and that the second one was the
hard part:

> forcing that gate open with `reapplyStoredSetup: true` still yields no
> refusal. A pattern swap supplies no argument, so the re-stage passes
> `{ unresolvedLinkRaw }` and validates link-bearing slots as opaque.

It advised whoever picked the work up to start at that leniency rather than at
`sameStoredSetup`. That advice was backwards.

Re-measured: `overlayUnresolvedLinkPlaceholders` substitutes the opaque
placeholder **only** where the RAW value at a slot is a cell link that
materialized to nothing. A plain wrong-typed value is never replaced, so
`{count: "seven"}` reached `validateSchemaValue` and was rejected. The hot-swap
route had been refusing that exact pair the whole time — under both write shapes
(argument supplied at `run()`, and argument written through the root's
`argument` meta the way a vintage capture does). The leniency already drew the
line the fix was supposed to draw, and needed no change.

The whole miss was the first gate: `applySetupState` skipped the argument
re-stage whenever the pattern POINTER already named the pattern being set up,
and every repair path produces exactly that state because it commits the
candidate's identity before calling setup.

## Why the wrong conclusion was reachable

`reapplyStoredSetup` is not plumbed through `runSynced` — it reaches setup only
via `runtime.setup`. An attempt to force the first gate open by adding that
option to the `runSynced` call would be silently dropped rather than applied,
leaving the first gate shut and the second one wrongly blamed for the miss. The
measurement that mattered was the one nobody ran: drive the hot-swap route,
which passes `sameStoredSetup = false` unconditionally, and observe that it
already refuses.

## The lesson worth keeping

A recorded measurement is evidence about the run that produced it, not about the
mechanism it names. This one had a plausible mechanism attached to a real
observation, and the attachment was wrong. Re-running the measurement cost
minutes; designing around the stated mechanism would have meant weakening a
deferral (CT-1917) that exists to keep not-yet-synced nested arguments from
failing every update.
