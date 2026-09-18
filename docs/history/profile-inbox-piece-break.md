---
status: historical
created: 2026-09-18
archived: 2026-09-18
reason: "Record of the deliberate contract break taken when the profile's share inbox pointer gained the inbox piece's id, which the pattern-update gate reads as an unaccepted alternative beneath profile-picker's union-typed defaultProfile argument."
---

# Profile: the share inbox pointer names the inbox piece

`system/profile-home.tsx`'s `ProfileInboxPointer` gained an optional `piece`:
the id of the inbox piece inside the inbox space, in the bare spelling the CLI
takes (`baedreia…`, without the `of:` prefix a link carries). `setInbox`
accepts the same field, trims it, drops a leading `of:`, stores it beside
`space` and `host` when the pointer is whole, and leaves a pointer written
without one as `{ space, host }`.

## Why the pointer names the piece

Measured on a live install, an inbox space can hold several `Share inbox`
pieces — every re-mint adds one — and a sender that discovers the piece by
listing the space picks an arbitrary one, so an offer can land in a piece the
owner's reader never reads. Berni, 2026-09-18: "pointing to the piece instead
of the space seems right — such a link is effectively redundant since it
contains the space and the host (if it differs from where the link is written
to)".

## Why a plain id beside the space, and not a link

The shape Berni named is a link to the inbox piece — space and piece id
together, the `link@1` sigil the profile already mints for its elements —
plus the host. Measured against the gate, that shape fails `system/home.tsx`
at `result.defaultProfile` on all five of its recorded baselines (`a schema
alternative accepted previously is not accepted by the candidate`), and on
`system/profile-home.tsx` at `result.inbox.space: existing result field was
removed`. Home is a required pattern: `pattern-break-registry-guards.ts`
refuses any accepted break naming one, because the auto-updating roots would
strand every space's root the moment the break merged, and that guard is not
one this change relaxes.

Berni allowed an incompatible update for the profile itself, 2026-09-18: "you
can make that an allowed incompatible pattern update if you need to since
other than Gideon no one will have that version of setInbox." The allowance
does not reach home, so the id rides beside the two existing fields as an
optional string, which home and the profile carry compatibly. The link shape
waits on a gate decision about the home contract; the type's doc comment and
the shared-profile spec both record it as the shape this one stands in for.

## What the proof reports

`system/profile-picker.tsx` takes a stored profile as `defaultProfile:
BackwardsCompatibleProfile | undefined`. Against both of its recorded
baselines the proof reports `argument.defaultProfile: a schema alternative
accepted previously is not accepted by the candidate`. The argument is a
union, and `schemaConjunctionSubsetIssue` proves the alternatives of a union
with `allowEvolutionPolicy: false`, so the evolution policy that admits a new
optional property at home's `result.defaultProfile` does not apply beneath
the picker's alternative, and the same addition is refused there.

## What the break costs

Nothing deployed holds state under the old shape that the new one refuses: a
stored profile without `piece` validates against the candidate (the property
is optional), and a picker reading such a profile sees `piece` as absent. The
entry in `tasks/pattern-compat-accepted-breaks.ts` forgives exactly the two
`(system/profile-picker.tsx, baseline)` pairs on the one path the proof
names, disjoint from the pairs the pointer's first break forgave, and the
contract recorded once this ships is a new baseline no entry names.
