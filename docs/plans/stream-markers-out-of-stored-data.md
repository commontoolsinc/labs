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
sentinel breaks; the last removes it. Stage 1 landed as #7583 and stage 2 as
#7589, stacked on it; where either stage did something other than what the
list below first said, the item says what happened and why.

### Stage 1 — Runner: stop writing, stop needing (#7583)

- [x] `Cell.export()` reports `kind` and stops reporting a value for streams.
      The two build-time checks at `builder/pattern.ts:390` and `:1053` switch
      to the exported kind.
- [x] Builder stamps `asCell: ["stream"]` on the descriptor schema and on the
      alias schema for stream-kind cells, with no `default`. The stamp goes in
      front of an `asCell` the schema already carries (`["opaque"]` on a
      stream's own schema) rather than replacing it.
- [x] Setup writes a `schema` meta onto each stream's derived document next to
      the `result` back-link (`runner.ts:2986`). It is written in the stored
      spelling, so with content-addressed schemas on it is a `cid:` reference
      and the declaration lives in the schema document it names; a raw-storage
      reader follows one reference, not none.
- [x] Handler dispatch follows decision 2. `describeHandlerStreamFailure`,
      `isMissingStreamMarkerFailure` and the `runner.ts:10492` throw are gone,
      and a lift binding `$event` is refused by name. The cold-start repairs
      stay, on structural triggers rather than the marker: a nested piece
      repairs when its setup marker names another version and its manifest
      lacks one of the pattern's internal cells, and the controller refuses a
      stopped root whose marker names another version and hands it to the
      existing repair (`Runner.isRunning()` keeps a running root out of it).
      Deleting the repairs outright regressed nested pieces, which came up
      with no result aliases. `nested-piece-setup-repair.test.ts` therefore
      stays, rewritten for the structural trigger.
- [x] Remove the four hand-written sentinels in llm-dialog and confirm its
      result schema marks those fields as streams.
- [x] `processDefaultValue` mints a stream-kind cell instead of a sentinel
      cell (`schema.ts:574`). The guard at `data-updating.ts:1193` becomes
      dead; remove it.
- [x] `Cell.isStream` goes through `getAsCellKind` so object `asCell` entries
      are recognized. Keep its value fallback for now.
- [x] The query-result proxy tests the resolved link's schema before the value
      (`query-result-proxy.ts:349`). Keep its value fallback for now.
- [x] Regression test: forward a stream into a sub-pattern through `.map`, the
      case that added the proxy fallback and that `sidebar.tsx:84` still works
      around. Under this design it works only because the stored alias link
      carries the stamp.
- [x] Not foreseen: every read path treats a declared stream position as a
      handle whether or not the data names it — the eager traversal, the
      schema view, the defaults path — with `required` checks exempting such
      positions, since a required stream field with nothing stored otherwise
      collapsed the read. A stream handle written into data carries the
      declaration on its link, decided by the handle's kind with nothing read
      (a value read there taints the write, which the CFC tests caught). Link
      resolution keeps a stored schema that is only an `asCell` stamp instead
      of discarding it as unconstraining, and the family-presence probes read
      the document record rather than its value.

### Stage 2 — Consumers, tests, docs (#7589)

- [x] State inspector: classify a document as `stream` when its `schema` meta
      declares one; keep the value check until stage 3. Because the meta can
      be a `cid:` reference, `classifyDocument` takes a document reader and
      follows it into the schema document; every classification site hands
      one over, and the detail view shows the referenced schema and names the
      document it came from.
- [x] Shuttle listing: a key is a `callable` off the child's link-derived
      schema, the same signal the CLI read guard refuses on, through a new
      `listCallableKeys` read (`cli/lib/piece.ts`) that runs beside the value
      read and fails open the way the guard does. The listing skips it for a
      keyless cell. A position still reading as the sentinel counts as a
      callable until stage 3.
- [x] FUSE, in part. `classifyCallableEntry` takes a schema that declares a
      stream as a handler whatever stands at the position; the bridge's
      callable discovery asks the child cell itself as a last resort, the way
      the CLI's `detectCallableKind` already did; and a nested `.json` sibling
      shows a stream handle as `{ "/handler": key }` instead of the handle's
      own JSON, at every depth. Not done, and not blocking stage 3: nested
      `.handler` scripts (the bridge's callable discovery is root-only, and a
      nested script needs a path-addressed `cf exec`), and the `entities/`
      projection of a bare stream document, which `#materializeTreeValue`
      already leaves empty rather than failing. Both are follow-ups if anyone
      wants them.
- [x] CLI read guard: already schema-only; update the comment at
      `cli/lib/piece.ts:4694`.
- [x] Piece menu: already schema-first with a parent-schema fallback
      (`cf-piece-menu.ts:1851`); remove `isRawStreamMarker`.
- [x] Test fixtures, in part. Every fixture that built a stream through a real
      runtime now declares it — `runtime.getCell(space, cause, { asCell:
      ["stream"] })` for a handle, `schema: { asCell: ["stream"] }` on a
      hand-built descriptor or alias — and stores nothing; a declared stream
      argument is passed as `{}`. The served-execution fixtures
      (`executor-events-down`, `executor-space-server`) write the schema meta
      the way setup does, since their durable appends land on the stream's
      document, and their serving-side handles declare the stream too, since
      a send decides stream-or-write off the handle. The CLI test harness
      (`test-runner.ts`) likewise. Pure fakes that answer the sentinel from
      `getRaw` are deferred to stage 3 (see there): they exercise the value
      fallback that stage removes, and would be rewritten twice otherwise.
- [x] Docs. The six live documents and the formal spec's encoding table now
      describe the declaration, and the formal spec says the marker is retired
      rather than renamed to `/Stream@1`. The builder README and the lunch-poll
      deploy guide follow. Comments in pattern sources (`sidebar.tsx`,
      `gideon-tests`, `gmail-agentic-search.tsx`) still mention the marker:
      editing a pattern's source changes its identity, so they are left alone.
- [x] Not foreseen: a stream declared through a `$ref` into the schema's own
      `$defs`, or through a composition whose branches agree (`allOf` with
      plain constraints beside it, a uniform `anyOf`/`oneOf`), was not a
      declared stream to `Cell.isStream`, which read only a root `asCell`; the
      stored sentinel had been carrying those sends. The piece controller
      already localized such declarations for validation.
      `ContextualFlowControl.declaredHandleKind` reads the kind through a
      local `$ref` and through agreeing branches — `allOf` declares what any
      branch declares, `anyOf`/`oneOf` what every branch declares — and
      `declaresStream`, `Cell.isStream` and the proxy decide from it. The
      local lookup is quiet on a miss, because the CLI test harness counts a
      logged warning as a failure. `Cell.key()` still derives a handle's kind
      from the root `asCell` alone.
- [x] Not foreseen: stage 1 had changed what a verb's link-derived schema
      reads as — `asCell: ["stream"]` in front of the event schema, and
      `{ asCell: ["stream"] }` rather than nothing for a verb declaring no
      event type — and two CLI tests pinning the old shape
      (`verb-undeclared-field.test.ts`) had not been run. Their expectations
      are updated in stage 2.

### Stage 3 — Remove the fallback

- [ ] Delete the value branch in `Cell.isStream`, the proxy's value check
      (and the `$stream` read it registers, which
      `query-result-proxy-shape-reactivity.test.ts` pins), the inspector's
      value check (`model.ts` and `decode.ts`), the shuttle listing's
      (`kindOf`), FUSE's `isStreamValue` in `callables.ts`, and `isStreamValue`
      in `runner/src/builder/types.ts` (and its re-export).
- [ ] Rewrite the pure fakes deferred from stage 2, whose `getRaw` answers the
      sentinel: the CLI's `piece-call`, `piece-connection`, `exec`,
      `exec-read-options`, `read-options-four-ways` and
      `verb-undeclared-field` doubles, and the inline-verb case in
      `piece.test.ts` that exists to pin the sentinel path. Each should carry
      `schema: { asCell: ["stream"] }` or `isStream: () => true` and answer
      `undefined` from `getRaw`.
- [ ] Decide the raw-document fixtures that model older data:
      `scripts/topics-export.test.ts`, `storage-subscription-filter.bench.ts`
      and the codec round-trip case in `data-model/test/codecs.test.ts`. The
      first two seed a sentinel where nothing reads it, so they can stay as
      history or switch to a stamped link; the codec case is about `$`-keyed
      records in general and should keep the key under another name.
- [ ] Confirm no `$stream` remains outside `docs/history/`, the plan docs, and
      pattern sources whose comments cannot change without changing the
      pattern's identity.

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
  `{"/handler": key}` in its parent's `.json` sibling. It gets no `.handler`
  script of its own; see the stage 2 FUSE item.
- Inspector: a stream whose `schema` meta is a `cid:` reference classifies as
  `stream` and shows the referenced schema.
- A stream declared through `$ref` and `allOf`/`anyOf` sends with nothing
  stored (`stream-declaration.test.ts`).

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
