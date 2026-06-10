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
- `docs/common/concepts/reactivity.md` and `docs/common/patterns/new-cells.md` —
  as mandated by pattern-dev; re-consult for Cell, Writable, or reactive-value
  failures

## Process

1. **Check TypeScript errors:**
   ```bash
   deno task cf check pattern.tsx --no-run
   ```

2. **Match error to documentation:**
   - Read the error message carefully
   - Check `docs/development/debugging/README.md` for matching errors

3. **Check gotchas:**
   - `docs/development/debugging/gotchas/quick.md` - consolidated quick gotchas,
     one anchor per error (e.g. `#filter-map-find-is-not-a-function`,
     `#onclick-inside-computed`)
   - `docs/development/debugging/gotchas/reactive-reference-outside-context.md`
   - `docs/development/debugging/gotchas/handler-inside-pattern.md`
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

**`new Cell() only accepts static data`:**

- A reactive value (input prop, mapped field, computed value) was passed into
  `new Writable()` / `new Cell()`. See the static-only rule and field-decision
  guidance in the pattern-implement skill, plus
  `docs/common/patterns/new-cells.md`

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
- Cell bindings (`$value`, `$checked`) inside `computed()` may get positionally
  mis-resolved
- Fix: use bare JSX ternaries, hoist `computed()` for data only
- See `docs/common/concepts/computed/computed.md`

**Transient UI state carries over when it should not:**

- Check whether navigation, active tab, selected item, modal, filter, or other
  ephemeral UI state is unscoped or space scoped, then apply the PerSession
  new-tab test from the pattern-dev skill (`PerSession<>` for per-session UI
  state, `PerUser<>` for user-owned durable state).
- Confirm the generated schema and transformed source with
  `deno task cf check pattern.tsx --show-transformed`.
- If a value unexpectedly becomes `undefined`, check for schema-scope traversal
  restrictions: a narrower linked value may be unavailable to a broader declared
  schema.
- Scope is data scoping, not authorization; do not use it as a replacement for
  CFC/IFC policy.

**`PerAny<>` used to fix a scope issue:**

- Treat `PerAny<>` as a rare inner override under an outer `Per*` declaration,
  not as a fourth default scope.
- Prefer the concrete inner scope when known:
  `PerSession<{ item: PerUser<Item>; attachment: PerAny<Attachment> }>` is valid
  when attachments intentionally may come from any scope.
- If the inner scope is known, use `PerSpace<>`, `PerUser<>`, or `PerSession<>`
  instead.

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
- inspect raw links or transformed schema when the bug could be a scope mismatch
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
- Tests pass again — or, if no tests exist yet, `deno task cf check` succeeds
  and the failing repro behaves correctly
