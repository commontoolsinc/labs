# Admin: future direction (CFC integrity)

## Current implementation

The first user to join the poll is captured into `adminName: PerSpace<string>`.
Admin actions (add/remove option, reset votes) short-circuit when
`myName !== adminName`. This is enforced at the pattern level — a determined
caller can invoke a handler with arbitrary inputs and the runtime will not stop
them. The "OCC + auto-retry" guarantees in `packages/runner/src/scheduler.ts`
make the _claim race_ safe, but they don't make the admin role itself
unforgeable.

## Target direction

Authority should be modeled via **CFC integrity claims** rather than runtime
equality checks. The reference implementation landed in **PR
[#3358](https://github.com/commontoolsinc/labs/pull/3358) "Add CFC group chat
demo and authorship fixes"** by Berni (merged 2026-05-19), which introduces the
primitives:

```ts
// New in @commonfabric/api/cfc.ts (PR #3358):
type RepresentsCurrentUser<T> = Cfc<T, {
  addIntegrity: [
    { kind: "represents-principal"; subject: { __ctCurrentPrincipal: true } },
  ];
}>;
type AuthoredByCurrentUser<T> = Cfc<T, {
  addIntegrity: [
    { kind: "authored-by"; subject: { __ctCurrentPrincipal: true } },
  ];
}>;
```

The PR also fixes the runner so nested CFC labels survive array-item persistence
— required for "every item in a per-space list carries its own integrity claim."

## Canonical reference

`packages/patterns/cfc-group-chat-demo/` is the worked example. The shape that
translates to cozy-poll:

```ts
// Per-user pointer to my profile in the space-scoped directory.
// (Same idiom we already use here for `me: PerUser<{user?: User}>`
//  and verified in packages/patterns/scoped-user-directory/.)
myProfile: PerUser<{ profile?: ProfileCell }>;

// The profile value carries "represents me" — the runtime checks
// the current principal against this when reading.
type TrustedProfile = RepresentsCurrentUser<
  TrustedActionWrite<ChatProfile, ...>
>;

// Each item in the per-space list carries an authorship claim that's
// verified at render time. No manual requiredIntegrity plumbing needed —
// render policy auto-infers it from the author cell type.
type TrustedSentChatMessage = AuthoredByCurrentUser<
  TrustedActionWrite<SentChatMessage<ProfileCell>, ...>
>;
```

UI rendering uses a component like `VerifiedChatBubble({ message })` which
transparently verifies the integrity claim before showing trusted content.

## Translation for cozy-poll

When the wiring lands, the cozy-poll equivalents would be roughly:

- `users: PerSpace<TrustedProfile[]>` — directory entries carry
  `RepresentsCurrentUser` and a `TrustedActionWrite` constraint on the
  profile-save handler.
- `votes: PerSpace<AuthoredByCurrentUser<Vote>[]>` — each vote is
  signed-by-construction; spoofing another user's vote is rejected at the kernel
  before persistence.
- `options: PerSpace<...>` — write-gate this on an admin integrity claim. Exact
  shape TBD; likely a separate `IsAdmin` integrity claim added to the admin's
  profile on first-join, and `RequiresIntegrity<...,
  ["IsAdmin"]>` on the
  options/votes-reset write paths.
- The pattern-level `myName === adminName` check becomes UX-only — hide the
  admin UI when the viewer doesn't carry the claim, but the security boundary
  moves to the kernel.

## Path forward

The pattern-level `adminName` equality check stays for compatibility, but the
actual security boundary moves to CFC labels on the write paths, with the
`cfc-group-chat-demo` as the reference for the exact API shape.

## Cross-references

- [PR #3358](https://github.com/commontoolsinc/labs/pull/3358) — the enabling
  work. `packages/patterns/cfc-group-chat-demo/trusted.tsx` is the most
  condensed reference for the layered type shape.
- [`packages/patterns/scoped-user-directory/`](../scoped-user-directory/) —
  verified that the per-user-pointer-into-per-space-directory idiom works; this
  is the structural baseline that PR #3358's chat demo also uses (just with
  CFC-typed value wrappers).
- [`docs/development/scoped-cells-field-notes.md`](../../../docs/development/scoped-cells-field-notes.md)
  — session notes from the original lunch-poll build, including the OCC + retry
  guarantees the current admin-claim flow relies on.
