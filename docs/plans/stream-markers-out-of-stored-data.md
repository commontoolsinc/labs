# Stream markers out of stored data

**Status:** design draft, not started. Investigated against `main` at
`59e8a2540` (2026-09-15). Line references are to that tree.

**Summary.** A handler's event stream is stored today as a document whose value
is the sentinel `{ "$stream": true }`. That sentinel is the only thing handler
instantiation reads to decide a node is a handler, and a whole repair apparatus
exists to make that read succeed on documents whose setup never wrote it. The
schema already knows which positions are streams — the `Stream<T>` brand
becomes `asCell: ["stream"]` — so the runtime should not need a stored value
to say the same thing. This plan moves stream-ness out of the value and into
three places that are already durable: the link schema the builder emits, the
module's own `wrapper: "handler"` flag, and a `schema` meta on the stream's
document. Handler dispatch becomes structural, the marker-keyed repair
machinery is deleted, and out-of-runtime consumers (FUSE, the shuttle listing,
the state inspector) keep a one-document way to recognize a stream.

The contract change to state up front: **a stream must be declared by schema,
kind, or meta. A bare document can no longer be a stream.**

## What the runtime does today

### The one real producer

- `stream()` creates a kind-`"stream"` cell whose schema is the bare event
  schema with no `asCell` stamp (`runner/src/builder/reactive.ts:81`,
  `runner/src/builder/module.ts:255`).
- `Cell.export()` reports `{ $stream: true }` as that cell's value, purely
  because of its kind (`runner/src/cell.ts:3514`).
- The builder folds the exported value into the derived-internal-cell
  descriptor as `schema.default` (`runner/src/builder/pattern.ts:472`, via
  `schemaWithDefault`).
- Setup seeds that default into the derived document, but only when the
  manifest has no entry for the cell yet (`runner/src/runner.ts:3004`).

Every other writer is hand-rolled: four fields in the llm-dialog builtin
(`runner/src/builtins/llm-dialog.ts:3908`), the CLI test harness
(`cli/lib/test-runner.ts:1369`), and 48 test files that build stream cells
with `setRaw({ $stream: true })`.

### The load-bearing reader

`#resolveJavaScriptStreamLink` (`runner/src/runner.ts:9394`) follows the
`$event` input through write redirects and reads the terminal value. Anything
but the sentinel becomes a "Handler used as lift" failure (`runner.ts:10492`,
`:10902`, `describeHandlerStreamFailure` at `:11806`). Everything downstream
of that failure exists only because of the sentinel:

- `isMissingStreamMarkerFailure` (`runner.ts:11862`) and the cold-start
  nested-piece setup repair keyed on it (`runner.ts:4942`).
- The hot-swap pre-setup pass, whose comment cites the same failure
  (`runner.ts:4470`), and the wave-withdrawal note that names it as the
  failure class a withdrawn setup produces (`runner.ts:4558`).
- The pieces-controller cold-start repair comments
  (`piece/src/ops/pieces-controller.ts:2168`, `:2402`).

### Secondary readers

- `Cell.isStream` (`runner/src/cell.ts:1320`): kind first, then the resolved
  link's schema, then the stored value. The schema branch compares the first
  `asCell` entry with the string `"stream"` (`:1339`), so an object entry
  `{ kind: "stream" }` is not recognized; `runner-utils.ts:164` does this
  correctly through `getAsCellKind`.
- The schema-less query-result proxy returns a stream-kind cell when the value
  is the sentinel (`runner/src/query-result-proxy.ts:349`). Added for the case
  where an unspecified Output type lost stream-ness from the result schema.
- `processDefaultValue` mints an in-memory immutable cell holding the sentinel
  for an `asCell: ["stream"]` default (`runner/src/schema.ts:574`).
- The default-seeding guard skips a default that is the sentinel
  (`runner/src/data-updating.ts:1193`).
- Two build-time checks read `value.$stream` from the in-memory export
  (`runner/src/builder/pattern.ts:390`, `:1053`).
- Out of runtime: `fuse/callables.ts:50`, `fuse/tree-builder.ts:166` and
  `:554`, the shuttle listing's `kindOf` (`cli/lib/shuttle/listing.ts:434`),
  `state-inspector/model.ts:216` and `decode.ts:122`,
  `ui/.../cf-piece-menu.ts:155`. The CLI read guard
  (`cli/lib/piece.ts:4707`) already answers from the link-derived schema
  alone; only its comment still names the sentinel.

### What already knows stream-ness without the value

- The cell kind at construction.
- `asCell: ["stream"]` in a schema. The schema generator emits it from the
  `Stream<T>` brand, and the schema read path mints a stream-kind cell from it
  without reading the value (`runner/src/schema.ts:1622`).
- `wrapper: "handler"` on the module. `handler()` stamps it
  (`builder/module.ts:230`), the serializer keeps it
  (`builder/to-encodable-form.ts:277` spreads every non-function member), the
  runtime already trusts the stored flag at invocation time to split the
  argument into event and context (`runner.ts:10967`), and the builder uses it
  for writer classification (`builder/pattern.ts:840`, `:980`).
- `$kind: "stream"` in anonymous partial causes (`builder/pattern.ts:379`).
- The `result` back-link meta that setup writes onto every derived document
  regardless of value (`runner/src/result-utils.ts:31`, called from
  `runner.ts:2986`). Event auto-start finds the owning piece through it with
  no value read (`runner/src/ensure-piece-running.ts:173`).

## Three design decisions

### 1. Stream-ness rides in the link schema, not the descriptor kind

The descriptor's `kind` field is minted into the entity URI scheme
(`runner/src/link-utils.ts:845`) and compared during manifest matching
(`runner.ts:2971`); changing it re-materializes the cell under a new id.
`EntityKind` is only `"computed"` today. So the stamp goes into the schema,
which is not part of the id: derived-cell ids hash the cause, so existing
spaces keep their identities and need no migration.

Two schemas need the stamp, not one. When a partial-cause alias is bound to a
link, `scopedLinkForPath` prefers the alias's own schema over the descriptor's
(`runner/src/pattern-binding.ts:179`, `:295`), and result-field aliases are
emitted with the cell's sanitized schema (`builder/pattern.ts:509`). So the
builder must stamp `asCell: ["stream"]` on both the descriptor schema and the
alias schema it emits for a stream-kind cell.

Once stamped, every path that reaches the stream through a stored link sees
it: the `$event` sigil in stored node inputs and the result-field redirect both
carry the descriptor/alias schema (manifest links are emitted with
`includeSchema: true` at `runner.ts:2979`), and link resolution copies a
stored redirect's schema onto the resolved link
(`runner/src/link-resolution.ts:722`). `Cell.isStream` already resolves a
content-addressed schema reference before looking for the stamp, so a stamp
that rides as a reference is read the same way.

This bends one convention slightly: `asCell` normally describes the position
that holds a handle, and the handle's own schema is the stripped one. Putting
the stamp on the derived cell's own schema means a schema-carrying `get()` on
that cell returns a handle rather than a value. For a stream, which has no
value, that is the right answer; `Cell.isStream` already honors the stamp on a
resolved link.

### 2. Handler dispatch keys on the module wrapper, not the `$event` key

Keying on `$event` alone is unsafe: the lunch-poll pattern documents a real
trap where an onClick inside a computed-returned VNode mis-lowers so a lift
node ends up with `$event` in its inputs
(`patterns/lunch-poll/main.tsx:1423`). Today only the sentinel read catches
that. Under a `$event`-keyed rule the node would be silently instantiated as a
handler that never fires.

The dispatch rule:

1. `module.wrapper === "handler"` and `$event` present: parse the `$event`
   link and register on it. No value read. Once decision 1 lands, assert that
   the parsed link's schema declares a stream; that still reads nothing.
2. Wrapper is `"handler"` and `$event` absent: throw, the node is malformed.
3. No wrapper and `$event` present: throw with a message naming the
   lift-with-event-input mistake. This replaces every "Handler used as lift"
   variant. The guard at `runner.ts:10492` is unreachable today (the resolver
   always claims a node with `$event`) and becomes the live check here; its
   message must be rewritten.
4. Neither: ordinary action node.

Hand-built handler nodes already carry the wrapper
(`runner/test/ensure-piece-running.test.ts:694`,
`cli/test/piece-verbs.test.ts:103`). The seven misuse tests at
`runner/test/runner.test.ts:1528` through `:1738` omit it deliberately and
bind `$event` to data or a literal; they keep failing, now on the structural
check.

A user-authored lift that legitimately wants an input named `$event` stays
rejected, exactly as today. Rule 3 keeps that restriction on purpose.

### 3. The stream's document stays self-describing through meta

Without the sentinel the derived document holds only the `result` back-link
meta. It is still listed (the memory server's entity page selects current ids
with no value condition, `memory/v2/engine.ts:2188`) and still found by event
auto-start, but a raw-value reader can no longer tell it is a stream without a
cross-document lookup into the owning piece's manifest:

- The state inspector would classify it as `owned-cell` labelled "(lineage)"
  (`state-inspector/model.ts:383`) and the `stream` entity kind would stop
  firing.
- The shuttle listing classifies a position from its materialized value alone
  (`cli/lib/shuttle/listing.ts:434`) and would label every stream a plain
  value. Its own comment says the listing and the CLI read guard must agree
  about which positions are callables; today they agree through the sentinel.
- The FUSE entities view would project an empty owned document.
- The FUSE piece view is mostly fine, because the bridge reads results through
  the pattern's result schema (`piece/src/ops/piece-controller.ts:4990`) and
  its classifier consults the child cell's schema and handle
  (`fuse/cell-bridge.ts:4782`, keeping the entry at `:4787` even when the
  value is undefined). The gap is nested objects: the tree builder's
  value-only walk (`fuse/tree-builder.ts:554`) sees an undefined value and the
  key vanishes from the JSON.

So setup writes a `schema` meta onto the derived stream document, carrying the
stamped stream schema, at the same point it writes the `result` back-link. The
inspector already documents `schema` as a meta path on result cells
(`state-inspector/model.ts:13`), so there is precedent. Meta is never returned
by `get()`, never reaches handler dispatch, and never confuses a schema-less
proxy read. Cost: one extra meta write per stream per setup, in the transaction
that already writes the back-link.

## Stages

Three PRs. The first keeps the value fallback so nothing that still holds a
sentinel breaks; the last removes it.

### Stage 1 — Runner: stop writing, stop needing

- [ ] `Cell.export()` reports `kind` and stops reporting a value for streams.
      The two build-time checks at `builder/pattern.ts:390` and `:1053` switch
      to the exported kind.
- [ ] Builder stamps `asCell: ["stream"]` on the descriptor schema and on the
      alias schema for stream-kind cells, with no `default`.
- [ ] Setup writes a `schema` meta onto each stream's derived document next to
      the `result` back-link (`runner.ts:2986`).
- [ ] Handler dispatch follows decision 2. Delete
      `describeHandlerStreamFailure`, `isMissingStreamMarkerFailure`, the
      throw at `runner.ts:10492`, and the marker-keyed trigger in the
      cold-start repair (`runner.ts:4942`). Keep the setup passes themselves;
      they still materialize the manifest and argument defaults. Rewrite the
      `runner.ts:10492` guard message and the comments at `:4470` and `:4558`.
- [ ] Remove the four hand-written sentinels in llm-dialog and confirm its
      result schema marks those fields as streams.
- [ ] `processDefaultValue` mints a stream-kind cell instead of a sentinel
      cell (`schema.ts:574`). The guard at `data-updating.ts:1193` becomes
      dead; remove it.
- [ ] `Cell.isStream` goes through `getAsCellKind` so object `asCell` entries
      are recognized. Keep its value fallback for now.
- [ ] The query-result proxy tests the resolved link's schema before the value
      (`query-result-proxy.ts:349`). Keep its value fallback for now.
- [ ] Regression test: forward a stream into a sub-pattern through `.map`, the
      case that added the proxy fallback and that `sidebar.tsx:84` still works
      around. Under this design it works only because the stored alias link
      carries the stamp.

### Stage 2 — Consumers, tests, docs

- [ ] State inspector: classify a document as `stream` when its `schema` meta
      declares one; keep the value check until stage 3.
- [ ] Shuttle listing: `kindOf` takes the schema alongside the value, from
      the same link-derived cell the CLI read guard already uses, so the two
      keep agreeing once the sentinel is gone.
- [ ] FUSE: read the `schema` meta in the entity projection; thread the
      schema-aware `classifyCallableEntry` into the tree builder's nested walk
      (`tree-builder.ts:554`) so nested streams stop vanishing;
      `callables.ts:50` gains a schema branch.
- [ ] CLI read guard: already schema-only; update the comment at
      `cli/lib/piece.ts:4694`.
- [ ] Piece menu: already schema-first with a parent-schema fallback
      (`cf-piece-menu.ts:1851`); remove `isRawStreamMarker`.
- [ ] Test fixtures: the 48 files that build streams with `setRaw` switch to
      `runtime.getCell(space, cause, { asCell: ["stream"] })` or an explicit
      kind. The CLI test harness (`test-runner.ts:1369`) likewise.
      `nested-piece-setup-repair.test.ts` and the failure-message tests go
      away with the machinery.
- [ ] Docs. Six live documents describe the sentinel:
      `docs/specs/space-model/1-data-model.md` (`:138`, `:296`, `:719`,
      `:904`), `2-storage-format.md` (`:30`, `:70`, `:95`), `4-cells.md`
      (`:71`, `:154`), `7-schemas.md` (`:56`),
      `docs/specs/pattern-construction/rollout-plan.md` (`:138`),
      `docs/plans/pattern-verb-contract.md` (`:412`). The formal spec proposes
      keeping the sentinel under a `{ "/Stream@1": null }` encoding
      (`space-model-formal-spec/1-fabric-values.md:3794`, and the two blocks
      at `1-data-model.md:737` and `:774`); those need to say the encoding is
      retired, not renamed.

### Stage 3 — Remove the fallback

- [ ] Delete the value branch in `Cell.isStream`, the proxy's value check, the
      inspector's value check, and `isStreamValue` in
      `runner/src/builder/types.ts` (and its re-export, which the shuttle
      listing imports).
- [ ] Confirm no `$stream` remains outside `docs/history/`.

Stage 3 can ship once every space that matters has had a setup pass under
stage 1, which re-emits manifest links with stamped schemas. Documents that
still hold a sentinel are harmless after stage 3: the value is ignored, and
nothing reads it.

## Testing

- Every handler node in `runner/test` instantiates with no value at its
  `$event` target. Assert the derived document holds no value after setup.
- The seven misuse tests at `runner.test.ts:1528` onward keep failing, with
  the new message.
- A lift whose inputs carry `$event` fails at instantiation with the
  lift-with-event-input message (the lunch-poll trap, pinned as a unit test).
- `ensurePieceRunning` still auto-starts a piece from an event sent to a
  stream document that has only meta.
- The `.map`-into-sub-pattern regression test above.
- State inspector fixtures: a meta-only stream document classifies as
  `stream`.
- Shuttle listing: a stream position lists as `callable` with no sentinel
  stored.
- FUSE: a nested stream two levels down a result appears as
  `{"/handler": key}` and gets a `.handlers` script.

## Risks

- **Alias schema override.** If only the descriptor schema is stamped,
  everything still works for handler dispatch (decision 2 does not need the
  schema) but `send()` through a schema-less result read regresses to a value
  write. The regression test in stage 1 exists for this.
- **Root-level `asCell` on the derived cell's own schema.** Any code that calls
  `get()` on a derived stream cell with its own schema now gets a handle back.
  Audit `getDerivedInternalCell` callers; today none read a stream's value.
- **Unstamped stored links during transition.** Pieces whose last setup ran
  before stage 1 carry unstamped manifest links until their next setup pass.
  The retained value fallback covers them; that is why stage 3 waits.
- **The `.map` sub-pattern case.** The proxy fallback was added for it, and the
  sidebar pattern still documents the failure. Do not remove the fallback
  before the regression test is green.
- **Setup withdrawal on the ON arm.** The hot-swap path notes that a v2 graph
  running against a withdrawn setup fails as "Handler used as lift"
  (`runner.ts:4558`). Under decision 2 that graph would instead register
  handlers on links whose documents were never materialized. Confirm the
  withdrawal path still keeps the old graph running, which is what makes the
  state coherent, rather than relying on the instantiation failure.

## Not in scope

- Unifying streams with value cells, which `2-storage-format.md:95` floats.
- Changing derived-cell identity or the manifest format.
- Allowing a lift to take an input named `$event`.
- The formal spec's wider encoding work; this plan only retires one row of its
  table.
