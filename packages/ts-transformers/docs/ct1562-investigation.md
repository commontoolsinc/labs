# CT-1562 investigation: `rooms.map().join()` breaks for cells

**Status:** root cause located in the data-model schema-traversal layer. The
ts-transformers pipeline (and PR #3550 in particular) is innocent — its output
is byte-identical between `main` and our branch for the failing fixture.

## Berni's report

> Bug: plain reactive property access can lower to a cell in one expression site
> and then be used as a plain value elsewhere.
>
> ```tsx
> export interface Room {
>   name: string;
>   messages: ChatMessage[] | Default<[]>;
> }
> export interface Conversation {
>   rooms: Room[] | Default<[]>;
> }
> export default pattern<Input, Output>(({ conversation }) => {
>   const rooms = conversation.rooms;
>   const roomSummaryText = rooms
>     .map((room) => `${room.name}: ${room.messages.length}`)
>     .join("\n");
>   return {
>     [UI]: (
>       <cf-tab-list>
>         {rooms.map((room) => <cf-tab>{room.name}</cf-tab>)}
>       </cf-tab-list>
>     ),
>     roomSummaryText,
>   };
> });
> ```
>
> Runtime: `TypeError: rooms.map is not a function`.

## What's actually happening

The ts-transformers lowering emits, **correctly**:

```js
const rooms = conversation.key("rooms"); // Cell<Room[]>
const roomSummaryText = __cfHelpers.derive(
  /* argumentSchema */ {
    type: "object",
    properties: {
      rooms: {
        anyOf: [
          { type: "array", items: false }, // Default<[]> branch
          { type: "array", items: { $ref: "#/$defs/Room" } },
        ],
      },
    },
    required: ["rooms"],
    $defs: { Room: {/* ... */} },
  },
  /* resultSchema */ { type: "string" },
  /* inputs */ { rooms: rooms },
  /* callback */ ({ rooms }) =>
    rooms.map((room) => `${room.name}: …`).join("\n"),
);
```

The schema says "rooms is an array of Room" — no `asCell`. The runtime should
materialize `rooms` as a plain array before calling the callback. **It does
not.** The destructured `rooms` arrives as a plain object
`{ "0": alpha, "1": beta }` — same numeric keys, but no `.map`.

### Direct evidence (instrumented probe)

A fixture identical to Berni's repro, but with the failing `rooms.map().join()`
replaced by `inspectRooms(rooms)` (a module-scope helper that introspects
`rooms`), deployed via `cf piece new` and run via `cf piece apply`, prints:

```
CT1562_PROBE: {
  "type": "object",
  "isArray": false,
  "ctor": "Object",
  "keys": ["0", "1"],
  "hasMap": false,
  "proto": "Object",
  "mappedOk": false,
  "mapError": "TypeError: r.map is not a function"
}
```

When the same probe runs against the **no-`Default<[]>`** version of the
fixture, `rooms` arrives as a real `Array`:

```
CT1562_PROBE: {
  "type": "object",
  "isArray": true,
  "ctor": "Array",
  "keys": ["0", "1"],
  "hasMap": true,
  "len": 2,
  "mappedOk": true,
  "mapped": ["alpha: 2", "beta: 0"]
}
```

**Conclusion:** `Default<[]>` on an array-typed field is the trigger. The
`anyOf` schema it produces is the proximal cause.

## Why the `anyOf` is the trigger

In `packages/runner/src/traverse.ts`:

1. `canBranchMatch` (line ~3267) decides which `anyOf` branches "match" the
   actual value. For `{ type: "array", items: false }` against a populated
   array, it checks `resolved.type === "array"` (matches!) and skips the items
   check — `items: false` is ignored. So **both** branches return `true`, even
   though only the populated branch is semantically valid.

2. The traverser then calls `traverseWithSchema` for each matching branch and
   collects results into `matches`. Both branches likely produce an array result
   (one empty-ish, one populated).

3. `mergeAnyOfMatches` (line ~637):

   ```ts
   if (matches.length > 1) {
     if (matches.every((v) => isRecord(v))) {
       const unified: Record<string, T> = {};
       for (const match of matches) {
         Object.assign(unified, match);
       }
       return unified;
     }
   }
   ```

   Arrays satisfy `isRecord` (`typeof [] === "object" && [] !== null`), so this
   branch fires. `Object.assign({}, [], [alpha, beta])` returns
   `{ "0": alpha, "1": beta }` — array-ness is **lost**. The destructured
   `rooms` in the derive callback is this plain object.

## Why the trusted-builder runtime tests don't catch this

In the `runtime.run(tx, pattern, …)` test harness (used by the unit-test suites
in `packages/runner/test/patterns-*.test.ts`), the action callback goes through
a path that produces a different argument shape. I built a runtime test
mirroring the exact lowered shape and it **passed**:

> `packages/runner/test/patterns-ct1562-key-cell-derive.test.ts` (provisional,
> not committed)

The repro requires the deployed (SES sandboxed) path:

```bash
deno task cf piece new <fixture>.tsx -s ct1562-test
echo '{"conversation": {"rooms": [...]}}' | deno task cf piece apply --piece <id> -s ct1562-test
# TypeError: rooms.map is not a function
```

So adding a runner unit test against the trusted builder will not catch
regressions in the schema-traversal merge. Tests that exercise this bug need to
go through `runtime.patternManager.compilePattern(...)` plus deploy-style
invocation, OR exercise `validateAndTransform` directly with the offending
`anyOf` schema and asserted output shape.

## Two fix candidates

### Candidate A — `mergeAnyOfMatches` (narrow, recommended)

Add an array-aware branch in `packages/runner/src/traverse.ts:637`:

```ts
if (matches.length > 1) {
  if (matches.every(Array.isArray)) {
    // Pick the populated one, or the first if both are non-empty.
    return matches.find((m) => m.length > 0) ?? matches[0];
  }
  if (matches.every((v) => isRecord(v))) { /* existing object-merge */ }
}
```

Rationale: the `Object.assign` merge is a deliberate semantic for object
branches — different branches contributing different properties — and shouldn't
apply to arrays at all. The current behavior silently corrupts every `anyOf`
whose branches all produce arrays; no usage I'm aware of relies on it.

### Candidate B — `canBranchMatch` honoring `items: false`

In `packages/runner/src/traverse.ts:3267`, after the existing `type` check, add:

```ts
// items: false → only the empty array matches.
if (
  resolved.type === "array" && resolved.items === false && Array.isArray(value)
) {
  if (value.length > 0) return false;
}
```

This addresses the **upstream** cause: with this in place, only the populated
branch matches a populated array, and `mergeAnyOfMatches` sees a single match —
no merge happens, and the array passes through untouched.

Riskier than Candidate A because it changes branch-matching semantics that other
code paths may rely on. Worth doing eventually, but probably not as the first
fix.

### Recommendation

Land Candidate A first as the focused fix with a regression test that deploys
via the full pipeline (or invokes `validateAndTransform` directly). Track
Candidate B as a follow-up if there's appetite for tightening anyOf semantics
broadly.

## Test population

The following pattern fixtures in `packages/patterns/` use the
`SomeType[] | Default<[]>` idiom and route through value-site derives, making
them candidate exposures for this bug:

- `packages/patterns/deep-research.tsx` —
  `messages?: Writable<Array<BuiltInLLMMessage> | Default<[]>>`
- `packages/patterns/location-track.tsx` —
  `locations: LocationPoint[] | Default<[]>`
- `packages/patterns/render-test.tsx` — `subItems: SubItem[] | Default<[]>`,
  `items: Item[] | Default<[]>`
- `packages/patterns/tags.tsx` — `tags: string[] | Default<[]>`
- `packages/patterns/occurrence-tracker.tsx` —
  `occurrences: Writable<Occurrence[] | Default<[]>>`
- `packages/patterns/record.tsx` — multiple `…[] | Default<[]>` fields

Pieces that read these fields in a value-site `.map`/`.filter`/`.reduce` without
an explicit unwrap will hit the same crash.

## Repro fixtures (committed on this branch, not yet in CI)

- `packages/ts-transformers/test/fixtures/closures/local-rebind-map-join-value-site.input.tsx`
  — Berni's repro, `Default<[]>` form, reproduces the crash on `cf piece apply`.
- `packages/ts-transformers/test/fixtures/closures/local-rebind-map-join-no-default.input.tsx`
  — same shape without `Default<[]>`, **works** on `cf piece apply`.
- `packages/ts-transformers/test/fixtures/closures/ct1562-probe.input.tsx` —
  instrumented probe with `inspectRooms` helper; used to capture the
  `{ isArray, ctor, keys, … }` evidence above.
- `packages/runner/test/patterns-ct1562-key-cell-derive.test.ts` — provisional
  in-process runtime test (passes incorrectly; useful as a record of what the
  trusted-builder path does for the same shape).

None of these are committed yet — open question whether to land them as-is, fold
them into the fix PR, or discard.
