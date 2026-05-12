# CT-1562 investigation: `rooms.map().join()` breaks for cells

**Status:** fixed. Two independent logical errors in
`packages/runner/src/traverse.ts` identified and corrected. Berni's repro now
returns `"alpha: 2\nbeta: 0"` instead of throwing `TypeError`.

The ts-transformers pipeline (and PR #3550 in particular) is innocent — its
output is byte-identical between `main` and the original fix-attempt branch for
the failing fixture. The bug lives entirely in the runtime schema traversal.

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
`{ "0": alpha, "1": beta }` — same numeric keys, but no `.map`. The trigger is
the `anyOf` shape that `Default<[]>` produces: an empty-array branch
(`items: false`) alongside the populated branch. With non-`Default<[]>` arrays
(`Room[]` without the `| Default<[]>` union), the schema is a single
`{type:"array", items:{$ref:Room}}` — no anyOf, no merge, no corruption.

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

## The two logical errors

In `packages/runner/src/traverse.ts` there are two independent defects, both
real, both worth fixing on first principles. Of the two, **only B2 actually
fixes CT-1562 end-to-end**, but B1 is a correctness defect for adjacent cases
and would surface independently in any anyOf where a non-link populated array is
matched against an `items: false` branch.

### B1 — `canBranchMatch` ignores `items: false`

`canBranchMatch` (`traverse.ts:3267`) is the fast-reject step inside the anyOf
loop. For `{ type: "array", items: false }` against `[populated]`, it checked
`resolved.type === "array"` (matches) but skipped the items check entirely, so
the branch falsely "matched" and the traverser then ran per-branch traversal on
the bad branch.

Why this doesn't on its own fix CT-1562: at the call site where the bug
manifests, `doc.value` is `{$alias: …}` (a cell link), not an array.
`canBranchMatch` returns `true` early for link values (line ~3290, by design —
we can't know what the link resolves to without traversing). So the new
`items: false` check is unreachable on this code path.

B1 still matters: it's the right semantic for `canBranchMatch`, and the unit
test (`rejects populated array against items: false`) was RED before fix and
GREEN after. The fix prevents an entire class of false-positive matches that
would otherwise feed bad results into the merge.

### B2 — `mergeAnyOfMatches` corrupts arrays

`mergeAnyOfMatches` (`traverse.ts:637`) merges `matches` from multi-branch anyOf
traversals. The existing object-merge behavior:

```ts
if (matches.length > 1) {
  if (matches.every((v) => isRecord(v))) {
    const unified: Record<string, T> = {};
    for (const match of matches) Object.assign(unified, match);
    return unified;
  }
}
```

Arrays satisfy `isRecord` (`typeof [] === "object" && [] !== null`), so this
fires for two-array matches. `Object.assign({}, [], [alpha, beta])` produces
`{ "0": alpha, "1": beta }` — array-ness is lost. The destructured `rooms` in
the derive callback is this plain object; `.map` is undefined; crash.

**Fix:** add an `Array.isArray`-first branch before the existing object-merge:

```ts
if (matches.every((v) => Array.isArray(v))) {
  return matches.find((m) => m.length > 0) ?? matches[0];
}
```

Returns the populated array (or the first if all empty). Preserves array-ness.
The existing object-merge semantic for actual object branches is untouched.

### Why both got triggered together by CT-1562

CT-1562 hits the path twice: once with `traverseCells=true` (the query path, for
reactive scheduling) and once with `traverseCells=false` (the materialization
path, for the actual derive argument). These two modes use different
`ObjectCreator`s and produce different intermediate results for the two anyOf
branches:

| Mode                  | Branch 1 (`items: false`) | Branch 2 (`items: $ref`) | merge produces            |
| --------------------- | ------------------------- | ------------------------ | ------------------------- |
| `traverseCells=true`  | populated array           | `null`                   | `matches[0]` (good)       |
| `traverseCells=false` | populated array           | populated array          | corrupt `{0:…,1:…}` (bug) |

`canBranchMatch` doesn't help either pass because `doc.value` is a `{$alias}`
link at that call site. The bug surface is `mergeAnyOfMatches`'s array
mishandling, triggered by both branches successfully returning arrays in the
materialization pass.

### Adjacent observations (investigated, no defect)

During the investigation we considered two additional hypotheses; both turned
out to be downstream effects of the above, not independent defects:

- **`traverseWithSchema` apparently accepting `items: false` against a populated
  array in the anyOf path.** The standalone traversal path
  (`SchemaObjectTraverser.traverseArrayWithSchema`) correctly rejects this —
  verified by a new test
  (`rejects populated array when items is false and no
  prefixItems`). The
  "leak" we observed in the anyOf path is an emergent effect of link
  resolution + `traverseCells=false` semantics on a branch that shouldn't have
  been entered in the first place. With B2 catching the merge, this effect is
  benign.

- **"Non-determinism" between two identical traversal calls.** Initially
  observed as `matches=[arr, null]` on the first call and `matches=[arr, arr]`
  on the second. Later traced to the two calls running with different
  `traverseCells` settings (`true` for the query path, `false` for the
  materialize path) — two legitimate but semantically different reads. Not a
  determinism bug; the two reads just disagree about a should-never-match
  branch.

## Test surface

Both fixes have isolated unit tests in `packages/runner/test/traverse.test.ts`:

- **B1**: in the `canBranchMatch` describe block — two new tests,
  `accepts
  empty array against items: false` (baseline) and
  `rejects populated array
  against items: false` (the RED-then-GREEN test for
  the fix).
- **B2**: a new `mergeAnyOfMatches` describe block — six tests covering empty
  matches, single match, the existing object-merge, the two array-preserving
  cases (B2 RED-then-GREEN), and the mixed-type fall-through.
- **B3 baseline**: in `SchemaObjectTraverser array traversal`, two new tests for
  `items: false` (populated → rejects, empty → accepts) confirming the
  standalone traversal path already had correct semantics.

End-to-end repro: `packages/runner/test/patterns-ct1562-key-cell-derive.test.ts`
exercises the full `PatternManager.compilePattern` + `runtime.run` path with
Berni's repro shape (simplified to omit the `[UI]` field, which has a separate
test-harness materialization quirk unrelated to CT-1562).

### Independent confidence in each fix

We verified each fix's independence by selectively reverting:

| State       | `mergeAnyOfMatches` unit tests | `canBranchMatch` unit tests | Full `traverse.test.ts` | CT-1562 in-process | CT-1562 production |
| ----------- | ------------------------------ | --------------------------- | ----------------------- | ------------------ | ------------------ |
| Neither fix | 4/6 pass (B2 cases RED)        | 20/21 pass (B1 case RED)    | 21/22 describe blocks   | RED                | RED                |
| B2 only     | 6/6 pass                       | 20/21 pass (B1 case RED)    | 21/22 describe blocks   | GREEN              | GREEN              |
| B1 only     | 4/6 pass (B2 cases RED)        | 21/21 pass                  | 21/22 describe blocks   | RED                | RED                |
| Both        | 6/6 pass                       | 21/21 pass                  | 22/22 describe blocks   | GREEN              | GREEN              |

Each fix carries its own correctness witness in its own tests. Either can be
reverted without invalidating the other.

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

## Repro fixtures (all committed on this branch)

- `packages/ts-transformers/test/fixtures/closures/local-rebind-map-join-value-site.input.tsx`
  — Berni's repro, `Default<[]>` form. Reproduces the crash on
  `cf piece
  apply` against pre-fix code.
- `packages/ts-transformers/test/fixtures/closures/local-rebind-map-join-no-default.input.tsx`
  — same shape without `Default<[]>`. Confirms the rebind itself is fine.
- `packages/ts-transformers/test/fixtures/closures/ct1562-probe.input.tsx` —
  instrumented probe with `inspectRooms` helper; captured the
  `{ isArray, ctor, keys, … }` evidence above.
- `packages/runner/test/patterns-ct1562-key-cell-derive.test.ts` — in-process
  runtime test (simplified Berni's repro to avoid an unrelated `[UI]`
  test-harness quirk). RED on pre-fix code (scheduler error:
  `TypeError:
  rooms.map is not a function`); GREEN after either fix lands.
