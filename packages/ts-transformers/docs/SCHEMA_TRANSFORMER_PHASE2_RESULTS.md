# Schema Transformer Unification - Phase 2 Results

## Status: ✅ SUCCESS

**Date**: 2025-01-16 **Branch**: `refactor/unify-typeregistry` (continuing from
Phase 1) **Base**: Phase 1 TypeRegistry unification

## Objective

Complete the TypeRegistry unification by fixing the handler inference path to
use the DRY helper function `createSchemaCallWithRegistryTransfer`, ensuring all
transformation paths consistently check TypeRegistry for closure-captured types.

## Background

After Phase 1, we discovered one remaining inconsistency: Handler's inference
path was using `createToSchemaCall` directly instead of
`createSchemaCallWithRegistryTransfer`, meaning it wasn't checking TypeRegistry
for closure-captured types.

### Handler's Unique Schema Design

Handler differs from other functions in how it uses schemas:

**Function Signature:**

```typescript
handler<Event, State>((event, state) => {...})
```

**Schema Usage:**

- **Event schema**: Serves double duty
  - Types the `event` parameter in the handler function
  - Types the returned `Stream<Event>` (what events can be sent to it)
- **State schema**: Types the `state` parameter and factory inputs

**Return Type:**

- Handler returns `Stream<Event>` (not void!)
- The Event schema is reused for the stream type
- No separate `resultSchema` needed

## Changes Made

### File: `packages/ts-transformers/src/transformers/schema-injection.ts`

**Lines Changed**: 469-478

**Before:**

```typescript
if (eventParam || stateParam) {
  const toSchemaEvent = createToSchemaCall(context, eventType);
  const toSchemaState = createToSchemaCall(context, stateType);
```

**After:**

```typescript
if (eventParam || stateParam) {
  const toSchemaEvent = createSchemaCallWithRegistryTransfer(
    context,
    eventType,
    typeRegistry,
  );
  const toSchemaState = createSchemaCallWithRegistryTransfer(
    context,
    stateType,
    typeRegistry,
  );
```

## Impact

### What This Fixes

**Closure captures in handler inference now work:**

```typescript
const makeHandler = (capturedEventType: SomeType) => {
  return handler((event: typeof capturedEventType, state: StateType) => {
    // ClosureTransformer creates synthetic type for 'typeof capturedEventType'
    // Schema-injection now finds it via TypeRegistry! ✅
  });
};
```

**Before Phase 2:**

- Type arguments path: ✅ Checked TypeRegistry
- Inference path: ❌ Did NOT check TypeRegistry

**After Phase 2:**

- Type arguments path: ✅ Checks TypeRegistry
- Inference path: ✅ Checks TypeRegistry

### Code Quality Benefits

1. **Consistency**: All transformation paths now use TypeRegistry uniformly
2. **DRY**: Using the helper function instead of duplicating logic
3. **Maintainability**: Single source of truth for TypeRegistry transfer
4. **Correctness**: Closure captures work in all code paths

## Test Results

**All tests passing!** ✅

```
Testing ts-transformers...
- opaque-ref: ok | multiple test suites passed
- derive: ok | 1 passed
- utils: ok | 2 passed
- fixture-based: ok | 5 passed (182+ steps)
- closure: ok | 1 passed (160+ steps)

Total: 19 passed, 0 failed
```

## Complete Unification Status

After Phase 2, **all transformation paths** consistently use TypeRegistry:

| Path    | Type Args                 | Inference                |
| ------- | ------------------------- | ------------------------ |
| Recipe  | ✅ Uses helper            | ✅ Uses helper           |
| Pattern | ✅ Uses helper            | ✅ Uses helper           |
| Handler | ✅ Uses helper            | ✅ Uses helper (Phase 2) |
| Derive  | ✅ Has TypeRegistry logic | ✅ Uses helper           |
| Lift    | ✅ Checks TypeRegistry    | ✅ Uses helper           |

## Key Learnings

### Handler's Return Type Discovery

**Initial incorrect assumption**: Handler has no return type (void)

**Actual design**: Handler returns `Stream<Event>`

- The Event schema serves double duty: input parameter AND output stream
- This is why handler only needs Event + State schemas, no separate resultSchema
- The factory signature is: `(props: State) => Stream<Event>`

### Why This Matters

Understanding handler's return type was crucial because:

1. It validated that handler SHOULD check TypeRegistry (closure captures in
   Event type affect the stream)
2. It confirmed that both Event and State schemas can benefit from
   closure-captured types
3. It showed that the original Phase 2 fix was correct, just needed proper
   justification

## Lines of Code Changed

```
Files changed: 1
Lines added: 8
Lines removed: 2
Net change: +6 lines (but more consistent/maintainable)

Main file: packages/ts-transformers/src/transformers/schema-injection.ts
```

## Diff Summary

```diff
  if (eventParam || stateParam) {
-   const toSchemaEvent = createToSchemaCall(context, eventType);
-   const toSchemaState = createToSchemaCall(context, stateType);
+   const toSchemaEvent = createSchemaCallWithRegistryTransfer(
+     context,
+     eventType,
+     typeRegistry,
+   );
+   const toSchemaState = createSchemaCallWithRegistryTransfer(
+     context,
+     stateType,
+     typeRegistry,
+   );
```

## Recommendations

### ✅ Merge This Change (Recommended)

**Rationale:**

- All tests pass
- Completes TypeRegistry unification from Phase 1
- Fixes a real bug (closure captures didn't work in handler inference)
- Uses the DRY helper function
- No breaking changes
- Improved consistency across all transformation paths

### Next Steps

1. **Merge this PR**: Safe to merge with Phase 1 changes
2. **Consider Phase 3**: Unify fallback policies across all paths?
3. **Monitor Production**: Watch for any edge cases in real usage
4. **Update Master Plan**: Mark Phase 2 complete in
   SCHEMA_TRANSFORMER_UNIFICATION.md

## Conclusion

Phase 2 successfully completed the TypeRegistry unification started in Phase 1.
The handler inference path now consistently checks TypeRegistry and uses the DRY
helper function, bringing it in line with all other transformation paths.

**The original unification hypothesis was correct**: TypeRegistry should be
checked uniformly across all paths. The inconsistencies were accidental, not
intentional design decisions.

**Recommend proceeding with merge.**
