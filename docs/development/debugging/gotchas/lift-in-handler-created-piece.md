# lift() Hop Depth in a Handler-Created Piece (Hypothesis Refuted)

**Status:** This started as a field hypothesis — that a `lift()` consuming a
cell passed through a handler's `navigateTo(...)` resolves at 1 hop (the
created piece's own body) but comes back empty at 2 hops (inside a nested
child pattern the piece instantiates). **Targeted integration tests refute
that hop-depth rule.** Both depths resolve. This doc records the negative
result so the unverified rule does not get reapplied.

**Original symptom (as reported):** a piece opened via
`navigateTo(SomePattern({ someCell, ... }))` from a handler rendered its own
content fine, but a `cf-autocomplete` (or similar) bound to a `lift()` built
one level deeper — inside a nested child pattern — showed no options, while
the same component worked when the screen was reached as a root output. No
console error.

## What the tests show

Two tests reproduce the exact structure — root → handler → create
`Viewer({ items })`, where `Viewer` builds a lift from `items` in its OWN body
(1 hop) AND delegates `items` to a nested `Child` pattern that builds the same
lift (2 hops) — and assert on both lift outputs:

- `packages/runner/test/navigate-handler-lift-hops.test.ts` — uses a **real
  `navigateTo`** chain, captures the navigated-to `Viewer` cell via
  `navigateCallback`, and reads both lift results. Both the 1-hop
  (`ownSummary`) and 2-hop (`child.nestedSummary`) lifts resolve to the seeded
  data, in **both push and pull scheduler modes**.
- `packages/generated-patterns/integration/patterns/handler-created-piece-lift-hops.{pattern,test}.ts`
  — the same structure expressed through the pattern integration harness
  (handler spawns the `Viewer` into a list). Both lift depths resolve.

Each test has been negative-control-checked: flipping the 2-hop expectation to
a wrong value makes the test fail, confirming the assertion really reads the
nested lift's output rather than passing vacuously.

Reproduce:

```sh
# runner-level navigateTo test
cd packages/runner && deno test -A ./test/navigate-handler-lift-hops.test.ts

# integration-harness composition test
cd packages/generated-patterns \
  && deno test -A ./integration/patterns/handler-created-piece-lift-hops.test.ts
```

## So what was the original bug?

The hop-depth framing was a red herring: passing a cell through a handler's
`navigateTo(...)` into a created piece, and then one hop deeper into a nested
child pattern, does **not** by itself break `lift()` resolution. If you hit an
empty `cf-autocomplete` / empty `lift()` in a handler-created piece, look at
the other, *verified* causes instead:

- **Schema-invisible UI** — the created piece's Output type declares the UI
  under a plain `ui:` key instead of the `[UI]` symbol, so the cold-loaded
  piece has no `$UI` to render. See
  [./piece-ui-must-be-vnode.md](./piece-ui-must-be-vnode.md).
- **lift() consuming a cell directly / via closure** — passing a cell straight
  into `lift()` or capturing it through a closure rather than as an explicit
  param. See [./lift-returns-stale-data.md](./lift-returns-stale-data.md) and
  @common/concepts/reactivity.md.
- **Unhydrated `Default<>` / scoped reads** — a render-path read off a scoped
  (`perSession`/`perUser`) cell that is `undefined` until first sync. See
  [./scoped-cell-pitfalls.md](./scoped-cell-pitfalls.md).

If you can produce a minimal pattern where a nested-child lift genuinely comes
back empty while the own-body lift resolves, add it alongside the tests above
so the rule can be re-derived from a real repro rather than a recollection.

## See Also

- ./lift-returns-stale-data.md — verified lift closure/param limitations
- ./piece-ui-must-be-vnode.md — cold-load empty body via schema-invisible `[UI]`
- @common/concepts/reactivity.md
