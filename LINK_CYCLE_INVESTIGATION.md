# Link Cycle Issue Investigation

## Summary

Investigation into link cycle detection issues, particularly related to `fetchAndRunPattern` and dynamic pattern execution.

## Background

From `packages/patterns/PREEXISTING_BUGS.md`:

**Bug 3: suggestion.tsx / suggestion-test.tsx - $alias Not Resolving**
- When Suggestion pattern returns a Counter or other pattern via `fetchAndRunPattern`, cell values show as raw `$alias` objects instead of resolved values
- Example: Shows `"Counter is the {"$alias":...} number"` instead of the actual count
- Suspected cause: Issue with how patterns are dynamically instantiated through the LLM tool call flow in `fetchAndRunPattern`

## Link Cycle Detection Mechanism

Located in `/Users/alex/Code/labs-2/packages/runner/src/link-resolution.ts`:

```typescript
// Detect cycles by tracking visited (document, path) pairs
const seen = new Set<string>();
const key = JSON.stringify([link.space, link.id, link.path]);
if (seen.has(key)) {
  logger.error("link-res-error", `Link cycle detected ${key}`);
  throw new Error(`Link cycle detected at ${key}`);
}
seen.add(key);
```

The cycle detector tracks exact `(space, id, path)` triples and throws an error if the same triple is visited twice during link resolution.

## Test Results

### Test 1: Basic Link Cycles (`test-link-cycle.js`)

Created simple test cases:

**✓ Circular references work correctly:**
```javascript
// Cell A references B, B references A
cellA.set({ child: cellB.getAsLink() });
cellB.set({ parent: cellA.getAsLink() });

// This works: A -> child -> parent -> name
cellA.key("child").key("parent").key("name").get(); // ✓ Returns "Cell A"
```

**✓ True cycles are detected:**
```javascript
// Cell C references itself
cellC.setRaw(cellC.getAsLink());
cellC.get(); // ✗ Throws "Link cycle detected" (expected)
```

### Test 2: fetchAndRunPattern Simulation (`test-fetch-and-run-cycle.js`)

Simulated the pattern execution flow:

**✓ Pattern nesting works:**
- Pattern A calls Pattern B
- Pattern B references A's context
- Pattern A references B's result
- No cycles detected

**✓ Schema self-references work:**
- Schema with `{ $ref: "#" }` (self-reference)
- Execution cell references the schema
- No cycles detected

**✓ $alias resolution works in tests:**
```javascript
aliasCell.setRaw({ counterValue: counterCell.key("count").getAsLink() });
aliasCell.key("counterValue").get(); // ✓ Returns 5 (not $alias object)
```

### Test 3: Pattern Deployment

Created three test patterns:
1. `minimal-cycle-test.tsx` - Uses `generateObject` with `fetchAndRunPattern`
2. `minimal-cycle-test2.tsx` - Directly calls `fetchAndRunPattern`
3. `suggestion-test-copy.tsx` - Copy of the original failing pattern

**Result:** All patterns deployed successfully but showed blank screens in the browser. No link cycle errors were observed in the console.

## Key Findings

1. **Link resolution cycle detection is working correctly** for basic cases
   - Proper circular references (A→B→A) don't trigger false positives
   - True cycles (A→A) are detected and throw errors

2. **The $alias resolution issue is NOT a cycle detection problem**
   - The tests show $alias resolves correctly at the runtime level
   - The issue must be elsewhere in the pattern execution flow

3. **Deployed patterns are not rendering**
   - This suggests a different problem than link cycles
   - Patterns may be failing silently during initialization
   - The issue might be in:
     - Pattern compilation
     - LLM tool call execution
     - UI rendering with dynamic cells
     - Schema transformation during pattern instantiation

## Hypotheses

### Hypothesis 1: Schema Transformation Issue
The recent fix in commit `c6cd932c3` added cycle detection to `recursiveStripAsCellAndStreamFromSchema`. This might be related:
- `fetchAndRunPattern` compiles patterns with `compileAndRun`
- `compileAndRun` uses `compileParams` which includes schema transformation
- If the schema contains circular references (common in recursive patterns), the transformation might:
  - Strip necessary metadata
  - Create malformed schemas
  - Result in $alias objects not being properly resolved

### Hypothesis 2: Timing/Reactivity Issue
- `fetchAndRunPattern` returns before the pattern is fully initialized
- The LLM receives a partial/unresolved cell reference
- By the time the UI tries to render, the cell isn't ready
- This would explain blank screens without errors

### Hypothesis 3: compileAndRun Input Handling
From `common-tools.tsx:228-235`:
```typescript
const compileParams = computed(() => ({
  files: (program?.files ?? []).filter(
    (f) => f !== undefined && f !== null && typeof f.name === "string",
  ),
  main: program?.main ?? "",
  input: args,
}));
```

The `args` passed to `fetchAndRunPattern` might create a circular reference if:
- Args contain Cell references back to the calling pattern
- The compiled pattern's schema references back to its inputs
- This creates a cycle in the dependency graph (not just links)

## Recommendations

1. **Enable detailed logging**
   - Add logging to `fetchAndRunPattern` execution
   - Log when `compileAndRun` starts/completes
   - Log the actual schema being used

2. **Test schema transformation separately**
   - Check if `recursiveStripAsCellAndStreamFromSchema` is over-aggressive
   - Test with self-referential schemas like Record pattern

3. **Check for initialization failures**
   - The blank screen suggests silent failures
   - Add error boundaries or logging to pattern initialization
   - Check if LLM tool calls are completing successfully

4. **Create isolated reproduction**
   - Deploy a simple pattern that uses `compileAndRun` directly
   - Bypass the LLM layer to isolate the issue
   - Test with minimal Counter pattern as input

## Test Files Created

- `/Users/alex/Code/labs-2/test-link-cycle.js` - Basic cycle detection tests
- `/Users/alex/Code/labs-2/test-fetch-and-run-cycle.js` - fetchAndRunPattern simulation
- `/Users/alex/Code/labs-2/packages/patterns/minimal-cycle-test.tsx` - Pattern with generateObject
- `/Users/alex/Code/labs-2/packages/patterns/minimal-cycle-test2.tsx` - Direct fetchAndRunPattern
- `/Users/alex/Code/labs-2/packages/patterns/suggestion-test-copy.tsx` - Copy of failing pattern

## Next Steps

1. Review the `compileAndRun` implementation for schema handling
2. Check if the recent `recursiveStripAsCellAndStreamFromSchema` fix inadvertently broke something
3. Add comprehensive logging to `fetchAndRunPattern` flow
4. Test with simpler patterns that don't use LLMs (bypass generateObject)
5. Check browser devtools for silent JavaScript errors during pattern initialization
