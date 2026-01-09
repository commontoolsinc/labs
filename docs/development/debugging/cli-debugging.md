# CLI-Based Debugging

When patterns misbehave, the CLI often provides faster diagnosis than browser DevTools. This approach isolates data logic from UI rendering issues.

## When to Use CLI vs Browser

**Use CLI when:**
- Data transformations produce wrong results
- Computed values don't update as expected
- Handlers don't modify state correctly
- You need to test specific input combinations
- Debugging reactivity chains

**Use Browser when:**
- UI doesn't render correctly
- Bidirectional binding issues (visual symptoms)
- Visual/styling problems
- Event handling doesn't trigger (click handlers, etc.)

## Stale Computed Values After `charm set`

**Gotcha:** `charm set` updates data but does NOT trigger computed re-evaluation. You must run `charm step` after `set` to get fresh computed values.

```bash
# WRONG: Returns stale computed values
echo '[...]' | deno task ct charm set --charm ID expenses ...
deno task ct charm get --charm ID totalSpent ...  # May return old value!

# CORRECT: Run charm step to trigger recompute
echo '[...]' | deno task ct charm set --charm ID expenses ...
deno task ct charm step --charm ID ...  # Runs scheduling step, triggers recompute
deno task ct charm get --charm ID totalSpent ...  # Now correct
```

## Quick Diagnostic Sequence

```bash
# 1. What's the full state?
deno task ct charm inspect --charm <charm-id> -i claude.key -a URL -s space

# 2. What are the inputs?
deno task ct charm get --charm <charm-id> /input -i claude.key -a URL -s space

# 3. What's a specific computed value?
deno task ct charm get --charm <charm-id> myComputedField -i claude.key -a URL -s space

# 4. Set known input, trigger recompute, verify output
echo '{"items":[{"title":"test","done":false}]}' | \
  deno task ct charm set --charm <charm-id> /input -i claude.key -a URL -s space
deno task ct charm step --charm <charm-id> -i claude.key -a URL -s space
deno task ct charm get --charm <charm-id> itemCount -i claude.key -a URL -s space
```

## Common CLI Debugging Patterns

**"Computed value is stale":**
1. Set input via CLI
2. **Run `charm step` to trigger re-evaluation**
3. Get computed value via CLI
4. If CLI shows correct value but browser doesn't - issue is UI layer
5. If CLI shows wrong value - issue is in computed logic

**"Handler doesn't work":**
1. Inspect state before calling handler
2. Call handler via CLI with test payload
3. Inspect state after
4. Compare to see if state changed as expected

**"Don't know what data structure to expect":**
1. Deploy minimal pattern
2. `charm inspect` shows actual runtime structure
3. Use this to understand Cell wrapping, array shapes, etc.

**"Filtering/sorting not working":**
1. Set test data with known values via CLI
2. Get the filtered/sorted computed value
3. Verify the transformation logic in isolation

## The setsrc Workflow for Debugging

When iterating on fixes, always use `setsrc` instead of `new`:

```bash
# Make a fix to your pattern, then:
deno task ct charm setsrc --charm <charm-id> pattern.tsx -i claude.key -a URL -s space

# Test again
deno task ct charm get --charm <charm-id> brokenField -i claude.key -a URL -s space
```

This keeps you working with the same charm instance, preserving any test data you've set up.

## See Also

- ./testing.md - Local and deployed testing workflows
- ./workflow.md - General debugging workflow
