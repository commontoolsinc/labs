---
status: historical
created: 2026-10-11
archived: 2026-10-11
reason: "Record of the deliberate contract break taken when the group chat demo's everyone-is-admin flag moved its floor off one union branch and onto the flag as a whole."
---

# Group chat demo: the everyone-is-admin flag carries one claim

`ChatEveryoneAdminFlag` in `packages/patterns/cfc-group-chat-demo/trusted.tsx`
was a union of a `true` branch and a `false` branch. Both named
`commitTrustedAdminToggle` as the only writer, from the trusted admin surface.
Only the `true` branch carried the floor and the mint:

```ts
// Shown for illustration only: the former declaration.
export type ChatEveryoneAdminFlag =
  | RequiresIntegrity<
    AddIntegrity<TrustedActionWrite<true, /* toggle, action, surface */>, [admin]>,
    [admin]
  >
  | TrustedActionWrite<false, /* toggle, action, surface */>;
```

The CFC spec, §4.2.1.1, puts that outside the normalized IFC schema profile.
Value-validation combinators "MUST NOT carry branch-local IFC obligations
unless those obligations are normalized away first". The flag is now one
claim, at `/everyoneIsAdmin`:

```ts
// Shown for illustration only.
export type ChatEveryoneAdminFlag = RequiresIntegrity<
  AddIntegrity<TrustedActionWrite<boolean, /* toggle, action, surface */>, [admin]>,
  [admin]
>;
```

## Why `true` is gated at least as strictly as before

Setting `true` makes everyone an admin, so it is the decision that matters.
Before the change, three things gated it:

- the `writeAuthorizedBy` binding to `commitTrustedAdminToggle`;
- the UI contract requiring the trusted admin surface's gesture;
- the admin floor, which the same toggle's mint satisfies.

The normalized claim keeps all three, with the same binding, the same
contract, the same floor and the same mint, so a write of `true` is admitted
only where it was admitted before. The one change is that `false` is now
gated the same way. `false` already had the same writer and contract; it now
also gets the mint and the floor. Nothing is loosened.

## Why this could not be done compatibly

The recorded contracts carry the branch form. The compatibility proof reads
any change to the flag's IFC as "ifc changed", and no spelling of a single
claim reproduces the branches.

The readers of the registry declare a view of the flag that has its writer
binding and mint but no floor. Who may change the flag is decided by that
binding, an access-control capability, not by value integrity (§3.3,
§8.15.5). Restating the branches without their floor does not work: an
envelope merge takes a writer's `anyOf` in place of the stored one, not
branch by branch, so it would drop the stored floor, and the merge refuses
that.

## What a document stored under the old contract does

The new runner tests in `packages/runner/test/cfc-stored-write-requirements.test.ts`
("a branch-local floor normalized to one claim") cover three cases:

- **The stored floor never falls.** A write through the normalized schema
  keeps an old document's branch floor.
- **A registry stored before the change takes one more write, then is
  refused.** The toggle writes through the floorless view. Its first write
  persists the old branches inline beside the new claim, with the floor kept.
  Every write after that is refused: "ifc inside divergent anyOf branches is
  unsupported" at the flag's path.
- **A registry created after the change behaves normally.** It takes every
  toggle.

The pattern is a demo, so a chat created before the change stops accepting
admin changes after one toggle. This is an accepted casualty, not a migration
target. The only way to carry such a document forward would be a runtime
merge that normalizes a stored branch-local claim, and that is outside this
change.

## What is accepted

`cfc-group-chat-demo/main.tsx` is forgiven the paths
`argument.adminRegistry.everyoneIsAdmin` and
`result.adminRegistry.everyoneIsAdmin` over these baselines:

- `20260923T205929Z-mHuHgI9LlBLCu53t`, beside that contract's earlier
  accepted `result.*` paths;
- `20260923T232812Z-h-me8Kndg91BgtVA`;
- `20261004T000822Z-kUNF5sBKWx27omx3`.
