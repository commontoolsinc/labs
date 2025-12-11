# TEST PATTERN: ifElse Executes BOTH Branches

## Claim to Verify

**"ifElse evaluates BOTH branches, not just the 'true' one."**

Source: `community-patterns/community-docs/blessed/reactivity.md`

## Background

The CommonTools scheduler is currently **push-based (eager)**:
- It schedules everything that *could* be needed
- It doesn't know that the output of branch B goes nowhere if condition is false
- Both branches of `ifElse` execute regardless of the condition value

This is counter-intuitive if you're used to JavaScript's `if/else` or ternary operators.

## How This Pattern Tests the Claim

1. A boolean toggle switches between `true` and `false`
2. `ifElse` conditionally renders different buttons based on the condition
3. Each button increments its own counter when clicked
4. Both counters are always visible to show execution history

## Manual Verification Steps

1. **Deploy the pattern** using:
   ```bash
   deno task ct charm new --identity key.json --api-url ... --space test test-ifelse-both-branches.tsx
   ```

2. **Initial state**: Condition should be `FALSE`

3. **Click the toggle button** to switch condition to `TRUE`
   - You should see "True button" appear
   - Click the True button
   - Watch the `True: X` counter increment

4. **Toggle back to FALSE**
   - You should see "False button" appear
   - Click the False button
   - Watch the `False: X` counter increment

5. **Repeat toggling and clicking**
   - Each time you toggle, the appropriate button appears
   - Clicking the button should ALWAYS increment its counter
   - Both counters continue to increment despite only one button being visible at a time

## Expected Behavior

### If the claim is TRUE (both branches execute):
- ✅ The button you click should ALWAYS increment its counter
- ✅ Both True and False counters can increment
- ✅ The hidden branch is still "live" even when not visible
- ✅ This proves both branches are executing/mounted

### If the claim is FALSE (only visible branch executes):
- ❌ Only the visible button would work
- ❌ The hidden branch would not respond to clicks
- ❌ Counter would stay at 0 when branch is not visible

## What the Pattern Shows

- **Condition state**: Current true/false value (toggle with button)
- **Visible branch**: The button shown based on condition
- **Execution counters**: How many times each branch's button was clicked
- **Key insight**: If both counters increment regardless of visibility, both branches are executing

## Technical Implementation

```typescript
{ifElse(
  state.condition,
  <ct-button onClick={incrementTrue({ trueCount: state.trueCount })}>
    True button ({state.trueCount})
  </ct-button>,
  <ct-button onClick={incrementFalse({ falseCount: state.falseCount })}>
    False button ({state.falseCount})
  </ct-button>
)}
```

The pattern uses simple button click handlers to demonstrate that:
- When condition is `true`, the True button is visible
- When condition is `false`, the False button is visible
- **BUT**: Both buttons remain functional regardless of visibility
- This confirms both branches are "alive" even when not displayed

## Workaround for Expensive Operations

From the blessed documentation, if you need to prevent expensive operations (like LLM calls) from running in the hidden branch:

```typescript
// ✅ CORRECT: Use conditional prompt to prevent actual execution
const result = generateObject({
  prompt: condition.get() ? expensivePrompt : "",  // Empty string = no LLM call
  // ... other options
});
```

Don't rely on `ifElse` to prevent execution—use empty/undefined inputs instead.

## Files

- `test-ifelse-both-branches.tsx` - The pattern implementation
- `test-ifelse-both-branches.md` - This documentation (you are here)

## Conclusion

This pattern provides a simple, interactive way to verify that `ifElse` executes both branches by showing that event handlers work in both branches regardless of which one is currently visible.
