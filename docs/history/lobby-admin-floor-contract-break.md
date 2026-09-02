---
status: historical
created: 2026-08-25
archived: 2026-08-25
reason: "Decision record for the lobby admin-roster contract break: why minting the atom an unsatisfiable integrity floor names could not avoid changing the `ifc` at the roster's path, and what happens to pieces holding a roster."
---

# Lobby admin-roster contract break

The lobby declared a `requiredIntegrity` floor at `/admins` on the shared
admin registry that nothing in the pattern could satisfy. Correcting it
changes the `ifc` at that path, and the compatibility proof compares `ifc`
for exact equality, so the correction reads as a contract break against the
recorded baseline. This record is the deliberation behind the entry in
`tasks/pattern-compat-accepted-breaks.ts`.

## The decision

The roster's floor names the `lobby-admin` atom. Nothing minted it at that
path. The roles inside the roster carry their own endorsement through
`LobbyAdminRole`, and an endorsement on an array's entries does not reach a
floor declared on the array path. So once the write-side floor is enforced,
every write to the roster is refused by the roster's own declaration: the
admin promotion, the step-down, and the role a removed participant loses.

Making the floor satisfiable means minting the atom it names at the path it
sits on, which changes the `ifc` there. Nothing else does. The floor asks
what the value at that exact path carries, and for a pattern-local atom the
schema mint is the only thing that can put it there — a value-bound atom does
not survive the flow meet, so reading a document that carries the atom does
not endorse the value a handler goes on to write.

The other four rules in `packages/patterns/cfc/README.md` already held here,
so this correction is the mint alone. One atom, `lobby-admin`, runs through
the whole registry, so a floored write that reads the roster consumes a read
carrying the witness its floor names. The entries were already endorsed, so
an entry that moves position keeps a label of its own. The pattern has no
self-granted credential: `everyoneIsAdmin` carries no integrity, and the
acting profile's authority is read out of the roster. And the roster is
already bound to one reviewed handler, `commitTrustedLobbyAction`, through
the `writeAuthorizedBy` contract that `TrustedActionWrite` lowers to, so
minting the atom does not widen who may write — the binding decides that,
and it does not consult what the value carries.

## What broke, on purpose

- `argument.adminRegistry.admins`: the `ifc` at the roster's path changed. It
  gained the mint that satisfies its own floor.

That is the whole break. The change touches nothing but that one `ifc`
declaration and the comment above it, and the compatibility proof reports
that one path and the unrecorded contract, so no second break is hiding
behind the one accepted here. The registry is not part of the pattern's
result, so only the argument role is blamed.

## Disposition of deployed pieces

A piece holding a roster keeps its stored roles: the runtime updater refuses
a contract-changing swap on an ordinary piece, and `cf piece setsrc` refuses
an update it cannot prove, so such a piece keeps running the source it has.
What it loses is the ability to be updated in place onto the corrected
contract.

Nothing is stranded that was working. Every write to the roster under the old
contract is refused the moment the write-side floor is enforced, so a piece
that stays on the old source holds a roster it could not have changed anyway.
