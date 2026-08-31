---
status: historical
created: 2026-08-27
archived: 2026-08-27
reason: "Decision record for the parking-coordinator admin-subject contract break: why a parking-admin role stopped naming a person's name and started naming their profile cell, and what happens to pieces holding a roster of the old shape."
---

# Parking coordinator admin-subject contract break (#6091 follow-up)

A parking-admin role named a person by name. Review of
[#6091](https://github.com/commontoolsinc/labs/pull/6091) asked for the CFC
primitives instead — compare profiles by their cells, not by what those cells
happen to be called — so a role now names the viewer's `#profile` cell. That
changes the stored shape of a role, which the compatibility proof reports as a
break against the roster contract that change had just recorded.

## The decision

A name is not an identity. Two people can answer to one, one person can change
theirs, and a roster keyed on names has to keep chasing both facts: renaming a
person had to move their role, removing one had to drop it, and a later person
taking a departed admin's name would otherwise inherit their authority. Each of
those was a rule the pattern enforced by hand, and getting any of them wrong
locked the roster.

A role now names a `Cell` — the viewer's own `#profile` — and
`activeAdminRoleForSubject` and `subjectHasAdminRole` from
`packages/patterns/cfc/admin/mod.ts` compare subjects by cell identity. The
rules that chased names are gone rather than fixed: a rename moves nothing,
because the row keeps the same profile; a new person of an old name inherits
nothing, because they arrive with no profile at all.

A `Person` gained an optional `profile`, and a viewer claims one row as
themselves. Until a row is claimed it is a name on a roster: it can hold a
parking spot, and it cannot hold a role, because nothing says who it is.

## What broke, on purpose

- `argument.adminRegistry.admins[].subject`: a role's subject is a cell now,
  where it was an inline object.
- `result.adminRegistry.admins[].subject.personName`: the name that stood in
  for the identity is gone with it.

Both are the same change seen from the two roles a contract has.

## Disposition of deployed pieces

A stored role of the old shape carries a name where a profile cell is now
expected, so it names nobody the pattern can resolve, and the piece holding it
cannot be updated in place onto the new contract — the runtime updater refuses
a contract-changing swap, so such a piece keeps running its own source.

The demo's own bootstrap is what recovers a space that starts over on the new
contract: a roster holding no role the pattern can resolve is an open roster,
and the first viewer to claim a row can take the first seat. That is the same
rule that lets a fresh space have an admin at all.
