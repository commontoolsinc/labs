---
status: historical
created: 2026-10-11
archived: 2026-10-11
reason: "Record of the deliberate contract break taken when the lobby's and the CFC group chat demo's bootstrap admin role, and the parking coordinator's spot list, started naming the one handler that may write them."
---

# Admin bootstrap roles and the parking spot list name their writer

Three positions decided who holds authority in their pattern, and none of
them said who may write it:

- `bootstrapAdmin` in `packages/patterns/lobby/main.tsx`
  (`LobbyAdminBootstrapRole`) and in
  `packages/patterns/cfc-group-chat-demo/trusted.tsx`
  (`ChatAdminBootstrapRole`). While the explicit `admins` roster is empty and
  the everyone-is-admin fallback is off, this role is the whole admin policy.
  It carried an `addIntegrity` mint and nothing else, so any code holding a
  link to the registry could set it to a profile of its choosing and become
  the sole admin.
- `ParkingSpotList` in
  `packages/patterns/factory-outputs/parking-coordinator/main.tsx`. It carried
  a `requiredIntegrity` floor together with the `addIntegrity` mint that meets
  it. A write through a schema that carries the mint meets the floor whoever
  makes it, so the floor did not decide who may change the list.

The specification gives that decision to write authority, not to integrity.
§3.3 (`03-core-concepts.md`): "Modifying stored state is authorized by a
field-level **write-authority set** derived from handlers that declare
`writes: true`. This is an access-control capability (“who may write”), not
value integrity (“what may be believed”)." §8.15.6
(`08-15-write-authority.md`) states the check: "Handler identity must be
present in the field's write-authority set".

## What changed

- Both bootstrap roles carry the `TrustedActionWrite` binding their roster
  already carries: `commitTrustedLobbyAction` in the lobby, and
  `commitTrustedAdminToggle` in the group chat, each from a gesture on its
  reviewed surface. Those handlers are already the only code in each pattern
  that writes the role.
- The parking spot list carries `WriteAuthorizedBy<…, typeof
  commitParkingSpotChange>`. Its three inline spot actions (add, edit,
  remove) became one module-level handler, so one binding can be named; the
  published `addSpot`, `editSpot` and `removeSpot` streams keep their event
  shapes and forward to it.
- Every existing `addIntegrity` mint and `requiredIntegrity` floor is kept.
  A stored floor never falls, and a write that dropped the mint beside it
  would be refused.

## Why this could not be done compatibly

The compatibility proof compares `writeAuthorizedBy` exactly, so adding a
writer to a position reads as a changed `ifc` at that path. The only
compatible alternative is to leave the three positions writable by any code,
which is the hole this change closes.

## What happens to pieces holding the old shape

The stored value keeps loading and the pattern's own handler keeps writing it:
a stored envelope with no write-authority set at a path takes the candidate's
set on the first write the named handler makes there.

- **Parking.** The spot list takes the writer contract with the first spot
  change an admin makes; from then on other code is refused.
- **Group chat.** `commitTrustedAdminToggle` rewrites the whole registry,
  restating `bootstrapAdmin`, whenever the everyone-is-admin setting changes,
  so the role takes the contract at the next such change.
- **Lobby.** `commitTrustedLobbyAction` writes `bootstrapAdmin` only when it
  locks down a lobby that has no explicit admin and no bootstrap role. A
  lobby whose registry was stored before this change keeps an unprotected
  bootstrap role, or an unprotected empty slot, until then. §8.15.4 says
  "Initialization never adopts an existing value", and leaves installing
  protection over one open (§14.3.4). Once the explicit roster holds a role,
  the bootstrap role decides nothing, and the lobby never empties that
  roster.

A piece created after this change carries the contract from its first write.

Two behaviors change for callers:

- A caller can no longer supply the spot list's initial value. §8.15.4 names
  the runtime operations that initialize a protected slot, the first being
  "Seeding a new cell. A cell created with a default materializes its seed
  value."; a value the caller supplies is none of them, and the runtime
  treats it as the caller's write even where it equals the default. The pattern's tests and its admin-view integration fixture now
  leave `spots` to its default. A composing parent can still pass a spots
  cell.
- A bootstrap role links its subject's profile into a position that names its
  writer, and the runtime refuses to link a document that carries no label
  there. A real `#profile` carries its principal's label. The lobby tests'
  bare profile fixtures were replaced with labeled ones.

## What is accepted

- `lobby/main.tsx` over `20260729T022742Z-GhLFnf8OCmke_Jje`,
  `20260825T220126Z-EwdaMHAm2pYWzotF`, `20260831T222745Z-vwBXJaBcSaFeqPqy` and
  `20260909T184755Z-cx1Z_vlIBmAlVPDa`, path
  `argument.adminRegistry.bootstrapAdmin`.
- `factory-outputs/parking-coordinator/main.tsx` over
  `20260831T170522Z-_XKsZR_YXl9KpumB`, `20260831T222745Z-QfwqattilRDGXZc6`,
  `20260903T213920Z-di1kE0dvmOYRvT9G` and
  `20260909T184755Z-soDh0eM4uUL1tYyU`, path `argument.spots`. Its four older
  baselines stay forgiven by their existing entries, which name the roster
  paths the proof reports there.
- `cfc-group-chat-demo/main.tsx` over `20260923T232812Z-h-me8Kndg91BgtVA` and
  `20261004T000822Z-kUNF5sBKWx27omx3`, paths
  `argument.adminRegistry.bootstrapAdmin` and
  `result.adminRegistry.bootstrapAdmin`; and, added to the entries that
  already name them, the same two paths over
  `20260922T020444Z-IRoEgfpuUdf-xwvE` and `20260923T205929Z-mHuHgI9LlBLCu53t`.
