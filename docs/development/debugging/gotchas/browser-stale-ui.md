# Browser UI Stale After a Handler Write

**Symptom:** A handler ran (button clicked, test passed, CLI call succeeded)
but the browser UI doesn't reflect the change. It's tempting to conclude the
write itself failed — e.g. "`.push()` must be broken" — and rewrite the
mutation style. Don't.

**Diagnose in this order:**

1. **Inspect the actual cell state first.** In the browser console (or via
   `agent-browser eval`):

   ```javascript
   // Shown inside a pattern body.
   await commonfabric.readCell()                       // piece output
   await commonfabric.readArgumentCell({ path: ["items"] })  // piece input
   ```

   If the expected value is there, the write worked — the bug is in
   rendering/reactivity, not mutation semantics.

2. **Check you're reading the same piece and space the UI shows.** `readCell`
   defaults to the piece ID and space from the URL bar; a handler may have
   written to a different piece (or the UI may be rendering a different
   instance) than the one you're inspecting.

3. **Check recompute.** Via the CLI, `piece set` does not trigger computed
   re-evaluation — run `piece step` first (see
   [cli-debugging](../cli-debugging.md#stale-computed-values-after-piece-set)).

4. **Only then isolate the rendering issue.** If state changed but the UI did
   not, build a minimal repro of the render path (missing `computed()`,
   missing `$` binding — see [reactivity-issues](../reactivity-issues.md))
   instead of changing how the handler writes.

## See Also

- [console-commands](../console-commands.md) — `readCell`, `subscribeToCell`, agent-browser recipes
