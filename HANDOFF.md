# Handoff: WishState Type Fix

## Current Branch

`fix/wish-required-optional-investigation` (based on
`fix/schema-generator-required-optional`)

## What We've Done

### PR 1: Schema Generator Optionality Fix (ready, pushed)

Branch: `fix/schema-generator-required-optional`

Centralized property optionality logic into
`packages/schema-generator/src/typescript/property-optionality.ts`. Key change:
trust `SymbolFlags.Optional` instead of declaration `questionToken`. This
correctly handles `Required<>` and `Partial<>` mapped types. Added test fixtures
for both.

### PR 2 / Investigation (this branch)

- **Reproduced the wish bug**: deployed
  `packages/patterns/notes/wish-action-test.tsx` to space
  `wish-action-test-fix`, piece ID
  `baedreicufp5q66iy3jr6ddlqaloccmrrftxe5rtckj3haw7d4rkf4b7pue`
  - `increment` handler (control, no wish dep): **works**
  - `useWish` handler (closes over wish result): **crashes** with
    `Cannot destructure property 'wishResult' of 'undefined'`
- This is a **regression from PR 1**: on main, the buggy `questionToken` check
  happened to see `?` on `WishState.result` and treated it as optional, masking
  the problem. Our fix correctly respects `Required<>`, making `result` required
  in the schema, which breaks when the wish hasn't resolved.

## Current State of WishState Type Change

We modified two files to drop `Required<>` and make properties explicitly
`T | undefined`:

### packages/api/index.ts (line ~1651)

```typescript
// BEFORE:
export type WishState<T> = {
  result?: T;
  candidates?: T[];
  error?: any;
  [UI]?: VNode;
};
export interface WishFunction {
  <T = unknown>(target: Opaque<WishParams>): OpaqueRef<Required<WishState<T>>>;
}

// CURRENT (on this branch):
export type WishState<T> = {
  result: T | undefined;
  candidates: T[] | undefined;
  error: any;
  [UI]: VNode | undefined;
};
export interface WishFunction {
  <T = unknown>(target: Opaque<WishParams>): OpaqueRef<WishState<T>>;
}
```

### packages/api/schema.ts (line ~411)

```typescript
// BEFORE:
): OpaqueRef<Required<import("commontools").WishState<Schema<S>>>>;

// CURRENT:
): OpaqueRef<import("commontools").WishState<Schema<S>>>;
```

## Type Errors from This Change

The `T | undefined` propagates through `OpaqueRef<T>` into inner types, causing
`| undefined` to appear where downstream code doesn't expect it. **7 patterns
fail type-checking:**

### Failing with `CellLike<any[]>` assignability (MentionablePiece[] | undefined):

1. `packages/patterns/notes/note.tsx` — `$mentionable` prop
2. `packages/patterns/notes/notebook.tsx` — same pattern
3. `packages/patterns/experimental/chat-note.tsx` — same pattern
4. `packages/patterns/experimental/email-task-engine.tsx` — same pattern

### Failing with `Property 'set' does not exist on type 'never'` (Writable intersection reduced to never):

5. `packages/patterns/system/omnibox-fab.tsx`
6. `packages/patterns/system/common-tools.tsx`

### Failing with `Property 'get' does not exist on type 'never'`:

7. `packages/patterns/examples/profile-aware-writer.tsx`

### Other:

8. `packages/patterns/system/suggestion.tsx` — handler type mismatch + `.set` on
   never

### Clean (no errors):

chatbot.tsx, note-md.tsx, weekly-calendar.tsx, google-auth-manager-minimal.tsx,
google-auth-manager.tsx, wish-note-example.tsx, test-cross-charm-client.tsx,
home.tsx, profile.tsx, emoji-picker.tsx

## The Core Tension

The schema needs `result` to be **not required** (because it's transiently
undefined at runtime). But `OpaqueRef` proxy makes property access always return
a proxy (never actually undefined), so TypeScript types shouldn't include
`| undefined` from the user's perspective.

Two categories of error:

1. **CellLike assignability**: `OpaqueRef<T | undefined>` doesn't satisfy
   `CellLike<T>` — the `| undefined` leaks through
2. **Intersection reduced to never**:
   `OpaqueCell<Writable<string> | undefined> & Writable<string>` — conflicting
   cell brands

## Berni's Input

Berni agreed the type on wish should change so result is not required. There's a
tentative plan for a proper fix (details TBD from their conversation). The
question being explored is: what's the scope of a workaround where we fix each
call site to guard against undefined?

## Exploration Artifacts

- `packages/ts-transformers/test/fixtures/closures/action-wish-result.input.tsx` +
  `.expected.tsx` — generated during exploration, shows the transformed schema
  with `required: ["result"]` and `asOpaque: true`. **Not committed, not part of
  PR.**
- Dev servers were restarted with the type change. If continuing, may need
  restart again depending on state.

## Next Steps

1. Decide approach: fix call sites vs. proper type-level fix
2. If fixing call sites: ~7 patterns need changes, mostly adding `!` non-null
   assertions or `as` casts where wish `.result` is passed to components
   expecting non-undefined types
3. If proper type fix: need a way for schema to say "not required" without
   `| undefined` leaking through OpaqueRef
