# Technical debt and rough edges

One register of the things in this repository that are broken, half-migrated,
deliberately conservative, or simply surprising. It exists so that a newcomer can
find out in one place what will bite them, and so that anyone deciding what to
pay down can see the whole board at once.

This is **live** documentation: if you fix one of these, delete the entry in the
same change. If you find a new one, add it. An entry that no longer matches the
code is a bug.

Scope and tone: this page says what is wrong and why it matters. It does not
explain how the subsystems work — for that, see the
[orientation docs](orientation/README.md), which each link back here. Not
everything below is a defect; some entries are deliberate trade-offs recorded so
nobody "fixes" them by accident. Those are marked **by design**.

---

## Structural: the import cycles

Four genuine import cycles exist in production code. The
[dependency graph](orientation/dependency-graph.md) draws them and gives the
exact seam for each; the short version:

- **`runner ↔ html`** — the runtime's builder (`builder/built-in.ts`,
  `factory.ts`, `builtins/wish.ts`) imports `h()` to construct view nodes, while
  `html`'s worker reconciler imports cell helpers back from `runner`. A UI
  primitive is wired into the foundation.
- **`runner ↔ memory`** — `memory/v2/query.ts` imports
  `@commonfabric/runner/traverse` to answer schema-aware graph queries and
  evaluate per-row CFC labels. The cycle forms on that one package edge, but the
  same file also reaches runner's CFC, storage-transaction, and builder-type
  internals through *relative* paths, so the coupling is deeper than the package
  graph suggests. This is the seam to know if anyone tries to extract `memory` as
  a standalone library.
- **`runner ↔ llm`** — one import: `llm/src/prompts/json-import.ts` needs
  `createJsonSchema`. A prompt helper reaching up into the runtime.
- **`ui ↔ shell`** — four `cf-*` components import navigation/URL helpers from
  `@commonfabric/shell/shared`; the shell imports `cf-*` classes and the Lit
  contexts back. Narrowed to navigation, but real.

Three of the four touch `runner`, which is what you would expect: the cheapest
place to introduce a cycle is against the package everything already depends on.

## Structural: the layering violation

- **`runner → home-schemas`.** `runner/src/builtins/wish.ts` imports
  `favoriteListSchema` from `@commonfabric/home-schemas` — a foundation builtin
  coupled to an end-user-domain schema. A newcomer reasonably expects builtins to
  be generic; this one is not. (`home-schemas` itself exists to *prevent* a
  different cycle, by giving `runner` and `piece` somewhere neutral to share
  schemas.)

## Structural: where the complexity concentrates

- **A handful of files carry a disproportionate share of the system**, each
  several thousand lines: `runner/src/cfc/prepare.ts`, `memory/v2/engine.ts`,
  `runner/src/runner.ts`, `runner/src/traverse.ts`,
  `ts-transformers/src/transformers/schema-injection.ts`,
  `html/src/worker/reconciler.ts`, `runner/src/builtins/llm-dialog.ts`,
  `runner/src/storage/v2.ts`, `runner/src/cell.ts`,
  `ts-transformers/src/policy/capability-analysis.ts`, and
  `runner/src/scheduler/facade.ts`. Most are in `runner`, and the largest is the
  CFC write-policy gate — Contextual Flow Control has grown into the biggest
  single piece of the runtime.
- **`cli` is a hub, and a growing one.** It imports `runner` most, plus
  `identity`, `utils`, `js-compiler`, `piece`, `api`, and `state-inspector`. A
  change in any of those can break the command line.

---

## Security and safety

- **`cf-markdown` renders unsanitized HTML.** It applies `unsafeHTML` to rendered
  markdown with no sanitizer, and carries an in-code `TODO(CT-1088)` saying so. A
  cross-site-scripting risk if it is ever fed untrusted markdown. A previous
  DOMPurify dependency was removed over lockfile issues. Know this before reusing
  the component.
- **The iframe sandbox has documented, accepted gaps.** Its README lists them:
  the hardcoded-CDN allowlist and anchors with `target=_blank` are both
  exfiltration vectors, and `document.baseURI` leaks the parent URL into the
  guest.
- **The shell route's COOP/COEP headers are deliberately non-isolating**
  (`same-origin-allow-popups` / `unsafe-none`, set after the handler so they
  override upstream). **By design**: keeping `crossOriginIsolated === false`
  denies SES-sandboxed patterns `SharedArrayBuffer` and high-resolution timers.
  Do not "fix" this without understanding why.
- **The SQL guard is intentionally conservative** (`memory/v2/sqlite/guard.ts`):
  single statement only, no PRAGMA/ATTACH, no references to core engine tables.
  **By design** — it rejects some valid statements to keep the attack surface
  small.
- **CFC row labels fail closed** (`memory/v2/sqlite/row-label.ts`). Well-formed
  disjunctive confidentiality clauses are accepted, but unsound shapes are
  rejected outright: an `any()` alternative that is itself a conjunction or
  nested disjunction, disjunctive *integrity*, ambiguous multi-op nodes, and
  ReDoS-shaped regexes. **By design**, but it means legitimate-looking authoring
  can be refused.

---

## Durability and correctness risks

- **FUSE writes are fire-and-forget.** `write(2)` returns success *before* the
  cell mutation lands; the buffer is only pushed to the cell on flush (on close)
  or release. A disconnect between the reply and the flush can silently lose
  data. `fuse`'s `RELIABILITY_DESIGN.md` and the CFC-writeback state machine are
  the mitigation, not a fix. Note also that `fsync` is *not* wired as a writeback
  trigger — the one durability primitive a caller would reach for does nothing
  here.
- **The background piece scheduler is approximate.** Its TODOs are the honest
  record: space managers should watch their own pieces; a terminal worker error
  cannot always be attributed to a specific piece, so a stray failure can disable
  a whole space; and sync is assumed never to return partial results.
- **`background-piece-service` depends on hardcoded constants** — the
  system-space DID (`BG_SYSTEM_SPACE_ID`) and a dated cause string
  (`BG_CELL_CAUSE`) in `schema.ts` — and needs a one-time admin grant before any
  piece is polled at all.
- **`runtime-client` teardown is intentionally quiet.** After a `Dispose`, the
  worker silently acknowledges late requests and drops notifications. **By
  design**, but genuinely confusing while debugging.
- **CFC silently gates commits.** The default enforcement mode can reject a write
  or replace blocked content with a placeholder. If a write or a piece of UI
  "disappears", suspect CFC before the scheduler or the renderer.

---

## Migrations in flight, and legacy that lingers

- **`memory` carries two vocabularies.** An older UCAN-flavored "fact" model —
  `assert`/`retract`/`unclaimed` in `fact.ts`, its types in `interface.ts`,
  reached through the `@commonfabric/memory/fact` subpath that runner's storage
  layer still imports — sits alongside the current v2 document/operation model
  (`EntityDocument`, `Operation`, `ClientCommit`, `GraphQuery` in `v2.ts`). New
  work is v2; `lib.ts` is the legacy entry point. The fact model is still
  exported and still confuses newcomers.
- **Three link representations coexist**: the serialized `SigilLink`, the
  in-memory `NormalizedLink`, and a deprecated `LegacyAlias` still present in the
  `PrimitiveCellLink` union. New readers meet all three.
- **The modern cell representation is implemented but off.**
  `data-model/cell-rep.ts` implements both the modern (bare
  `FabricHash`/`FabricLink`) and legacy (`{ "/": "tag:hash" }` envelope) forms;
  a module-level `modernCellRepEnabled` flag, default off, selects between them.
  The flip, when it happens, happens there.
- **The `TODO(danfuzz)` cluster** across `schema.ts`, `cfc/`, `traverse.ts`, and
  `cell.ts` marks one incomplete migration, not scattered bugs: several graph
  walks do not yet admit the newer `FabricValue` special objects on every path.
- **Two render paths still exist.** The worker-thread reconciler is the live one;
  the legacy main-thread `renderNode`/`effect` path in `html/src/render.ts`
  remains and is still selectable by a flag.
- **`v1` is gone but the `v2/` directory name remains.** `ui/src/index.ts` is
  just `export * from "./v2/index.ts"`. Everything is v2; the name is flagged for
  cleanup.
- **Several shell views are inert pending a worker refactor.** `ACLView` and
  parts of `QuickJumpView` carry `TODO(runtime-worker-refactor)` and currently do
  nothing.
- **The charm→piece rename is complete in source but not on the wire.** So
  existing spaces keep resolving, the persisted names were deliberately left
  alone: the `bgUpdater` handler-stream name, the dated `BG_CELL_CAUSE` string,
  and the derived `BG_SYSTEM_SPACE_ID`. None of them contain the word "charm";
  they are simply legacy-shaped. (Repo-wide, "charm" now survives only in
  unrelated test data and git history.)

---

## Hand-maintained couplings

These have no compiler enforcing them; they drift silently.

- **`api` declarations must be kept in sync by hand.** `api/index.ts` is
  `declare const` / ambient declarations that must match implementations
  elsewhere: the builder vocabulary against `runner/src/builder`, and (per the
  sync note at the top of the file) the Fabric value types against `data-model`.
  Changing a signature means editing it in two places.
- **Transformer behavior is pinned by golden files.** `ts-transformers` and
  `schema-generator` are golden-driven (`*.input.tsx`/`*.expected.jsx` and
  `*.input.ts`/`*.expected.json`). Changing emit shape means regenerating
  goldens (`UPDATE_GOLDENS=1`) and reviewing a large diff; `FIXTURE=<name>` is
  the fast path.
- **The FUSE FFI struct layouts are hand-maintained** and differ per platform
  (macOS FUSE v2 / FUSE-T, Linux FUSE v3). FUSE-T additionally lacks
  `notify_inval_entry`, so cache invalidation falls back to per-inode
  invalidation with short timeouts.

---

## Traps and misleading names

- **`cf-harness` is not a test harness.** It is an experimental agent runtime —
  an LLM tool-calling loop with a sandbox, tool registry, and CFC awareness.
  Probably the single most misleading name in the repo.
- **The runtime-client protocol calls pieces "pages."** `PageCreate`,
  `PageHandle`, and friends all mean *piece*.
- **The LLM provider abstraction is not in the `llm` package.** It lives in
  `toolshed/routes/ai/llm/models.ts`; the `llm` package is only an HTTP client
  plus prompts. People look in `llm/` first and find nothing.
- **`runtime.ts` imports from its own package barrel** — it pulls the
  `RuntimeTelemetry` *value* (a class, not a type) from `@commonfabric/runner`.
  A load-order trap when reordering exports.
- **The scheduler is pull-based**, which is counterintuitive if you arrive
  expecting a push/observer model. Effects are the demand roots; computations are
  lazy until something demanded needs them. Budget time for this.
- **The `lift-applied` distinction is subtle.** A single application
  (`__cfHelpers.lift(cb)(input)`, what `computed` lowers to) is classified
  `lift-applied`; an unapplied `lift(cb)` or a multi-application chain
  deliberately is not. This gates whole dispatch branches.
- **`cf-*` components self-register on import.** Importing the module calls
  `customElements.define`; there is no separate registration step. If a component
  is "missing", check that its module was imported.
- **OAuth providers are skipped silently.** Providers with missing credentials
  return null and are dropped at startup, and the shared `/api/integrations/bg`
  route attaches to whichever descriptor has credentials first. Non-obvious when
  an endpoint "isn't there".
- **Pattern authority is non-uniform.** Check the Status tiers in
  `packages/patterns/index.md` before copying anything: only `exemplar`-tier
  patterns are style references, and the `legacy` tier (the whole `record/`
  system, the attribute clones, `factory-outputs/`) will teach you deprecated
  idioms.
- **Deno is narrowly version-pinned.** A mismatched local Deno fails
  `deno task check` before any real work runs.

---

## Flagged in the code

Markers worth knowing about, because they name real intent rather than idle
grumbling:

- `piece/src/manager.ts` — `FIXME(JA): this really really really needs to be
  revisited`, plus a TODO about temporarily using elevated permissions.
- `ui/src/v2/components/cf-markdown/cf-markdown.ts` — `TODO(CT-1088): XSS
  VULNERABILITY`.
- `shell` — `TODO(runtime-worker-refactor)` in `ACLView` and `QuickJumpView`.
- `runner` — the `TODO(danfuzz)` `FabricValue` migration cluster.
- `background-piece-service` — the scheduler-approximation TODOs described above.

By contrast, `ts-transformers` and `js-compiler` are almost free of
`TODO`/`FIXME`/`HACK` comments. Their open questions live in design documents
instead (`ts-transformers/docs/`, `docs/specs/ts-transformer/`, and
`ts-transformers/ISSUES_TO_FOLLOW_UP.md`) — the README tells you to read the
behavior spec rather than infer from the code, and it means it.
