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

3. **Check recompute.** Via the CLI, `cf set` does not trigger computed
   re-evaluation — run `piece step` first (see
   [cli-debugging](../cli-debugging.md#stale-computed-values-after-cf-set)).

4. **Only then isolate the rendering issue.** If state changed but the UI did
   not, build a minimal repro of the render path (missing `computed()`,
   missing `$` binding — see [reactivity-issues](../reactivity-issues.md))
   instead of changing how the handler writes.

## A Different Staleness: the Page Still Runs Old Code

If what looks stale is *code* rather than data — a redeployed pattern or a
rebuilt runtime that the page seems not to pick up — the reload itself is not
the suspect. The pattern runtime's worker is a dedicated `Worker` owned by the
document, so a reload tears it down and the next load builds a new one from
whatever the page is served.

That "whatever the page is served" is where staleness lives: a service worker
still controlling the page, or an HTTP cache entry, can hand the new document
the old bundle. Clearing the service worker registration and hard-reloading is
the targeted fix. Restarting the browser session (`agent-browser close`, then
reopen) also clears it, by starting from a fresh profile and controller state
rather than by killing a surviving worker.

## See Also

- [console-commands](../console-commands.md) — `readCell`, `subscribeToCell`, agent-browser recipes
