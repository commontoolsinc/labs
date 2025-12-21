# RFC: How should patterns dynamically instantiate other patterns?

## Status
Draft - pending filing to Linear

## The Use Case

**MembersModule** allows users to reference other Record charms. When a user types a name that doesn't match any existing record, we want to create a new Record charm with that name. This requires:

1. Pattern A (MembersModule) creating an instance of Pattern B (Record)
2. Creation happening inside a handler (responding to user action)
3. No circular dependency (MembersModule is imported by Record)

## Why This Is Currently Impossible

We've exhaustively investigated the options:

| Approach | Result | Why |
|----------|--------|-----|
| Import Record directly | ❌ | Circular dependency |
| Pass factory function as pattern input | ❌ | Functions serialize to `undefined` during recipe compilation |
| Pass factory function as handler state | ❌ | Handler state goes through `JSON.stringify()` |
| Pass handler from parent pattern | ❌ | Frame system prevents cross-pattern handler refs |
| `compileAndRun()` | ❌ | No way to get source code at runtime - pattern is already compiled |

**Root cause**: Recipe compilation happens at build time, producing JSON-serializable structures. Functions cannot survive this serialization boundary.

### Detailed Investigation: Why Functions Fail

When `MembersModule({ createPattern: fn })` is called:

1. Recipe builder runs immediately during pattern definition
2. `createPattern` becomes an OpaqueRef proxy
3. During serialization (`toJSONWithLegacyAliases`), functions are not handled specially
4. Functions fall through and become `undefined` in JSON output
5. At runtime, handler receives `undefined`

Evidence: `packages/runner/src/builder/recipe.ts:337-343` (serialization), `packages/runner/src/builder/json-utils.ts:31-128` (JSON conversion)

### Detailed Investigation: Why compileAndRun Fails

The blocker is NOT size or performance. The blocker IS:

- **No way to get Record.tsx source code at runtime**
- `compileAndRun` expects source strings, not compiled pattern functions
- The pattern is already compiled and bundled—you can't get back to source

## Current Workaround (Not Allowed for Patterns)

The only working approach accesses internal runtime APIs:

```typescript
// ct-code-editor uses this for wiki-links, but patterns shouldn't access .runtime
const rt = (cell as any).runtime;
const tx = rt.edit();
const result = rt.getCell(rt.space, cause);
rt.run(tx, JSON.parse(patternJson), inputs, result);
tx.commit();
```

This works in `ct-code-editor` because components are trusted code. Patterns should not access `.runtime`.

---

## Proposed Solutions

### Option A: `instantiate()` Builtin

A new builtin that creates charm instances from Recipe objects:

```typescript
// Usage in pattern
const newRecord = instantiate({
  pattern: Record,  // Recipe object (survives serialization via .toJSON())
  inputs: { title: "New Record" }
});
```

**Design highlights:**
- Takes `Recipe` object (already serializable via `.toJSON()`)
- Returns `Cell<T>` with the new charm
- Inherits space from parent (security requirement - consistent with all builtins)
- Reactive: re-instantiates when pattern changes, updates when inputs change
- Uses existing `runtime.runSynced()` internally

**Implementation sketch:**
```typescript
function instantiate(inputsCell, sendResult, addCancel, cause, parentCell, runtime): Action {
  let resultCell;
  let previousPatternHash;

  return (tx) => {
    const { pattern, inputs } = inputsCell.withTx(tx).get();
    const patternHash = refer(pattern).toString();

    if (patternHash !== previousPatternHash) {
      resultCell = runtime.getCell(parentCell.space, { instantiate: { result: cause } }, undefined, tx);
      addCancel(() => runtime.runner.stop(resultCell));
      sendResult(tx, resultCell);
      previousPatternHash = patternHash;
    }

    if (resultCell && pattern) {
      runtime.runSynced(resultCell, pattern, inputs);
    }
  };
}
```

**Pros:**
- Consistent with existing builtins (`wish`, `compileAndRun`, `map`)
- Works anywhere in pattern code (body or handlers)
- Full type safety with `Recipe` objects
- Automatic cleanup via `addCancel`

**Cons:**
- New runtime feature to maintain
- Patterns gain ability to spawn arbitrary charms (security consideration)

---

### Option B: `ct-charm-creator` Component

A UI component that handles runtime access internally:

```typescript
<ct-charm-creator
  $pattern={patternJsonCell}
  $inputs={inputsCell}
  onct-created={handleCreated}
  onct-error={handleError}
/>
```

**Pros:**
- Components are already trusted (in TCB)
- Clear separation: patterns describe, components act
- Familiar event-based API

**Cons:**
- Invisible utility component is architectural smell
- More complex for simple use cases
- Event-based API less composable than Cell return

---

## Questions for Framework Team

1. **Is there an intended pattern for this use case we're missing?**

2. **If a new feature is needed, which approach is preferred?**
   - Builtin: More powerful, works everywhere
   - Component: Maintains pattern/component trust boundary

3. **Security considerations:**
   - Should patterns be able to spawn arbitrary charms?
   - Rate limiting? Pattern allowlists?
   - The builtin would inherit parent space (consistent with all other builtins)

4. **Is `Recipe` the right type to pass?**
   - Alternative: pattern ID string that gets resolved at runtime
   - Alternative: pattern JSON string (like current workaround)

---

## Files Referenced

- `packages/patterns/members.tsx` - the pattern needing this capability
- `packages/patterns/record.tsx` - the pattern being instantiated
- `packages/runner/src/builtins/wish.ts` - existing pattern instantiation via `runSynced`
- `packages/runner/src/builtins/compile-and-run.ts` - existing async charm creation
- `packages/ui/src/v2/components/ct-code-editor/ct-code-editor.ts` - component using runtime access

---

## Oracle Investigation Summary

### Key Evidence Files
- `packages/runner/src/runtime.ts:455` - JSON.stringify in getImmutableCell
- `packages/runner/src/builder/recipe.ts:337-343` - node serialization
- `packages/runner/src/builder/json-utils.ts:31-128` - toJSONWithLegacyAliases
- `packages/runner/src/runner.ts:916-919` - unwrapOneLevelAndBindtoDoc
- `packages/runner/src/cell.ts:312` - Cell.runtime is public readonly

### Data Flow (Why Functions Fail)
```
AUTHORING TIME:
MembersModule({ createPattern: fn })
  → recipe() creates OpaqueRef proxy
  → toJSONWithLegacyAliases serializes nodes
  → Functions become undefined (not JSON-serializable)

RUNTIME:
  → unwrapOneLevelAndBindtoDoc deserializes
  → Handler receives { createPattern: undefined }
  → Error: "Cannot create record: no template available"
```

### Security Findings
- All builtins inherit `parentCell.space` - no exceptions found
- No rate limiting exists in current builtins
- Space parameter would violate security model (allow cross-space writes)
