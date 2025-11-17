# Branch Structure Summary

## Current Branch: `refactor/unify-typeregistry`

**Status:** ✅ All tests passing (16 suites, 180 steps, 0 failures)

## Branch Lineage

```
main (d0f65275)
  │
  └─→ feature/wish-schemas (10b2128f)
       │
       └─→ refactor/unify-typeregistry (4e25e18e) ← YOU ARE HERE
```

## What's on `feature/wish-schemas` (Base Branch)

The `wish-schemas` branch contains foundational work for schema generation with
the `wish` built-in and fixes related issues. This branch has **6 commits** that
are not in main:

### Commit History (oldest to newest):

1. **`f565b9e7`** - "fix common tools formatter to handle new opaqueref type"
   - Updates the formatter to handle OpaqueRef types correctly

2. **`3f2df950`** - "temporarily add document"
   - Added temporary documentation

3. **`ab82dd7b`** - "remove doc"
   - Removed temporary documentation

4. **`0c0991d3`** - "remove unused derive"
   - Cleanup work

5. **`eb4999a4`** - "fix for new wrapper union type handling"
   - Fixes for handling union types in wrappers

6. **`6ba86987`** - "schemas for wish"
   - **Core work**: Added schema generation support for the `wish` built-in
   - Modified files:
     - `packages/api/index.ts` - API changes for wish schemas
     - `packages/runner/src/builder/built-in.ts` - Built-in builder updates
     - `packages/runner/src/builtins/wish.ts` - Wish implementation with schemas

7. **`10b2128f`** - "fix crashes, write up design question"
   - Fixed crashes related to TypeParameter handling
   - Added `type-parameter-schema-issue.md` documenting the generic functions
     problem
   - Fixed files:
     - `packages/ts-transformers/src/ast/type-inference.ts`
     - `packages/ts-transformers/src/closures/transformer.ts`

### Key Issue Documented on `wish-schemas`:

The branch includes a design document (`type-parameter-schema-issue.md`) that
identifies a limitation:

**Problem:** Generic helper functions that use `derive` can't get schemas
because type parameters aren't concrete at definition time.

**Example:**

```typescript
function schemaifyWish<T>(path: string, def: T) {
  return derive(wish<T>(path), (i) => i ?? def);
  // T is only known at call site, not here
}
```

**Current solution:** Graceful degradation - compiles without schemas for
generic functions.

## What's on `refactor/unify-typeregistry` (This Branch)

This branch builds on `wish-schemas` with **4 additional commits**:

1. **`5fd9dd9f`** - "refactor(ts-transformers): unify and consolidate
   TypeRegistry usage"
   - Phase 1-2 work: Unified TypeRegistry usage across transformers

2. **`ab1bd399`** - "fmt"
   - Formatting fixes

3. **`a68ef00a`** - "small fix to handler path for schemas"
   - Handler schema generation fix

4. **`4e25e18e`** - "update schema generation behavior to be more consistent;
   use schemas for unused parameters" ← CURRENT
   - **Phase 3 work**: Implemented never/unknown refinement
   - Always generate schemas for all functions
   - Use `false` (never) for missing/unused parameters
   - Use `true` (unknown) for untyped parameters
   - Made Recipe lenient (always transforms)

## Relationship to This Work

The work on this branch (`refactor/unify-typeregistry`) is:

1. **Building on wish-schemas work**: The wish built-in needed schemas, which
   exposed transformer architecture issues

2. **Solving transformer unification**: Phase 1-2 unified how transformers share
   type information via TypeRegistry

3. **Implementing never/unknown refinement**: Phase 3 (just completed) ensures
   all transformers consistently handle missing vs. untyped parameters

4. **Related to generic functions issue**: The type-parameter question from
   `wish-schemas` is still open and documented as an outstanding Phase 4
   question

## Why This Branch Structure?

The `wish-schemas` branch likely needed:

- Schema generation for `wish` built-in ✓
- Which required transformer fixes ✓
- Which exposed the need for TypeRegistry unification ✓
- Which led to the never/unknown refinement work ✓

So `refactor/unify-typeregistry` is the **transformer infrastructure
improvements** needed to properly support the `wish-schemas` work.

## Next Steps

1. **Merge path**: This branch should eventually merge into `wish-schemas`, then
   `wish-schemas` merges to `main`

2. **Outstanding question**: The generic functions issue (documented in
   `type-parameter-schema-issue.md` on the base branch) needs manager decision
   before `wish-schemas` can be considered complete

3. **Current status**: This branch (`refactor/unify-typeregistry`) is complete
   and all tests pass. Ready for review before merging back to `wish-schemas`.
