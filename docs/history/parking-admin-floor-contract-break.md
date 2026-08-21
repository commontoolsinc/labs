---
status: historical
created: 2026-08-20
archived: 2026-08-20
reason: "Decision record for the parking-coordinator admin-roster contract break: why correcting an unsatisfiable integrity floor could not avoid changing the `ifc` at the roster's path, and what happens to pieces holding a roster."
---

# Parking coordinator admin-roster contract break (#6091)

The parking coordinator declared a `requiredIntegrity` floor at
`/adminRegistry/admins` that nothing in the pattern could satisfy. Correcting
it changes the `ifc` at that path, and the compatibility proof compares `ifc`
for exact equality, so the correction reads as a contract break against both
recorded baselines. This record is the deliberation behind the entry in
`tasks/pattern-compat-accepted-breaks.ts`.

## The decision

The roster's floor named a `parking-admin-manager` atom. Nothing minted it at
that path: the roles inside the roster carry their own endorsement, and an
endorsement on an array's entries does not reach a floor declared on the array
path. So once the write-side floor is enforced, every write to the roster is
refused by the roster's own declaration.

Making the floor satisfiable means minting the atom it names at the path it
sits on, which changes the `ifc` there. Nothing else does: the floor asks what
the value at that exact path carries, and for a pattern-local atom the schema
mint is the only thing that can put it there — a value-bound atom does not
survive the flow meet.

The floor also had to name the same atom as the spot list's, because deciding
whether a person may edit a spot reads the roster, and this runtime screens a
floored write against every labeled read that preceded it. Two atoms in one
authorization flow leave each write demanding an atom the other's reads do not
carry. The registry keeps `parking-admin`, the atom the roles themselves
carry, and `parking-admin-manager` is gone.

The same change bound the path to one reviewed handler through
`writeAuthorizedBy`, so the roster is written by that handler and by nothing
else. That is a second `ifc` change at the same path, and it lands inside the
break already being accepted rather than as a separate one.

## What broke, on purpose

- `argument.adminRegistry.admins` and `result.adminRegistry.admins`: the `ifc`
  at the roster's path changed. It gained the mint that satisfies its own
  floor, its floor now names `parking-admin`, and it names the handler
  authorized to write it.

That is the whole break. It was verified by reverting the `ifc` declarations
alone, with every other change in place, and confirming the compatibility
proof then reported nothing but the unrecorded contract — so no second break
is hiding behind the one accepted here.

## Disposition of deployed pieces

A piece holding a roster keeps its stored roles: the runtime updater refuses a
contract-changing swap on an ordinary piece, and `cf piece setsrc` refuses an
update it cannot prove, so such a piece keeps running the source it has. What
it loses is the ability to be updated in place onto the corrected contract.

Nothing is stranded that was working. Every write to the roster under the old
contract is refused the moment the write-side floor is enforced, so a piece
that stays on the old source holds a roster it could not have changed anyway.
