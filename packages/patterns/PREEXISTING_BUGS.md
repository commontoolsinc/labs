# Pre-existing Pattern Bugs

Found during pattern library rationalization (Dec 2025). These are runtime
issues, not API migration problems.

---

## Bug 1: compiler.tsx - Navigation Button Not Working

**Symptom:** "Navigate To Piece" button appears after compilation succeeds, but
clicking it does nothing.

**Suspected Cause:** The `visit` handler calls `navigateTo(result)` but the
result cell may not be ready when the button is shown.

**Impact:** Core functionality broken - can compile but can't navigate to the
compiled piece.

**Repro:**

```bash
deno task ct piece new packages/patterns/compiler.tsx \
  -i claude.key -a http://localhost:8000 -s test-space
# Enter valid pattern code, compile succeeds
# Click "Navigate To Piece" button - nothing happens
```

---

## Bug 3: suggestion.tsx / suggestion-test.tsx - $alias Not Resolving

**Symptom:** When Suggestion pattern returns a Counter or other pattern via
`fetchAndRunPattern`, cell values show as raw `$alias` objects instead of
resolved values.

**Example Output:** Shows `"Counter is the {"$alias":...} number"` instead of
the actual count.

**Suspected Cause:** Issue with how patterns are dynamically instantiated
through the LLM tool call flow in `fetchAndRunPattern`.

**Impact:** Suggestion pattern doesn't work correctly - dynamic pattern values
not displayed.

**Note:** A related null-check bug was fixed in `compile-and-run.ts:182`
(`file?.name` instead of `file.name`) but the core $alias issue remains.

**Repro:**

```bash
deno task ct piece new packages/patterns/suggestion-test.tsx \
  -i claude.key -a http://localhost:8000 -s test-space
# Ask it to create a Counter
# Counter value shows as $alias object instead of number
```

---

## Recommendation

These patterns demonstrate advanced features (wish dependencies, dynamic
compilation, LLM tool calls) that have edge cases. Options:

1. **Fix the bugs** - Investigate root causes in runtime
2. **Add dependency checks** - Patterns should gracefully handle missing
   dependencies
3. **Deprecate** - If features are not actively maintained
