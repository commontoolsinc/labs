---
name: pattern-debug
description: Debug pattern errors systematically
user-invocable: false
---

# Debug Pattern

Use the `cf` skill, or read `skills/cf/SKILL.md`, if debugging deployment or
piece issues.

## Read First

- `docs/development/debugging/workflow.md` - 5-step debugging process
- `docs/development/debugging/README.md` - Error reference matrix
- `docs/common/concepts/reactivity.md` - reactive values, Cell behavior, and
  `.get()` / `.set()` boundaries
- `docs/common/patterns/new-cells.md` - `Writable.of()` and local cell
  initialization rules

## Process

1. **Check TypeScript errors:**
   ```bash
   deno task cf check pattern.tsx --no-run
   ```

2. **Match error to documentation:**
   - Read the error message carefully
   - Check `docs/development/debugging/README.md` for matching errors

3. **Check gotchas:**
   - `docs/development/debugging/gotchas/reactive-reference-outside-context.md`
   - `docs/development/debugging/gotchas/handler-inside-pattern.md`
   - `docs/development/debugging/gotchas/filter-map-find-not-a-function.md`
   - `docs/development/debugging/gotchas/onclick-inside-computed.md`
   - `docs/development/debugging/gotchas/immediate-event-invocation.md`

4. **Simplify to minimal reproduction:**
   - Comment out code until error disappears
   - Add back piece by piece to find root cause

5. **Fix and verify:**
   - Apply fix
   - Run tests to confirm

## Common Issues

**Handler defined inside pattern body:**

- Move handler() to module scope
- Only bind it inside pattern: `onClick={myHandler({ state })}`

**Type errors with Writable/Default:**

- Check if field needs write access → use Writable<>
- Check if field could be undefined → use Default<T, value>

**`Cell.of() only accepts static data`:**

- Do not pass input props, mapped fields, or computed/reactive values into
  `Writable.of()` / `Cell.of()`
- Use an input writable cell directly when the caller owns the state
- For pattern-owned draft state, initialize from a static value and copy from
  input state inside an action or another valid reactive/event context
- See `docs/common/patterns/new-cells.md` and
  `docs/common/concepts/reactivity.md`

**String helper throws, such as `.trim()` / `.replace()` / `.includes()` is not
a function:**

- Treat the value as reactive even if TypeScript's surface type is `string`
- Render the reactive value directly when no derivation is needed
- Move derived labels or branch conditions into `computed()` or another valid
  reactive expression site
- See `docs/common/concepts/reactivity.md` and the debugging matrix

**Action not triggering:**

- Ensure Output type includes action as Stream<void>
- Use .send() not .get() to trigger

**`raw:map` never settles:**

- Inspect `.map()` bodies for event props that invoke streams or writes during
  render, such as `onClick={stream.send(index)}`
- Wrap argument-bearing sends in a callback, such as
  `onClick={() => stream.send(index)}`
- See `docs/development/debugging/gotchas/immediate-event-invocation.md`

**Browser UI stays stale after a write:**

- Do not assume a documented primitive like `.push()` is broken just because
  tests/CLI and browser behavior diverge
- First inspect the actual cell values in browser/runtime tools to confirm
  whether state changed
- If state changed but the UI did not, isolate the rendering/reactivity issue
  with a minimal repro before rewriting the mutation style

**computed() wrapping JSX — conditional rendering broken:**

- Inside `computed()` body, ternaries are plain JS (Writable objects always
  truthy)
- Cell bindings (`$value`, `$checked`) inside `derive()` may get positionally
  mis-resolved
- Fix: use bare JSX ternaries, hoist `computed()` for data only
- See `docs/common/concepts/computed/computed.md`

## Runtime Debugging (browser)

When the pattern compiles but behaves wrong at runtime, use the browser console
utilities. Full reference: `docs/development/debugging/console-commands.md`.

**With agent-browser** (for automated testing):

```bash
# Read piece cell values
agent-browser eval "(async () => {
  const v = await commonfabric.readCell();
  return JSON.stringify(v).slice(0, 500);
})()"

# Inspect VDOM tree
agent-browser eval "(async () => {
  await commonfabric.vdom.dump();
  return 'dumped';
})()"

# Detect non-idempotent computations (UI churning)
agent-browser eval "(async () => {
  const r = await commonfabric.detectNonIdempotent(5000);
  return JSON.stringify({ nonIdempotent: r.nonIdempotent.length, cycles: r.cycles.length });
})()"

# Check for action schema mismatches (handlers doing nothing)
agent-browser eval "JSON.stringify(commonfabric.getLoggerFlagsBreakdown())"
```

When tests or CLI calls succeed but browser-visible UI stays stale:

- inspect the live piece state first
- confirm whether the handler actually wrote the expected value
- only then decide whether the bug is in mutation semantics, rendering, or
  browser harness behavior

**In browser console** (for interactive debugging):

```javascript
// Read cell values
await commonfabric.readCell();
await commonfabric.readArgumentCell({ path: ["items"] });

// Watch values change during interaction
const cancel = commonfabric.subscribeToCell();
// ... interact ... then cancel()

// VDOM tree
await commonfabric.vdom.dump();
commonfabric.vdom.stats();

// Logger counts and timing
commonfabric.getLoggerCountsBreakdown();
commonfabric.getTimingStatsBreakdown();

// Non-idempotent detection
await commonfabric.detectNonIdempotent();
```

## Done When

- Root cause identified
- Error fixed
- Tests pass again
