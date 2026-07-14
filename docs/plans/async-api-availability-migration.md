# Pending Render Continuity And Async API Availability Migration

This plan covers two follow-ups to the
[`DataUnavailable` specification](../specs/data-unavailability.md): the pending
renderer continuity behavior and the staged migration of the remaining
asynchronous APIs. The renderer portion is implemented in the current work;
the API stages remain planned.

The separate [`latestComplete()` plan](./latest-complete.md) is complementary,
not a prerequisite. `resultOf()` exposes the current usable value and propagates
current unavailability; `latestComplete()` will retain a coherent prior value.

## Status

- Pending renderer continuity: implemented and tested.
- Remaining asynchronous API migration: planned; implementation has not
  started.

Keep this file live while any API stage remains. When all stages are complete,
update the DataUnavailable spec and archive this plan under
`docs/history/plans/`.

## Fixed Design Rules

1. A one-result operation has a default public API returning
   `AsyncResult<T>`. Code keeps the request for guards and calls
   `resultOf(request)` for its ordinary `T` view.
2. A stream, dialog, picker, or metadata-bearing operation keeps a state object.
   Each data-bearing result channel uses `AsyncResult<T>`; independent lifecycle,
   control, selection, and audit fields remain explicit.
3. `pending` and `error` fields must not duplicate the availability of the same
   result channel. They remain only when they describe an independent state,
   such as an active dialog turn while a prior presented result is still usable.
4. The durable raw built-in may keep one internal state object. A concise default
   API projects its `.result` field in the builder, as `generateText()` and
   `generateObject()` do today. The projection creates no additional runtime
   node.
5. Existing raw implementation references and persisted state shapes are not
   changed in place without compatibility tests. Old compiled graphs must
   continue to rehydrate while newly compiled code receives the new public
   surface.
6. Every new request replaces a stale result with pending in the same logical
   transition unless the API's contract explicitly retains a prior value. Only
   `latestComplete()` and state machines whose contract says so provide
   last-value continuity.
7. An input marker propagates unchanged. Locally invalid inputs become
   `schema-mismatch`; operational failures become `error`.
8. Transformer-derived result schemas remain the runtime contract. A generic
   result API must inject or forward its concrete TypeScript schema rather than
   adding an unvalidated cast.
9. CFC scope, labels, stale-write guards, request hashes, and post-commit effect
   ordering are preserved across every migration.

## Completed Renderer Contract

The renderer behavior is deliberately narrower than a general suspense cache:

| Previous render | New value | Result |
|---|---|---|
| none | pending | blank |
| usable subtree | pending | retain, dim, mark busy, and make inert |
| retained pending subtree | usable | remove treatment and reconcile |
| any | error, syncing, or schema mismatch | blank unless explicitly guarded |
| any | authored `undefined` | ordinary empty content |
| any | disallowed by render policy | blocked-policy rendering wins |

The retained element carries `data-cf-pending`, `inert`, and `aria-busy`; a
renderer-owned style is installed in the active document or shadow root. Bare
text is retained but has no element to dim or disable. Policy re-evaluation
always uses the current value, including an unavailable marker, so it cannot
resurrect content cleared by an error.

### R0 — Red tests

- [x] Pin initial pending, usable-to-pending retention, recovery, and
      non-pending clearing for worker roots and children.
- [x] Pin legacy renderer behavior and main-thread application of inert/busy
      state.
- [x] Pin policy re-evaluation after an error for roots and children.

### R1 — Renderer implementation

- [x] Reuse ordinary `set-prop` / `remove-prop` worker operations; add no VDOM
      protocol operation.
- [x] Apply the DOM treatment in the main-thread applicator and legacy renderer.
- [x] Install the style once per active document, shadow root, or detached
      container.
- [x] Keep policy checks ahead of pending retention and re-evaluate the current
      availability state on ACL changes.

### R2 — Renderer documentation and validation

- [x] Specify pending-only retention in the DataUnavailable spec and reactivity
      guide.
- [x] Pass focused red/green tests, the full `packages/html` suite, and relevant
      documentation checks.

## API End-State Inventory

| API | Classification | Planned public result contract | Auxiliary state |
|---|---|---|---|
| `fetch*` | one result | `AsyncResult<T>` | implemented |
| `generateText`, `generateObject` | one result | `AsyncResult<T>` | implemented |
| `generateTextStream`, `generateObjectStream` | advanced generation | state with `result: AsyncResult<T>` | partials, messages, grounding |
| `compileAndRun` | one result plus diagnostics | default `AsyncResult<T>`; advanced state variant | structured compiler diagnostics |
| `db.query`, `sqliteQuery` | one result plus optional audit metadata | default `AsyncResult<Row[]>`; advanced state variant | `withheld` count |
| `wish` | discovery and selection state machine | `WishState<T>.result: AsyncResult<T>` | candidates and trusted `[UI]` |
| `llmDialog` | multi-turn state machine | typed presented-result channel when requested | turn activity, controls, pins, tools |
| `streamData` | long-lived multi-result subscription | state with `result: AsyncResult<T>` | connection lifecycle and last connection error |
| legacy `llm` | deprecated state API | no new surface | migrate callers, then remove |

`navigateTo`, `sqliteDatabase`, SQLite writes, and CFC label inspection are not
asynchronous data-result APIs and are outside this migration.

## A0 — Compatibility And Contract Harness

- [ ] Add compile-time fixtures for direct results, advanced state results,
      guards, `resultOf()`, aliases, and namespace imports.
- [ ] Add golden transformed-output fixtures for every generic API whose result
      schema is injected by the transformer.
- [ ] Add raw built-in transition tests which distinguish stored authored
      `undefined` from every `DataUnavailable` reason.
- [ ] Add rehydration fixtures for the currently persisted state object of each
      built-in before changing any producer.
- [ ] Inventory and classify every repository call site as result-only,
      status-aware, metadata-aware, or state-machine control.
- [ ] Decide the compatibility window for old public fields. Keep legacy raw
      fields readable until all repository consumers and rehydration fixtures
      have moved.

**A0 exit:** every API below has an agreed transition table, a red contract test,
and a proven old-state rehydration path.

## A1 — Normalize Advanced Generation State

`generateTextStream()` and `generateObjectStream()` already publish
`result: AsyncResult<T>`. Their public `pending` and `error` fields duplicate
that channel.

- [ ] Migrate repository consumers to `isPending(state.result)`,
      `hasError(state.result)`, and `resultOf(state.result)`.
- [ ] Deprecate the duplicate public fields while retaining persisted legacy
      decoding.
- [ ] Keep `partial`, `messages`, and `groundingSources`; they are independent
      channels, not availability aliases.
- [ ] Verify a new request atomically clears stale partial state and publishes
      pending on the result channel.

**A1 exit:** advanced generation has one authoritative availability channel and
keeps only genuinely auxiliary state beside it.

## A2 — `compileAndRun`

Use one internal advanced state and expose two builder views (working advanced
name: `compileAndRunState`):

```typescript
// Shown for illustration only.
const compileRequest = compileAndRun<Input, Output>({ files, main, input });
const output = resultOf(compileRequest);

const compileState = compileAndRunState<Input, Output>({ files, main, input });
const detailedOutput = resultOf(compileState.result);
```

- [ ] Change the internal `result` channel to `AsyncResult<Output>`.
- [ ] Make the default builder project `.result` without creating another node.
- [ ] Preserve structured diagnostics on the advanced state. Represent the
      primary failure on `result` with `DataUnavailable("error")`; do not keep a
      second authoritative error channel.
- [ ] Define invalid program parameters precisely: schema-invalid input becomes
      `schema-mismatch`; a valid request which cannot compile becomes `error`.
- [ ] Propagate unavailable `files`, `main`, or `input` before invoking the
      compiler.
- [ ] Preserve the live compiled-pattern result link, scope, cancellation,
      request supersession, and structured diagnostic locations.
- [ ] Migrate compiler UIs to the advanced form and result-only call sites to the
      default form.

**A2 exit:** ordinary compilation reads like fetch/generation, while diagnostic
surfaces retain their structured errors without parallel pending semantics.

## A3 — SQLite Queries

Use the same raw query state for concise and metadata-aware views (working names:
`db.queryState` and `sqliteQueryState`):

```typescript
// Shown for illustration only.
const rowsRequest = db.query<Row>(sql, { reactOn: db });
const rows = resultOf(rowsRequest);

const queryState = db.queryState<Row>(sql, {
  reactOn: db,
  readClearance: true,
});
const visibleRows = resultOf(queryState.result);
const withheld = queryState.withheld;
```

- [ ] Change the raw state's result channel to `AsyncResult<Row[]>` and make
      `db.query` / `sqliteQuery` project it.
- [ ] Add the metadata-aware method and free-function views without duplicating
      the query node.
- [ ] Keep `withheld` only as audit metadata for the exact successful result it
      accompanies; clear it atomically when a new request becomes pending or
      fails.
- [ ] Map SQL, provider, CFC ceiling, row-label, decode, and writeback failures to
      `error`; map a typed row-result violation to `schema-mismatch`.
- [ ] Preserve typed row-schema injection for both method and free-function
      forms, including `Cell<T>` rehydration and confidentiality labels.
- [ ] Prove read-clearance per-user scoping, request identity, stale-write
      suppression, and post-commit execution remain unchanged.
- [ ] Migrate call sites which currently use `result ?? []`; ordinary consumers
      use `resultOf`, while consumers of `withheld` use the advanced view.

**A3 exit:** row consumers receive `Row[]` without optional fallbacks, and the
clearance audit remains available through an explicit advanced surface.

## A4 — `wish`

`wish()` is not just a one-result request: candidates and its trusted UI drive
selection and profile creation. Keep `WishState<T>`, but make its resolved data
channel honest:

```typescript
// Shown for illustration only.
const noteWish = wish<Note>({ query: "#note" });
const note = resultOf(noteWish.result);

{hasError(noteWish.result) ? <span>{noteWish.result.error.message}</span> : noteWish}
```

- [ ] Change `WishState<T>.result` from `T | undefined` to `AsyncResult<T>`.
- [ ] Publish pending while discovery inputs or scoped indexes are still
      loading, error for a completed failed resolution, and `T` for the current
      selection.
- [ ] Remove the duplicate `error` field from the new public surface after
      compatibility migration; keep `candidates` and `[UI]` independent.
- [ ] Keep an empty candidates array distinct from an unresolved result. Do not
      use `[]` itself as an availability signal.
- [ ] Preserve current single-match, multi-match, headless, profile-switcher,
      scope, sharing, and result-cell-link behavior.
- [ ] Migrate non-null assertions and optional fallbacks to `resultOf`; explicit
      creation/error UIs guard the original result channel.

**A4 exit:** wish selection remains a state machine, but absence, loading, and
failure no longer collapse into `undefined`.

## A5 — `llmDialog`

Dialog `pending` describes an active turn, not necessarily the availability of
a previously presented structured result. It is therefore not automatically
replaced by `isPending(result)`.

- [ ] Add a typed overload for dialogs with a presented-result schema, yielding
      `result: AsyncResult<T>` and keeping the schema derived from or checked
      against the TypeScript type.
- [ ] Do not manufacture a perpetual pending result for dialogs which do not
      declare or use `presentResult`; their public state omits that channel.
- [ ] Before the first presentation, expose pending while a turn can still
      produce it and error when that attempt fails terminally.
- [ ] After a successful presentation, preserve that result across later active
      turns. The independent turn-activity flag and last-turn failure remain
      explicit rather than overwriting usable presented data.
- [ ] Preserve message append/cancel streams, pins, flattened tools, tool-call
      availability handling, queueing, and CFC attribution.
- [ ] Migrate unsafe `as T | undefined` result casts to the typed channel.

**A5 exit:** structured dialog results are typed and availability-aware without
conflating them with the dialog's multi-turn lifecycle.

## A6 — `streamData`

First replace the current ambiguous `pending` flag with an explicit subscription
contract. The planned state is conceptually:

```typescript
// Shown for illustration only.
type StreamDataState<T> = {
  result: AsyncResult<T>;
  status: "connecting" | "open" | "closed" | "reconnecting" | "error";
  lastError?: Error;
};
```

- [ ] Specify initial connect, first event, successive events, clean end,
      reconnect, request replacement, cancellation, and terminal failure.
- [ ] Publish pending before the first event for a request and publish each event
      as the latest usable `T`.
- [ ] If connection failure occurs before any event, publish result error. If a
      prior event exists, preserve it and report connection failure separately;
      an operational status must not masquerade as loss of known data.
- [ ] Decide and test whether clean end preserves the final event (expected) and
      whether reconnect is automatic before implementing the new state.
- [ ] Add response-status validation, parser/schema mismatch handling, abort
      cleanup, and a defined final decoder flush.
- [ ] Preserve sink outbox ordering, frozen request snapshots, idempotency keys,
      scope, and stale-run guards.

**A6 exit:** stream consumers can distinguish data availability from connection
lifecycle, including failure after a usable event.

## A7 — Legacy `llm`, Cleanup, And Documentation

- [ ] Migrate legacy `llm()` consumers to `generateTextStream()`,
      `generateObjectStream()`, or `llmDialog()` according to which auxiliary
      state they use.
- [ ] Remove the deprecated `llm()` surface only after persisted-pattern and
      import compatibility policy permits it; do not create a second
      DataUnavailable migration for it.
- [ ] Remove compatibility `pending` / `error` fields only after repository and
      rehydration tests no longer require them.
- [ ] Update live capability, wish, SQLite, transformer, and reactivity docs in
      the same stage as each API change.
- [ ] Update the DataUnavailable spec's non-goals and status as stages land.
- [ ] Archive this plan when all stages are complete.

## Execution Protocol And Validation

Each API stage uses red-green testing and small commits:

1. Commit failing compile-time and runtime transition tests.
2. Commit the minimal API, transformer, and runtime implementation which makes
   them green.
3. Commit repository call-site and live-doc migrations separately.
4. Run the focused packages before the broad repository gate.

Minimum validation for every applicable stage:

```sh
deno task check-docs common
deno task check-docs specs
deno task --cwd packages/api test
deno task --cwd packages/ts-transformers test
deno task --cwd packages/schema-generator test
deno task --cwd packages/runner test
deno task --cwd packages/patterns test
deno task check
```

Inspect representative transformed output directly for every builder or method
whose public projection or generic schema injection changes:

```sh
deno task cf check <fixture>.tsx --show-transformed --no-run
```
