# Pattern-Id Retirement — Design & Work Orders
> **Historical — not maintained.** Created: 2026-06-16.
> Completed migration retiring the numeric pattern id. See `docs/history/README.md` for what "historical" means here.


Successor to the content-addressed action-identity migration
([design](../../specs/content-addressed-action-identity.md),
[plan](./content-addressed-action-identity-implementation-plan.md), Phases
0–4 complete, PRs #3997/#4006/#4008/#4009/#4013/#4053/#4064/#4073/#4083/#4110).
That series made `{ identity, symbol }` the only resolution model for
*executables*. This one retires the last parallel addressing scheme — the
`pattern:<createRef>` **patternId** and the **pattern meta cell** behind it —
so pieces, loads, caches, and debug surfaces all speak content identity.

Written for implementation by a separate agent. Every seam below was verified
against main on 2026-06-12 (file:line refs are from that state; re-verify line
numbers before editing, the files move). All decisions are SETTLED — recorded
in § Decisions; do not re-litigate them, but DO stop and surface if the code
contradicts a stated fact.

## Status

**Complete.** W0–W4 are implemented, green, and committed (branch
`patternid-retirement`). `{ identity, symbol }` is the only pattern pointer; the
patternId-keyed pattern meta cell and all patternId machinery are deleted; cold
recovery recompiles from the `pattern:<identity>` source-doc closure; the entry
source doc carries optional, non-normative `annotations` excluded from
verification. Keyless (hand-built) patterns get a content-hash SESSION pointer
(`ensureKeylessPatternIdentity`) so in-session setup()/start()/reuse and NAME
preservation keep working — session-only by construction (no closure behind a
hand-built structure hash).

Implementation history below preserved for the record. W0 and W1 landed first: 

- **W0** — debug surfaces (scheduler snapshot, `getPatternSources`, shell
  scheduler views) speak `{ identity, symbol }`; `getPatternSources` no
  longer reads the meta cell.
- **W1** — `spec`/`parents`/`patternName` deleted from `patternMetaSchema`
  with their full population chain and downstream consumers (CLI piece
  listing, FUSE filesystem label). The live telemetry
  `SchedulerActionInfo.patternName` is unrelated and untouched.

**W2 and W3 are now FUSED into a single work order (W2+W3 below).** Finding,
recorded 2026-06-12 from reading the start/load path: the original split
assumed the `pattern` meta link could be removed (W2) independently of the
meta cell (W3). It cannot — **the `pattern` link's id IS the meta cell's
lookup key** (`getPatternMeta` / `loadPattern` / `savePattern` locate the
cell by `patternId`). Removing the link orphans the meta cell that the cold
recovery path and `getPatternMeta` still need; keeping it makes W2 nearly a
no-op (compiled pieces already resolve identity-first in
`startAvailablePattern`). The valuable, coherent unit is "identity is the
only pattern pointer AND the patternId-keyed meta cell is gone." See the
fused W2+W3 section.

## Last Updated

2026-06-13

## Why patternId is redundant

`registerPattern` (`pattern-manager.ts:319`) mints
`patternId = toURI(createRef({ src }, "pattern source"))` — i.e. patternId is
*already a content address of the program source*, just in a second,
non-canonical encoding. The canonical one exists: the entry module's content
identity (`cf:module/<hash>`, the prefix-free `entryIdentity`), plus the
export symbol. Every piece's result cell ALREADY dual-writes the canonical
form (`patternIdentity` meta, `runner.ts:965`) next to the legacy `pattern`
meta link (`runner.ts:952`); the start path already PREFERS it
(`runner.ts:1368`, `getPatternIdentityRef`) and only falls back to
`loadPattern(patternId)`.

The pattern meta cell (`patternMetaSchema`, `pattern-manager.ts:111`) is the
thing a patternId resolves to. Post-E4/E5 its fields decompose as:

| Field | Verdict | Evidence |
|---|---|---|
| `spec`, `parents` | DELETE (user decision: "super old stuff") | Written by `piece-helpers.ts:113` (`compileAndSavePattern` options) via `setPatternMetaFields` (`pattern-manager.ts:1442`); read by NOTHING in any execution path. |
| `patternName` | DELETE (user decision) | Read only by shell debug UIs (`shell/src/views/DebuggerView.ts`, `SchedulerSourceView.ts:570,578` — both have an id-slice fallback already) and echoed by `getPatternSources` (`runtime-client/backends/runtime-processor.ts:1099`). |
| `entryIdentity` | DELETE | It exists solely to bridge patternId → by-identity fast path (`compilePatternOnce` `knownEntryIdentity`, `pattern-manager.ts:1354/1372`; pinned by `load-by-identity-meta-bridge.test.ts`). When the piece's pointer IS `{ identity, symbol }`, the bridge bridges nothing. |
| `program.files` | MOVE — single-source into the `pattern:<identity>` source docs | Duplicated today: meta stores full sources AND `writeCompiledDocs`/`writeSourceDocs` (`compilation-cache/cell-cache.ts`) store them content-addressed. The duplicate's only unique consumers: `loadPattern(patternId)` cold recovery and `getPatternSources` — both ported below. |
| `program.main`, `program.mainExport` | SUBSUMED | `symbol` in `{ identity, symbol }` carries the export; the entry source doc identifies the main module. |

Not in scope (unchanged): `fetchProgram` / `compileAndRun` builtins operate on
program VALUES, not the meta cell; closure replication for cross-space
children (CT-1687, `replicatePatternToSpace`'s closure half,
`pattern-manager.ts:489`) stays — it is already identity-keyed.

## Decisions (settled with the user, 2026-06-12)

1. **Data wipe is sanctioned** (same decision as identity E5): no migration
   code, no tolerant reads of legacy `pattern` links or meta cells. A stored
   piece carrying only the legacy link fails with a clear error.
2. **`spec`/`parents`/`patternName` are deleted outright**, including every
   line of population code (the `compileAndSavePattern` options,
   `setPatternMetaFields`, the `pendingMetaById` staging map once nothing
   stages through it).
3. **Generic, optional, NON-normative backlinks** replace bespoke metadata
   fields: the entry `pattern:<identity>` source doc MAY carry an
   `annotations?: { [key: string]: SigilLink }` map pointing at
   product-defined docs (a name doc, a spec doc, lineage — whatever). The
   runtime NEVER reads it for execution; it is not part of any verification
   or identity computation; absence means nothing. Product code writes it if
   and when it wants.
4. **`{ identity, symbol }` is the piece's only pattern pointer.** The
   `pattern` meta link on result cells is neither written nor read.
5. **Cold recovery recompiles from the source docs**, not from meta: the
   by-identity load chain becomes in-memory → compiled-closure docs →
   SOURCE docs + recompile (this is what survives a
   `COMPILE_CACHE_RUNTIME_VERSION` bump).

## Verified seam inventory

| Seam | Where (main @ 2026-06-12) |
|---|---|
| patternId mint | `pattern-manager.ts:319` `registerPattern` (`createRef({src}, "pattern source")` → `toURI`); in-memory `patternIdMap`/`patternToIdMap`/`patternById` LRU (`:153-156`, `MAX_PATTERN_CACHE_SIZE`) |
| Meta cell | `patternMetaSchema` `:111`; `savePattern` `:361-449` (callers: `runner.ts:1015` post-run, `saveAndSyncPattern` `:458`, `replicatePatternToSpace` `:489`); `patternMetaCellById` cache; `pendingMetaById` staging; `setPatternMetaFields` `:1442` (callers: `piece-helpers.ts:113`, `compilePatternOnce` `:1373`) |
| Piece pointers | write: `runner.ts:952` (`setMetaRaw("pattern", sigil-link)`) + `:965` (`setMetaRaw("patternIdentity", {identity, symbol})`); read: `getPatternId` `runner.ts:4102` (meta link), `getPatternIdentityRef` `:4112` |
| Start/resume | `runner.ts:~1327` `doStart` requires patternId, errors `"Cannot start: no pattern ID"`; `startAvailablePattern` `:~1352` prefers `loadPatternByIdentityAs(patternId, identity, symbol, space)` (patternId is only the cache-registration key) and falls back to `loadPattern(patternId)` |
| Name projection | `runner.ts:991` `previousPatternId === patternId` drives `preserveName` in `updateResultProjection` |
| Loads | `loadPattern(patternId)` `pattern-manager.ts:~1365` (meta → program → compile); `loadPatternByIdentity` `:~893` (in-memory → compiled closure; NO source-doc arm yet); `loadPatternByIdentityAs` wraps with patternId registration; `compilePatternOnce` `knownEntryIdentity` bridge `:1354` |
| Source/compiled docs | `compilation-cache/cell-cache.ts`: `pattern:<identity>` SourceDocs (`:48`, id helper `:72`), `compileCache:<runtimeVersion>/<identity>` CompiledDocs (`:54`), `writeSourceDocs`/`writeCompiledDocs`, `loadVerifiedSourceClosure`, `loadCompiledClosure`; cold write-back AWAITED inside `compilePattern` (E4 invariant) |
| Debug wire | scheduler graph snapshot nodes carry `patternId` → `runtime-client/backends/runtime-processor.ts:1099` `getPatternSources` resolves meta → `{patternId, patternName, files}` over the protocol (`protocol/types.ts:72`); consumed by shell `SchedulerSourceView`/`SchedulerGraphView`/`DebuggerView` (~17 refs in `shell/src`) |
| Piece pkg | ~20 refs: `piece-controller.ts:130` `setPattern(program)` (compile → run → fresh ids stamped), piece meta link reads |
| Canaries to keep meaningful | `resume-by-identity.test.ts` (must lose its patternId half, keep the by-identity half), `stored-pattern-rehydration.test.ts`, `map-op-by-identity.test.ts` |

Zero patternId refs in `cli`, `ui`, `background-piece-service`,
`home-schemas`; `runtime-client`'s only surface is `getPatternSources`.

## Work orders

One PR per work order, stacked on main in this order. Method requirements
(identical to the identity series — they caught real bugs every time):
red-green per consumer (failing test FIRST, confirm red); full
`packages/runner` suite + `deno task check` + fmt/lint between commits;
`packages/piece`, `packages/html`, `packages/shell` test tasks and
`deno task cf check packages/patterns/address.tsx` before each PR;
`deno task integration patterns-reload` locally for W2+ (reload is the
highest-risk surface; the CI job is also known-flaky — rerun once and compare
before believing a failure). Commit small; worktree pre-commit hooks misfire —
verify locally then `--no-verify`. If a change raises a CFC
trust/provenance/`writeAuthorizedBy` question not answered here, STOP and
escalate rather than improvise.

### W0 — debug surfaces speak identity (independent, smallest)

1. Scheduler graph snapshot: tag nodes with the pattern's `identity` (from
   the result cell's `patternIdentity` meta / `getArtifactEntryRef`) instead
   of `patternId`. Keep the field name change honest: rename the snapshot
   field (`patternId` → `patternIdentity`), don't alias.
2. `getPatternSources`: resolve each snapshot identity →
   `patternManager.artifactFromIdentitySync(identity, symbol?)` →
   `getPatternProgram(pattern)` for files (in-memory; the patterns in the
   snapshot are running, so their modules are live — session-lifetime index
   guarantees the hit). Response shape: `{ identity, files }`; `patternName`
   field deleted from `PatternSourcesResponse`.
3. Shell views: label by `identity.slice(0, 12)` (the fallback they already
   have); delete `patternName` reads.

Exit: shell scheduler/debugger views render against a local stack
(`docs/development/LOCAL_DEV_SERVERS.md`, use `dev-local`); runner +
runtime-client + shell suites green; grep shows zero `patternName` in
`shell/src` and `runtime-client`.

### W1 — delete `spec`/`parents`/`patternName` and their population chain

1. Drop the three fields from `patternMetaSchema`.
2. Delete `setPatternMetaFields` callers' staging of them:
   `piece-helpers.ts` `compileAndSavePattern` loses its `spec`/`parents`
   options (update its callers/tests); `compilePatternOnce` keeps staging
   ONLY `entryIdentity` (dies in W3).
3. `pendingMetaById` survives W1 only as the `entryIdentity` stage; note it
   for W3 deletion.
4. Port/delete tests asserting those meta fields.

Exit: grep `spec\b|parents|patternName` in `packages/runner/src` +
`packages/piece/src` shows no meta-cell usage; full suites green.

### W2 — `{ identity, symbol }` becomes the only piece pointer

1. Stop writing the `pattern` meta link (`runner.ts:952` block). Keep
   `patternIdentity` (`:965`) as the single pointer. The
   "pattern is not yet registered/entry ref unknown" corner: by E4's
   invariant every space-compiled pattern has an entry ref post-compile; a
   pattern WITHOUT one (test-built graphs run directly) gets NO pointer —
   such pieces are session-only, which is today's de-facto behavior for
   them (their patternId load already required a stored program). Pin that
   with a test rather than inventing persistence for them.
2. `doStart`: read `patternIdentity` only; error becomes
   `"Cannot start: no pattern identity"`. Delete `getPatternId`
   (`runner.ts:4102`) and the `loadPattern(patternId)` fallback arm in
   `startAvailablePattern`; `loadPatternByIdentityAs` loses its patternId
   parameter (rename `loadPatternByIdentity` + in-memory registration keyed
   by `identity
3. Name preservation: `previousPatternId === patternId` (`runner.ts:991`)
   becomes identity+symbol equality of the previous vs current
   `patternIdentity` meta.
4. Piece package: port meta-link readers to `patternIdentity`;
   `piece-controller.setPattern` unchanged in spirit (compile → run stamps
   the fresh identity).
5. `resume-by-identity.test.ts`: the "falls back to the patternId load"
   expectations flip to "fails loudly without identity meta"; keep the
   source-free by-identity resume pin meaningful (it is the reload hot
   path — CT-1623's compiles=0 property must hold; assert
   `getCompileCacheStats()` unchanged on warm reload).

Exit: full runner suite; `deno task integration patterns-reload` green
locally; piece suite green; grep `setMetaRaw("pattern"` → zero;
`"Cannot start: no pattern ID"` string gone.

### W3 — dissolve the meta cell and patternId

1. Delete `loadPattern(patternId)`, `getPatternMeta`/`getPatternMetaCell`,
   `saveAndSyncPattern`, `savePattern`'s meta write, `patternMetaCellById`,
   `pendingMetaById`, `patternMetaSchema`, `entryIdentity` and the
   `knownEntryIdentity` bridge in `compilePatternOnce`, and
   `load-by-identity-meta-bridge.test.ts`.
2. What `savePattern` still owes the system is PERSISTENCE OF SOURCES in the
   piece's space: replace it with `ensurePatternPersisted(pattern, space)` =
   the existing closure-replication machinery (`replicatePatternToSpace`'s
   identity-keyed half) generalized to also fire for same-space runs when
   the entry ref is known. `replicatePatternToSpace` loses its meta half.
   (`runner.ts:1015` becomes the call site.)
3. **Source-doc recovery arm — ALREADY EXISTS** (correction, 2026-06-13):
   `loadPatternByIdentity` already has the in-memory → compiled-closure →
   `tryColdLoadByIdentity` (`loadVerifiedSourceClosure` → recompile → awaited
   write-back) chain. So this is NOT new work — the meta cell's `program` is
   pure duplication of the `pattern:<identity>` source docs every cold compile
   already writes (awaited). W3 just deletes the duplicate. (A
   version-bump recovery test is still worth adding if absent.)
4. Dissolve `registerPattern`/`patternIdMap`/`patternToIdMap`/`patternById`/
   `getPatternId`: the session caches are `addressableByIdentity` +
   `modulesByIdentity`; the only non-cache job `registerPattern` had —
   attaching a program to a hand-registered pattern object — survives as a
   small `associatePatternProgram(pattern, program)` (the
   `setPatternProgram` wrapper at `pattern-manager.ts:326-335`).
5. `createRef({src}, "pattern source")` and the `pattern:` URI as a CELL id
   die with it. The `pattern:` PREFIX lives on solely as the source-doc id
   scheme (`cell-cache.ts:72`) — update the one comment that conflates them.
6. Sweep: `getPatternId` exports, `URI` plumbing through run/setup
   signatures, `previousPatternId` naming, stale spec mentions.

Exit: grep `patternId` in `packages/runner/src` + `packages/piece/src` →
zero (tests may keep historical comments); full suites + reload integration
+ `stored-pattern-rehydration` + `resume-by-identity` green; the
version-bump recovery test green.

### Implementation notes from the W2+W3 attempt (2026-06-13)

Proven by an attempted implementation (reverted to keep the tree green —
these are facts, not speculation):

- **No green intermediate exists.** "Stop writing the `pattern` link" (W2) and
  "delete the meta cell" (W3) are inseparable: the link's id IS the meta
  cell's lookup key. And a "prefer identity, keep the link" intermediate
  collapses to ≈main, because keyless patterns (below) force a patternId
  fallback on every read path anyway. Treat W2+W3 as ONE all-or-nothing
  change.
- **Keyless (hand-built) patterns become `run()`-only.** A pattern with no
  module-scope entry ref (inline `pattern({...})` objects, common in runner
  unit tests) has no `{identity, symbol}` — so it has no durable pointer.
  Same-session `run()` still works (the pattern is passed in-hand to
  `startCore`), but `setup()`+`start()` (separate) and `setup()`-without-a-
  pattern do NOT (they read the stored pointer, which is now absent). The
  runner tests doing separate setup/start on inline patterns (~6 sites) must
  migrate to `run()` or to a compiled (keyed) pattern. This is the design's
  sanctioned "keyless → session-only," made concrete.
- **The runner re-key is mechanical and known** (was implemented before the
  revert): `setupInternal`/`resolveSetupPattern`/`maybeReuseRunningSetup`/
  `applySetupState` thread `{identity,symbol}` + a same-pattern boolean
  instead of patternId; `startCore` (initial + watcher) and
  `doStart`/`startAvailablePattern` resolve via `getPatternIdentityRef` +
  `artifactFromIdentitySync`/`loadPatternByIdentity`; the watcher sinks on
  the `patternIdentity` meta. Helpers `asPatternIdentityRef` /
  `patternIdentityKey` belong next to `getPatternIdentityRef`.
- **Test-migration inventory (~24 files), the bulk of the work:**
  - `registerPattern(...)` + `saveAndSyncPattern({patternId, space})` →
    `compilePattern(program, {space})` (compiles AND persists source docs;
    the pattern then carries an entry ref). ~14 files, mostly
    `packages/runner/integration/*` (sqlite-cfc-*, array_push,
    pattern-and-data-persistence) + `cast-admin.ts`.
  - `patternMetaSchema` / `getPatternMeta` / `loadPatternMeta` direct asserts
    → delete or convert to source-doc / `patternIdentity` assertions. ~7
    files (`pattern-manager.test`, `fabric-imports-*`, `cli/fabric-deps`,
    `fabric-ref-resolution`). Delete `load-by-identity-meta-bridge.test.ts`
    (it pins the deleted entryIdentity bridge).
  - separate `setup()`+`start()` on inline patterns → `run()` / keyed
    pattern. ~6 sites (`runner.test` setup/start suite).
- **Src consumers to re-key (5):** `fabric-ref-resolution.ts` (drop the
  `getPatternId`/`loadPatternMeta`/`patternMetaToIdentity`/`patternMetaFromCell`
  arms — the `getPatternIdentityRef` arm already covers it),
  `piece/src/ops/piece-controller.ts` (`getPattern`/`getPatternMeta` →
  identity), `piece/src/manager.ts` (`getPatternId`, `loadPattern`,
  `syncPattern`), `runner/src/ensure-piece-running.ts` (link →
  `patternIdentity`, `loadPattern` → `loadPatternByIdentity`),
  `piece-helpers.ts` (`compileAndSavePattern` → just `compilePattern`).
- **Orchestration suggestion:** define the final PatternManager API (delete
  dead methods) first, then fan the test migration out to parallel subagents
  by group; verify whole-workspace `deno task check` + runner suite +
  `patterns-reload`/`inspace-child`/`resume-by-identity` integration at the
  end. There is no per-file green until the whole change lands.

### W4 — optional, non-normative annotations

1. Add `annotations?: { [key: string]: unknown /* SigilLink */ }` to the
   ENTRY `SourceDoc` only (`cell-cache.ts`): preserved by
   `writeSourceDocs`/replication, EXCLUDED from `verifySourceDocs` content
   verification (annotations are not part of identity — the doc id is the
   content hash of the source, so verification must hash the source fields
   exactly as today; pin with a test that an annotated and an unannotated
   doc verify identically).
2. A setter on PatternManager (`annotatePattern(identity, space, key, link)`)
   that merges into the entry source doc. No reader in the runtime — that is
   the point. Document in `docs/common/` only if product asks.
3. Pin non-normativity: a test that execution paths (load by identity,
   verification, CFC) are byte-for-byte indifferent to annotations.

Exit: runner suite green; the two pins above; design docs' Status updated to
"complete" across this file and a closing note in
`content-addressed-action-identity.md` (§ Status, one line: patternId
retired, see this doc).

## Risk register

| Risk | Mitigation |
|---|---|
| Reload perf regression (CT-1623: warm reload compiles=0, ≤9s bar) | W2/W3 keep the by-identity path byte-identical for the warm case; assert compile-cache stats in `resume-by-identity`; run reload integration locally per PR; Performance Check metrics are noise-prone — second sample before believing, `NEW_PERF_BASELINE` only with flip evidence |
| Pieces with no entry ref (hand-built graphs) lose persistence | They never had working cross-session persistence without a stored program; W2 pins session-only behavior explicitly |
| Version-bump bricking (compiled set invalidated, meta gone) | W3's source-doc recovery arm + its red-green test is the load-bearing replacement; do NOT ship W3 without it |
| Cross-space children (CT-1687) | Closure replication is identity-keyed already; W3 only removes the meta half — keep `inspace-child-*.test.ts` green |
| Scheduler snapshot consumers beyond shell | W0 renames the field — type system finds stragglers; grep `patternId` in consumers of `getGraphSnapshot` |
| Stored data with only legacy `pattern` links | Sanctioned wipe (decision 1); fail with the clear W2 error, no tolerant read |

## Out of scope

Piece documents' own ids/causes; `fetchProgram`/`compileAndRun` program
values; the `$alias`/sigil "legacy alias" format (unrelated migration);
naming UX for pieces (the NAME projection mechanism is kept, only its
preserve-comparison re-keys).
