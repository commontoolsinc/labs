---
status: historical
created: 2026-08-27
archived: 2026-08-27
reason: "Decision record for the Lot Watch admin-roster contract break: why an unsatisfiable integrity floor could not be repaired without changing the `ifc` at the roster's path, why the repair is the whole authorization shape rather than the mint alone, and what happens to pieces holding a roster."
---

# Lot Watch admin-roster contract break

Lot Watch declared a `requiredIntegrity` floor at `/adminRegistry/admins`
that nothing in the pattern could satisfy. Correcting it changes the `ifc`
at that path, and the compatibility proof compares `ifc` for exact equality,
so the correction reads as a contract break against the recorded baselines.
This record is the deliberation behind the entry in
`tasks/pattern-compat-accepted-breaks.ts`.

## The decision

The roster's floor named a `lot-watch-admin-manager` atom while the roles
inside the roster carried a separate `lot-watch-admin` atom, and neither the
roster path nor anything reaching it minted the atom the floor asked for. An
endorsement on an array's entries does not reach a floor declared on the
array path, and a plain string atom is bound to the value that carries it
rather than inherited by whatever reads it, so reading the credential that
carried the manager atom did not put that atom on the value a handler went
on to write. Once the write-side floor is enforced, every write to the
roster is refused by the roster's own declaration: the admin toggle, the
one-click curator promotion, and the step-down.

Part of that already bit at the settings in force. The floor's read-side
gate runs under `cfcEnforcementMode: "enforce-explicit"`, which the
pattern-test preset pins, and it demands that a floored write consume only
reads carrying one witness for the floor. A roster change reads the roster,
and the roster's own atom was not the one its floor named, so the first
roster write landed — it read an empty roster and consumed no labeled read
— and the second was refused terminally. The roster was a write-once cell:
one admin could be added, and after that no second admin, no revoke, no
step-down. The pattern's suite reported green because every scenario in it
changed the roster exactly once, which makes a dropped write look the same
as one that landed.

Four of the five rules in `packages/patterns/cfc/README.md` were broken
here, so this correction is more than the mint the lobby needed. All four
repairs land at the same declaration, and the first of them alone already
changes the `ifc`:

- **Mint on the path the floor sits on.** The roster path now carries
  `AddIntegrity` of the atom its own floor names, which is the only thing
  that can put a pattern-local atom on the value written there.
- **One atom per authority.** `lot-watch-admin` now runs through the roles,
  the roster and the floor. A floored write may only consume reads that all
  carry one witness for the floor, and deciding a roster change means
  reading the roster, so a second `lot-watch-admin-manager` atom left the
  two sides of that check with nothing in common.
- **A self-granted flag is not a credential.** The per-user cell that said
  the viewer may edit the roster is one the viewer's own button sets, and it
  claimed the manager atom. It is now a plain per-user boolean with no
  integrity, so it endorses nothing it is consulted for. Its dead optional
  input on the pattern's argument goes with it.
- **One reviewed writer.** The roster names `commitLotWatchAdminChange` in a
  `writeAuthorizedBy` contract, so a write from any other code — an
  unreviewed action here, or another pattern holding the same cell — is
  refused by the runtime rather than by convention. The three actions that
  wrote the roster directly now reach that handler as events.

Minting is not a way to decide who may write. It makes the floor accept
every write through this schema; the binding is what decides where a write
may come from, and it does not consult what the value carries. Doing the
mint without the binding would have moved the path from "no write satisfies
the floor" to "every write through this schema satisfies it", with nothing
left deciding the writer, which is why the two land together.

What the repair does not reach is who the acting person is. The role subject
is the free-text `reporterName` the viewer types, so a viewer can still take
a seat by naming themselves, exactly as the pattern's own comment has said
since it was written. That is a demo identity model, and it needs a stable
user identity rather than a change to this declaration.

## What broke, on purpose

- `argument.adminRegistry.admins`: the `ifc` at the roster's path changed.
  It gained the mint that satisfies its own floor, the single atom, and the
  writer binding.

That is the whole break. Removing the roster's optional manager-credential
input is compatible on its own, and the registry is not part of the
pattern's result, so only the argument role is blamed and no second break is
hiding behind the one accepted here.

## Disposition of deployed pieces

A piece holding a roster keeps its stored roles: the runtime updater refuses
a contract-changing swap on an ordinary piece, and `cf piece setsrc` refuses
an update it cannot prove, so such a piece keeps running the source it has.
What it loses is the ability to be updated in place onto the corrected
contract.

Nothing is stranded that was working. Every write to the roster under the
old contract is refused the moment the write-side floor is enforced, so a
piece that stays on the old source holds a roster it could not have changed
anyway.
