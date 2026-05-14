# `onClick={() => stream.send({...})}` inside a `.map()` is sometimes lowered as a `derive(...)` instead of a handler, silently breaking the click

## Summary

In some patterns, the ts-transformer lowers a JSX
`onClick={() => boundFoo.send({...})}` expression into a
`__cfHelpers.derive(...)` call — i.e. it treats the click handler as a reactive
expression that should compute an opaque value, rather than as an event handler
that should be invoked imperatively. The result: clicking the rendered
`<cf-button>` runs the lambda once at lowering time (or not at all) and never
fires the stream `.send`. The pattern's UI looks correct, no console errors are
emitted, and `cf piece inspect` shows the target cell unchanged.

The wrap appears together with hoisting of the handler body to a top-level
`const __cfModuleCallback_N = __cfHardenFn(...)` declaration. Patterns that
produce the inline (non-hoisted) handler shape work correctly.

## Concrete evidence

### Working pattern: `packages/patterns/scoped-group-chat/main-plain-inputs.tsx`

JSX:

```tsx
{
  rooms.map((room) => (
    <cf-tab
      value={room.name}
      selected={selectedRoomValue.name === room.name}
      onClick={() => boundSelectRoom.send({ room })}
    >
      {room.name} · {room.messages.length}
    </cf-tab>
  ));
}
```

`deno task cf check ... --show-transformed` output (excerpted, inline at the
call site):

```ts
((__cf_handler_event, { boundSelectRoom, room }) =>
  boundSelectRoom.send({ room }));
```

→ bare handler. Clicks fire correctly.

### Broken pattern: `packages/patterns/cozy-poll-scoped/main.tsx`

JSX (vote buttons inside `ranked.map((tally) => { ... })`):

```tsx
<cf-button
  onClick={() =>
    boundCastVote.send({
      optionId: oid,        // hoisted const
      voteType: "green",    // string literal
    })}
>
```

`deno task cf check ... --show-transformed` output (hoisted to module scope):

```ts
const __cfModuleCallback_1 = __cfHardenFn(
  (__cf_handler_event, { boundCastVote, oid }) =>
    __cfHelpers.derive(
      inputSchema, // boundCastVote + oid
      { asCell: ["opaque"] }, // output schema — wrong
      { boundCastVote, oid },
      ({ boundCastVote, oid }) =>
        boundCastVote.send({ optionId: oid, voteType: "green" }),
    ),
);
```

→ wrapped in `__cfHelpers.derive(...)`. Click does nothing. Verified end-to-end
by deploying the pattern locally and clicking via Playwright; the stream's
underlying cell (`votes`) remains `[Array(0)]` after the click per
`cf piece inspect`.

## Trigger narrowing — what DOESN'T trigger it

I built a side-by-side repro at
`packages/patterns/scope-bug-lambda-in-map/main.tsx` with five variants:

1. `items.map((item) => <cf-button onClick={...}>...)` — direct property map,
   terse arrow
2. `derived.map((item) => <cf-button onClick={...}>...)` — derive result, terse
   arrow
3. `derived.map((item) => { const id = item.id; return <cf-button onClick={...}>...; })`
   — block body with hoisted const
4. Variant 3 + a nested `derive(...)` inside the map body before the return
5. Three lambdas in the same map body referencing the same captured `iid`,
   including string-literal `step: "single"` / `"double"` in the payload

**None of these trigger the bug.** All five lower to the inline-handler shape.
The repro's `--show-transformed` output contains zero `__cfModuleCallback_*`
declarations.

Cozy-poll-scoped produces **four** `__cfModuleCallback_*` declarations — one per
vote/remove button — all of them wrapped in `__cfHelpers.derive(...)`. Something
about cozy-poll's surrounding context (not yet bisected) is causing the closure
transformer to hoist these lambdas to module scope, and the subsequent lowering
pass wraps the hoisted body in `derive(...)`.

PR #3582
(`fix(ts-transformers): lower property access in module-extracted callbacks`)
cherry-picked locally **does not fix this** — it addresses property access
lowering inside module-extracted callbacks, but the underlying misclassification
(event handler being extracted at all, then wrapped in `derive`) remains.

## Suggested investigation path

The mismatch is between `ClosureTransformer`'s extraction decision and
`PatternCallbackLoweringTransformer`'s treatment of the extracted body. Either:

- The closure transformer should **not** hoist `onClick` arrows that resolve to
  stream `.send` calls; or
- The lowering transformer, when processing a hoisted callback whose body is a
  stream `.send(...)`, should preserve handler semantics rather than wrapping in
  `derive(...)`.

## Repro

```bash
git checkout scoped-cells-cozy-poll      # branch with both patterns
deno task cf check packages/patterns/cozy-poll-scoped/main.tsx --show-transformed | grep __cfModuleCallback   # 4 hits
deno task cf check packages/patterns/scope-bug-lambda-in-map/main.tsx --show-transformed | grep __cfModuleCallback   # 0 hits
```

End-to-end browser repro (requires local dev servers via
`./scripts/restart-local-dev.sh`):

```bash
CF_IDENTITY=./claude.key deno task cf piece new \
  packages/patterns/cozy-poll-scoped/main.tsx \
  --api-url http://localhost:8000 --space cozy-poll-test
# Navigate to the printed URL, click Join → admin UI appears → Add an option → click 🟢 Love it.
# `cf piece inspect --piece <id>` shows votes: [Array(0)] — handler never fired.
```

## Environment

```
deno 2.7.9 (stable)
v8 14.7.173.7-rusty
typescript 5.9.2
branch: scoped-cells-cozy-poll (base 5f125183a + 2 commits on top)
```
