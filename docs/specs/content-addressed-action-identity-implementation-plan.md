# Content-Addressed Action Identity — Implementation Plan

Companion to [`content-addressed-action-identity.md`](./content-addressed-action-identity.md)
(the design). One PR per letter; each lands green and is independently
revertible. Phase 0 (ordinal-free `implementationRef` + legacy-alias shim)
shipped in #3997; A–D shipped in #4006/#4008/#4009/#4013; E shipped in five
PRs — E1 #4053, E2 #4064, E3 #4073 (pattern JSON dual-write), E4 #4083
(refs-only pattern JSON + session-lifetime artifact index), E5 (legacy read
path retirement) — see "PR E — the flip" for the recorded decisions per
part. **The migration is COMPLETE**: one resolution model, content-addressed
`{ identity, symbol }`, everywhere.

## Last Updated

2026-06-12

## Guiding constraints

- **Fail closed everywhere.** Every trust/CFC change must preserve the
  property that an unproven value gets no identity, no trust, no authorized
  write. When a legacy and a new path disagree, reject.
- **Red-green per consumer.** Each migrated consumer gets a test pinning the
  new behavior written first (confirm red), then the change.
- **Dual-read before flip.** Persisted data (stored graphs with
  `implementationRef` + omitted implementations; stored schemas with
  `bundleId`-keyed `writeAuthorizedBy` claims) must keep resolving until the
  explicit flip PR (E).
- Small coherent commits; full runner suite + the identity-sensitive set
  green between commits: `map-op-by-identity`, `cfreg-*`,
  `cfc-implementation-identity`, `cfc-nonexported-binding-identity`,
  `action-fingerprint`, `resume-by-identity`, `load-by-identity*`,
  `esm-source-location`, `implementation-ref`.

## Key seams (ground truth, verified 2026-06-10)

| Seam | Where |
|---|---|
| Trust brands + loadId side tables | `builder/pattern-metadata.ts` — `trustedPatterns` WeakSet, `trustedBuilderArtifacts()` hoisted-accessor WeakSet, `programByPattern`, `verifiedLoadIdByValue`; chain walks in `isTrustedPattern` (l.108) / `isTrustedBuilderArtifact` (l.139) |
| Backref writes | `builder/json-utils.ts:183` (toJSONWithLegacyAliases), `builder/traverse-utils.ts:54`, `pattern-binding.ts:333` (convert), `pattern-binding.ts:346–358` (`unsafe_noteParentOnPatterns`, write-only) |
| Backref reads | `pattern-metadata.ts` chain walks; `pattern-manager.ts` `findOriginalPattern` (l.~244) feeding `getPatternId`/`registerPattern`/`seedVerifiedLoadIds`/`getArtifactEntryRef` (l.~1139) |
| {identity,symbol} infra | `pattern-manager.ts` `valueToEntryRef` WeakMap, `addressableByIdentity` (FIFO 1000), `indexArtifact` (gated on `isTrustedBuilderArtifact`), `registerEvaluatedModules` (exports + `__cfReg` sink), `artifactFromIdentitySync` |
| Op sentinel precedent | `runner.ts substituteOpPatternRefs` (l.~3557, called from `instantiateRawNode` l.~3637), `builtins/op-pattern-ref.ts` |
| Mint + builder registration | `builder/module.ts ensureImplementationRef` (content-derived + legacy ordinal alias, #3997), `createNodeFactory` (l.114, brands factory), `handlerInternal` |
| Serialization | `builder/json-utils.ts moduleToJSON` (l.~350): drops `implementation`/`toJSON`/`with`/`bind`, spreads the rest (so `implementationRef` IS persisted); `admittedImplementation` probe decides stringify-vs-omit |
| Runtime resolution | `runner.ts resolveJavaScriptFunction` (l.2339): ref → `getVerifiedLoadId(ref, patternId)` + `getExecutableFunction(ref, patternId)` → `functionCache` → `getFallbackJavaScriptImplementation` (l.~3479, SES `getInvocation`) |
| Dynamic artifacts | `runner.ts invokeJavaScriptImplementation` (l.3497): installs a registrar during action execution so builder calls *inside* a running action register `(ref → fn)` under the action's `verifiedLoadId` |
| CFC identity | `cfc/implementation-identity.ts` (`getVerifiedFunctionInLoad(loadId, ref) === fn` anti-spoof; emits `{bundleId, sourceFile?, bindingPath?, sourceLocation, codeHash?}`); consumed at `runner.ts:2939/3179` (every handler invocation / lift run) and `instantiateRawNode` (builtins) |
| CFC persisted claims | `cfc/prepare.ts:310–360` — `writeAuthorizedBy` verification compares stored `__ctWriterIdentityOf{bundleId, file, path}` against the live identity; `prepare.ts:776–830` — `rebindWriteAuthorizedByClaims` stamps the CURRENT `bundleId` into schema claims at write time. **These claims persist in stored schemas** — the bundleId→moduleIdentity switch is a data migration, not a type rename. (`bundleId` = `hashOf(concatenated compiledBodies)` — content-stable for an unchanged program, but invalidated by ANY module change in the program; `moduleIdentity` is strictly more stable.) |
| Registry | `harness/executable-registry.ts` — maps enumerated in the design §4 |

## PR A — delete `unsafe_parentPattern` (trivial, independent)

Write-only: set at `pattern-binding.ts:354` (`unsafe_noteParentOnPatterns`,
called from `instantiateRawNode` l.~3628), read nowhere in `src/`.

1. Delete `unsafe_noteParentOnPatterns` + its call site + the
   `unsafe_parentPattern` symbol, `Pattern` declaration (`builder/types.ts:226,
   241`), and the `src/index.ts:127` export.
2. Grep tests for direct pokes; port/delete.
3. Verify: runner suite; `deno task check` (cross-package export removal).

Risk: none identified (no reader). Rollback: revert.

## PR B — `noteDerivedCopy` + delete `unsafe_originalPattern`

### Mechanism

One module-level side table replaces the symbol, same chain semantics, no
object property:

```ts
// Shown at module scope.
// builder/pattern-metadata.ts
const derivedFrom = new WeakMap<object, object>(); // copy → original

export function noteDerivedCopy(copy: unknown, original: unknown): void {
  const c = asKey(copy), o = asKey(original);
  if (!c || !o || c === o) return;
  derivedFrom.set(c, o);
  // Eager trust propagation (collapses the trust walks to probes):
  if (trustedPatterns.has(o) /* or transitively */) trustedPatterns.add(c);
  else if (trustedBuilderArtifacts().has(o)) trustedBuilderArtifacts().add(c);
  // Eager ref propagation:
  const ref = entryRefByValue.get(o);
  if (ref && !entryRefByValue.has(c)) entryRefByValue.set(c, ref);
}
```

- `entryRefByValue` is `pattern-manager.ts valueToEntryRef` **promoted to
  module level** (new `builder/artifact-refs.ts` or inside
  pattern-metadata.ts): the keys are live objects, the values are globally
  meaningful content addresses, so a process-wide WeakMap is correct and gives
  the builder-layer copy sites access without a PatternManager handle.
  `addressableByIdentity` (live-value reverse index, bounded) STAYS
  per-manager.
- Trust propagation must be transitive-correct: at `noteDerivedCopy` time the
  original may itself be an unpropagated copy ⇒ propagate from the *resolved*
  original (walk `derivedFrom` — bounded, no cycles since copies are fresh
  objects) or simply call the existing `isTrustedPattern(original)` /
  `isTrustedBuilderArtifact(original)` BEFORE they are simplified (ordering
  within the PR: add `noteDerivedCopy` + writes first, flip readers second).

### Steps (red-green each)

1. **B1**: add `derivedFrom` + `noteDerivedCopy` + module-level
   `entryRefByValue` (write-through from `indexArtifact`, which keeps its
   `isTrustedBuilderArtifact` gate and first-write-wins semantics). Tests:
   trust + ref propagation through a copy; forged value with a
   string-keyed/own-property "link" gains nothing.
2. **B2**: call `noteDerivedCopy(copy, value)` at the three copy sites
   (json-utils:183, traverse-utils:54, pattern-binding:333) *in addition to*
   the symbol write. Full suite green (both mechanisms live).
3. **B3**: flip readers — `isTrustedPattern`/`isTrustedBuilderArtifact`
   become brand probes (keep the structural `isPattern` precheck and the
   fail-closed shape); `getArtifactEntryRef` = `entryRefByValue.get(value)`
   probe (delete the exact-then-original two-step); `findOriginalPattern`
   walks `derivedFrom` (used by `getPatternId`/`registerPattern`/
   `seedVerifiedLoadIds`, where the *original object identity* is the map
   key — unchanged semantics, different chain storage).
4. **B4**: delete the symbol writes, the symbol, its `Pattern` declaration and
   exports. Port `cfreg-security.test.ts` (forgery suite: "no own property
   grants trust"; legitimate derived-copy inheritance goes through
   `noteDerivedCopy`); keep `map-op-by-identity.test.ts` green untouched (its
   spy pins that ops resolve by identity, not the embedded graph — the
   regression canary for ref propagation through binding copies).

Pitfalls (verify during B3):
- `traverseValue`'s comment cites `Object.entries` dropping symbol keys as the
  reason for re-attaching — with `noteDerivedCopy` the WeakMap covers it; the
  copy MUST still be registered even when `value` is itself a copy
  (chain-resolve in `noteDerivedCopy` handles it).
- `pattern-binding.ts` convert also copies `verifiedLoadId`
  (side-table-based already) — keep until PR C/E removes loadIds.
- `executable-registry.ts annotateVerifiedPatterns` and `pattern-manager.ts
  seedVerifiedLoadIds` call `isTrustedPattern` on serialized subtrees: after
  B3, trust of nested serialized patterns inside a just-evaluated namespace
  comes from `noteDerivedCopy` at their creation (build-time serialization in
  `createPattern` runs through `toJSONWithLegacyAliases` ⇒ registered). Add an
  explicit test: nested sub-pattern of a compiled program still receives a
  verified-load id / resolves `getArtifactEntryRef` after the flip.

Verify: full runner suite; cli pattern smoke (`cf check` on 2–3 patterns);
`deno task check`.

## PR C — `$implRef` dual-write + CFC provenance WeakMap

The big one. Sub-steps, each commit-sized:

### C1 — provenance registration

New module-scope side table (e.g. `harness/verified-provenance.ts`):

```ts
type VerifiedProvenance = {
  identity: string;                  // module content hash (prefix-free)
  symbol?: string;                   // export/__cfReg key of the FACTORY
  dynamic?: true;                    // runtime-created during a verified action
  bindingIdentity?: { sourceFile: string; bindingPath: string[] };
};
const provenanceByFn = new WeakMap<Function, VerifiedProvenance>();
```

Populate at the three places functions become verified:
1. `pattern-manager.ts registerEvaluatedModules`/`indexArtifact`: when the
   indexed value is a factory with `.implementation` (or a bare function),
   record `{identity, symbol, bindingIdentity: value.__cfVerifiedBindingIdentity}`.
   (Exports walk + `__cfReg` sink — both channels already flow through here.)
2. `runner.ts invokeJavaScriptImplementation` registrar (dynamic artifacts):
   derive `identity` from the new fn's canonical `fn.src`
   (`cf:module/<identity>/…` prefix) and record `{identity, dynamic: true}`.
   No symbol — dynamic artifacts are in-session only (status quo: they already
   don't survive a reload; see "dynamic artifacts" note below).
3. Keep the legacy `ensureImplementationRef` → registry channel untouched
   (dual-write period).

### C2 — serialize `$implRef`

`moduleToJSON`: for `type: "javascript"` modules whose implementation function
has provenance with a `symbol`, emit `$implRef: { identity, symbol }`
alongside the existing fields (`implementationRef` + conditional stringified
`implementation` keep being written — dual-write). Provenance lookup is by the
implementation function object, so it works for the module object inside
`Pattern.nodes` (the factory and module are distinct objects; the fn is
shared).

Timing note: `Pattern.nodes` is serialized at `createPattern` time (module
evaluation, BEFORE `registerEvaluatedModules` indexes refs) — but
`moduleToJSON` runs lazily via the module's `toJSON` whenever the graph is
JSON-stringified into a cell, which is post-evaluation. Verify with a test
that a handler module serialized through a cell write carries `$implRef`;
if any eager-serialization path bakes module JSON before indexing (audit
`toJSONWithLegacyAliases` callers in `createPattern` — it serializes
`node.module` eagerly!), stamp `$implRef` at the same place
`substituteOpPatternRefs` stamps ops instead: in `instantiateRawNode`, post-
binding, rewrite `module` (and module-valued inputs) with `$implRef` when
provenance resolves. **Decision point C2a** — prefer the instantiation-time
stamp (mirrors the op sentinel exactly, one mechanism, known-good timing); the
lazy-toJSON route only if instantiation-time turns out not to cover a
serialization path (e.g. patterns stored before first instantiation).

### C3 — resolve via `$implRef`

`resolveJavaScriptFunction`: resolution order becomes
1. `module.implementation` is a live function → use (unchanged);
2. `module.$implRef` → `patternManager.artifactFromIdentitySync(identity,
   symbol)`; the resolved value is the factory (or fn) → `.implementation ??
   value`. Trust: only `isTrustedBuilderArtifact` values are indexed, so
   whatever resolves is builder-made.
3. legacy: `implementationRef` → `getExecutableFunction(ref, patternId)`
   (unchanged, incl. the #3997 legacy-alias coverage);
4. `getFallbackJavaScriptImplementation` (stringified source, SES-sandboxed,
   CFC-unverified) — unchanged.
`functionCache` re-keys by module object (WeakMap) so steps 2–4 are cached
uniformly; delete the ref-string keying.

### C4 — CFC identity from provenance (with persisted-claim compat)

1. `resolvePolicyFacingImplementationIdentity`: look up `provenanceByFn` for
   the resolved fn. Hit ⇒ emit
   `{ kind: "verified", moduleIdentity, symbol?, sourceFile?, bindingPath?,
   sourceLocation, codeHash?, bundleId }` — **still carrying `bundleId`**
   (from the existing loadId machinery) during the transition. Miss ⇒ fall
   back to the current loadId-based resolution (dual-read), else
   `unsupported`.
2. `ImplementationIdentity` type: add `moduleIdentity?: string` (+ `symbol?`);
   keep `bundleId?` until PR E.
3. `cfc/prepare.ts`:
   - `rebindWriteAuthorizedByClaims`: stamp NEW claims with BOTH
     `moduleIdentity` and `bundleId` in `__ctWriterIdentityOf`.
   - verification (`l.310–332`): accept a stored claim iff
     (claim has `moduleIdentity` AND it equals identity.moduleIdentity) OR
     (claim has only `bundleId` AND it equals identity.bundleId) — plus the
     unchanged `file`/`path` equality. Never accept on a missing/empty field
     (fail closed; preserve the existing empty-string rejections).
   - audit `canonical.ts:221` (`implementationIdentity` pass-through into the
     prepare↔commit digest — in-memory only, no migration) and
     `prepare.ts:719` (the `bundleId`-key special case in claim
     normalization) for the added field.
4. Tests: cfc-implementation-identity ports to provenance
   (`moduleIdentity`-bearing identities); a stored-claim fixture with
   bundleId-only claims still verifies (compat canary); a moduleIdentity claim
   verifies against a recompiled program whose OTHER modules changed
   (the robustness win — red first against bundleId).

### C5 — red-team gate

Spawn a dedicated adversarial review of C1–C4 before merge; every attack
becomes a test (extend `cfreg-security.test.ts` / adversarial suites):
- forged fn with byte-identical source constructed OUTSIDE verified eval ⇒ no
  provenance ⇒ `unsupported`;
- `$implRef` replay pointing at another module's symbol ⇒ resolves that
  artifact or misses — prove it cannot make a non-builder value executable,
  and that CFC identity comes from the RESOLVED fn's provenance (not from the
  ref in the data);
- `__cf_data`-forged factory shapes around real fns;
- host-artifact escalation (PR D's registrar, if landed) — host provenance
  must never yield `kind: "verified"`;
- claim forgery: hand-written `__ctWriterIdentityOf` with mixed
  moduleIdentity/bundleId fields.

Dynamic-artifacts note (explicit non-goal): runtime-created builder artifacts
(minted inside a running action) remain in-session only. Today they serialize
with `implementationRef` + omitted body and already cannot resolve after a
reload; C keeps that behavior (legacy path) and provenance gives them
`kind:"verified"` with `dynamic: true` in-session. Cross-session support, if
ever wanted, is a separate design.

Verify: full runner suite + identity set; `cf check`/`cf test` smoke on
patterns with handlers; capture-and-commit a serialized-graph fixture from
BEFORE C2 and assert it still loads (legacy-read canary, kept until PR E).

## PR D — delete pattern-scoped registries + host/test registrar

Status: split. D1 — items 1 + 3 (registry deletion + regression guard,
`multi-instance-resolution.test.ts`) — landed in #4013, which also moved CFC
provenance recording from `PatternManager.indexArtifact` to
`Engine.evaluateGraph` / `recordModuleProvenance` so it covers loads that
bypass `PatternManager.compilePattern`. D2 — item 2 (the host registrar) —
has NOT landed: `unsafe-host:` counter refs + `trustedHostFunctionIndex` are
still live in `harness/executable-registry.ts`.

1. Delete `verifiedPatternFunctions`, `verifiedPatternLoadIds`,
   `associatePattern` (registry + `Harness` + engine passthrough +
   `pattern-manager.ts associateVerifiedFunctions` caller), and the
   `patternId` parameters threading through `getVerifiedLoadId` /
   `getExecutableFunction` / `resolveJavaScriptFunction`.
2. Replace `unsafe-host:` counter refs + `trustedHostFunctionIndex` with the
   synthetic-identity registrar (`runtime.unsafe_registerHostArtifact`, design
   §5): indexes into `addressableByIdentity`/`entryRefByValue` under a
   `host:<hash>` identity, trust via a `hostTrusted` WeakSet, CFC identity
   stays `undefined` (fail closed — pin with a test). Port
   `unsafeTrustHostValue` callers (runtime.ts wish/builtin trust sites) and
   the in-test uses (sugar: `registerTestArtifact` in test support).
3. Regression guard: two pieces from byte-identical programs (two loads)
   resolve handlers correctly and isolate per-instance state via inputs
   (`$ctx`), proving instance-scoping was unnecessary. Soundness rests on the
   SES no-module-mutable-state rule (design § Invariant).

Verify: full runner suite; multi-runtime/multi-user cf tests (worker-isolated
runtimes exercise repeated loads of identical programs).

## PR E — the flip (gated)

Gate: B–D soaked on main — D is split, so this means D1 (#4013) soaked AND
the D2 host registrar landed; stored-data aging assessed (graphs rewrite on
piece re-instantiation, so legacy refs age out; sample production spaces if
available).

### Gating decisions (recorded 2026-06-11)

- **Gate 1 (soak): pass.** A–D merged (#4006/#4008/#4009/#4013) with no
  reverts and no identity-machinery incidents; the only post-C commits
  touching the identity-critical files were #4014 (cross-space loading) and
  #4015 (CFC read gating), both unrelated mechanisms. Caveat: D merged
  2026-06-10, so soak time is short — mitigated by E1 keeping every read path.
- **Gate 2 (stored-data aging): could not measure** — no production-space
  sample was available at decision time, and C/D are days old, so pre-C
  graphs (`implementationRef` + omitted body, no `$implRef`) certainly
  persist. Decision: KEEP the legacy read path one more cycle —
  `ensureImplementationRef` + ordinal-alias shim (+ its test), the
  `registerVerifiedFunctionImplementation` builder channel, one string-keyed
  unbounded verified-function index, `getExecutableFunction`, the runner's
  legacy resolution arm, and the bundleId-only claim-verification arm. E2 is
  scoped down accordingly (loadId threading and per-load maps still go; the
  ref-keyed global index stays). Retirement of the kept pair needs either a
  stored-data sample showing `$implRef`-less graphs aged out or a
  `COMPILE_CACHE_RUNTIME_VERSION`-style cutoff (design Phase 4).
- **Gate 3 (eviction pinning): decided in E1** — a strong, session-lifetime,
  per-engine content-addressed implementation index
  (`ExecutableRegistry.verifiedImplementationsByEntryRef`, populated by
  `Engine.recordModuleProvenance`, exposed as
  `Harness.getVerifiedImplementation`). The bounded artifact index stays the
  fast path; the engine index is the eviction-proof backing that lets writers
  omit both `implementationRef` and the body. See design § Open questions 1.
- **bundleId-arm retention:** the verification arm in `cfc/prepare.ts` stays
  (stored claims need it); `VerifiedProvenance` now carries the evaluating
  load's `bundleId` so identities resolved WITHOUT a `verifiedLoadId`
  (post-flip graphs have no `implementationRef` to look one up by) still
  satisfy stored bundleId-only claims. The provenance field and the arm retire
  together, next cycle, gated on stored-data evidence.

### E2 — legacy machinery deletion (landed after E1; scoped by gate 2)

Deleted: ALL loadId machinery (`Frame.verifiedLoadId` + threading,
`set/getVerifiedLoadId` side tables, `seedVerifiedLoadIds`,
`patternToVerifiedLoadId`, per-load registry partitions, `beginVerifiedLoad`
repair, `verifiedLoadSources`/`verifiedLoadBundleIds`/`verifiedBindingMetadata`
maps and their capture walks, five loadId-scoped `Harness` methods), the CFC
legacy `implementationRef`×`verifiedLoadId` arm (provenance is the only source
of `kind: "verified"`; CT-1665 binding identity rides on provenance), the
`FunctionCache` + prewarm walk, and `EvaluateResult.loadId` (engine evals key
their synthetic source-map names on a renamed `evalId`).

KEPT, per gate 2 (each explicitly justified, retiring with design Phase 4):

- `ensureImplementationRef` + ordinal-alias shim (+ `implementation-ref`
  test) and the `registerVerifiedFunctionImplementation`/
  `setVerifiedFunctionRegistrar` builder channel — they repopulate…
- …the ONE retained string-keyed global executable index
  (`ExecutableRegistry.verifiedFunctionIndex`, 2-arg
  `registerVerifiedFunction`) + `getExecutableFunction` + the runner's legacy
  resolution arm — the read path for pre-flip stored graphs, host-trusted
  values, and dynamic in-action artifacts.
- The bundleId-only `writeAuthorizedBy` verification arm (stored pre-#4009
  claims) + `ImplementationIdentity.bundleId` — the field cannot be dropped
  before the arm, since the arm compares against the LIVE identity's value
  (now sourced from provenance). New claims are stamped with `moduleIdentity`
  only. Claims stamped with a RAW `verifiedLoadId` (the historical
  getVerifiedBundleId-miss corner) are no longer served: load ids embed a
  per-session counter, so such claims never verified across sessions anyway,
  and same-session claims since #4009 carry `moduleIdentity`, which wins arm
  selection.
- **`unsafe-host:` decision**: the synthetic-identity host registrar (design
  §5) is DEFERRED to the cycle that retires the legacy read path. Host trust
  is in-repo a test-only surface (`test/support/trusted-builder.ts`, one piece
  test; production `createBuilder()` passes no trust token), and it rides on
  exactly the `implementationRef` channel gate 2 keeps — replacing it now
  would add a new trust surface without removing the old one. They retire
  together.

### E1 — writer flip (landed as this series' first PR)

Writers stop emitting `implementationRef`/stringified `implementation` exactly
where the resolvability gate proves the `$implRef` suffices (the gate now
probes the engine implementation index, which never evicts in-session); the
"must carry implementationRef" throw is deleted. The admitted-probe is NOT
deleted (the plan text below predates the finding): it is narrowed to the one
category `$implRef` cannot cover — registry-admitted host-trusted values
(`trustedHostFunctionIndex`; closure-bearing, body round-trip impossible) and
dynamic in-action artifacts (no provenance symbol) — which keep serializing
`implementationRef` + omitted body until E2's §5 host registrar replaces them.
Canary: `test/pre-flip-graph-canary.test.ts` + the committed pre-flip fixture
pin both persisted vintages (pre-#4009 ref-only, #4009..E1 dual-write)
loading AND executing; it must stay green until the legacy read path retires.

1. Writers stop emitting `implementationRef` and the stringified
   `implementation`; `moduleToJSON`'s `admittedImplementation` probe and the
   "must carry implementationRef" throw are deleted.
2. Delete: `ensureImplementationRef` + ordinal-alias shim (+
   `implementation-ref.test.ts`), `setVerifiedFunctionRegistrar` builder
   channel, registry string maps, `function-cache.ts` (if not already),
   loadId threading (frames, `JavaScriptNodeContext`,
   `setVerifiedLoadId`/`getVerifiedLoadId` side tables,
   `seedVerifiedLoadIds`, `annotateVerifiedPatterns`), `Harness` interface
   methods (design §"What gets deleted").
3. CFC: drop `bundleId` from new claims and from `ImplementationIdentity`;
   KEEP the bundleId-only verification arm for stored claims (or migrate
   claims on write and time-box the arm — decide at gate time with data).
4. Pattern JSON → refs at the serialization boundary (design §7) — including
   the `$opFallback` decision (explicit `serializePatternGraph()` escape
   hatch vs eviction pinning). This piece can split into its own PR if the
   blast radius (json round-trip consumers, `pattern-binding` deserialization)
   warrants. (It did — see E3 below.)

### E3 — pattern JSON boundary (landed SCOPED: dual-write, not refs-only)

#### Gating decisions (recorded 2026-06-11)

- **`$opFallback` / escape-hatch decision: option (a).**
  `serializePatternGraph()` (builder/json-utils.ts) is the internal graph
  serializer; `toJSONWithLegacyAliases` routes pattern values through it
  under an ambient internal-serialization context that suppresses
  `$patternRef`. The fallback keeps embedding a full graph and
  `map-op-by-identity.test.ts` stays meaningful (sentinel resolves by
  identity; eviction falls back to the graph). The context flag (not just a
  separate function) is required because factory `toJSON` closures
  deliberately serialize the ROOT factory — the one carrying `.program` set
  post-construction — so internal serialization must keep calling `toJSON`
  and steer its behavior, not bypass it.
- **Refs-only emission: DEFERRED to Phase 4.** Pattern artifacts have no
  session-lifetime strong index (E1's
  `verifiedImplementationsByEntryRef` is function-object-keyed, javascript
  modules only): a stored `$patternRef` resolves only via the FIFO-bounded
  `addressableByIdentity` (sync) or `loadPatternByIdentity` (async).
  Production graph consumers found by the read audit: the list builtins'
  `resolveOpPattern` (sync Action — cannot await) and llm-dialog tool
  invocation (cross-session; compiled-artifact presence in the reading
  space not guaranteed for arbitrary pattern values). Cross-session
  resolvability could not be measured (no production-space sample — the
  same blocker as gate 2). The flip needs: a session-lifetime pattern
  index or refcount pinning (design open question 2), async-capable or
  pre-resolved reads at the two consumers, and stored-data aging evidence
  (dual-written values are now measurable, like `$implRef` was).
- **Write/read audit (2026-06-11):** pattern graphs reach storage at three
  cell-write sites — pattern values in piece arguments
  (`runner.ts updateArgument`), the list-builtin inputs sentinel
  (`getImmutableCell` after `substituteOpPatternRefs`), nested sub-pattern
  arguments — plus stdout-only CLI `--pattern-json`. No wire/IPC protocol
  field carries pattern graphs (`getPatternSources` is source-based; shell/
  runtime-client move pattern ids + sources). `pattern-binding` operates on
  in-memory bound copies only (no stored-JSON deserialization).

#### What landed

- `patternToJSON` dual-writes `$patternRef: { identity, symbol }` (from the
  module-level `getArtifactEntryRef`, content-derived → byte-stable across
  sessions) alongside the unchanged graph; internal serialization
  (`serializePatternGraph`) emits the bare graph, keeping `Pattern.nodes`
  and `$opFallback` ref-free.
- Dual-read: `resolveOpPattern` resolves a ref+graph value from its carried
  graph on a cache miss (instead of hard-failing a running node);
  `resolveStoredPattern` (shared helper) gives llm-dialog's two raw
  toolDef-pattern reads the prefer-live-canonical behavior — the resolved
  factory carries the trust brand and entry ref a deserialized graph lacks.
- Canary: `test/pre-e3-pattern-value-canary.test.ts` + committed fixture
  (`test/fixtures/pre-e3-serialized-pattern.json`, capture script alongside)
  pins BOTH stored vintages — pre-E3 bare graph and dual-write ref+graph —
  loading and EXECUTING through `runtime.run` and `resolveOpPattern`,
  without the module ever evaluating in the reading session. It must stay
  green until the graph read path retires.

One-time effect: stored pattern-bearing values gain a `$patternRef` key, so
the first re-serialization after upgrade diffs once per value (same class as
E1's serialized-module change).

Known dual-write gap (deliberate, flagged by Codex review): STRUCTURAL
pattern copies — the plain bound copies `unwrapOneLevelAndBindtoDoc` builds
from `pattern.nodes`-derived bindings — persist without `$patternRef`, since
they carry no `toJSON` and `getImmutableCell` stringifies them directly. The
load-bearing instance (the list-builtin `op`) is already covered by the
`substituteOpPatternRefs` sentinel, which stamps the ref from the copy's
derivation chain at instantiation. Stamping refs into the remaining bound
copies would change the content of immutable inputs cells (the CT-1623
id-churn class) for a vintage that rewrites on every re-instantiation anyway
— so they stay bare until the Phase 4 flip changes the internal serializer
itself. The aging signal dual-write exists for is the LIVE-factory boundary
writes (llm toolDef patterns, patterns passed directly in piece arguments),
which are the values that persist across sessions.

### E4 — refs-only pattern JSON (the §7 completion)

E3's gating blocker dissolved on inspection (recorded 2026-06-11): a pattern
artifact derives synchronously from its module's evaluation, and the obvious
fix is not to re-derive on miss but to never lose it — extend E1's gate-3
move (session-lifetime strong index) to builder artifacts. The FIFO bound on
`addressableByIdentity` was protecting against memory the strong function
index already commits to (every verified implementation retained per
session; module-scope functions referencing module-level patterns
transitively retain the factories anyway).

What landed:

1. **Artifact index pinned** — `addressableByIdentity` eviction deleted;
   `artifactFromIdentitySync` is a plain probe (no LRU touch). The
   module-NAMESPACE cache (`modulesByIdentity`) stays bounded, its bound now
   an instance field tests can shrink
   (`test/artifact-index-pinning.test.ts`).
2. **`$opFallback` dropped** — the sentinel is stamped from the op's live
   artifact in the same session that reads it back, so sync resolution
   cannot miss short of a bug, and the bug is loud
   (`map-op-by-identity.test.ts`: "fails loudly"). Stored pre-E4 sentinel
   vintages are read tolerantly (`resolveStoredPattern`).
3. **Refs-only boundary** — `patternToJSON` emits
   `{ $patternRef, argumentSchema, resultSchema }`; no-entry-ref patterns
   (manually constructed / dynamic / bare-Engine eval — including the CLI
   `--pattern-json` debug dump, which evaluates without a PatternManager and
   therefore keeps printing graphs) fall back to the full graph
   (`test/pattern-ref-boundary.test.ts`).
4. **llm-dialog async net** — `resolveStoredPatternAsync` follows the sync
   probe with the storage-backed `loadPatternByIdentity`. INVARIANT (per
   decision), now ENFORCED rather than assumed (both review bots flagged the
   fire-and-forget race): `compileViaCellCache` AWAITS the cold closure
   write-back, so a cell can only carry a `$patternRef` after its artifact
   write completed — the factory does not exist until `compilePattern`
   returns. Warm hits just read the closure from storage (already durable);
   a failed write logs without failing the compile (in-session unaffected;
   the next cold compile of the same content retries). Space-less compiles
   (no `cacheCtx`) persist nothing — dev/test paths whose values resolve
   in-session via the pinned index.
5. **Canary** — the fixture grows a `refsOnly` vintage; pins both resolution
   paths (sync live-canonical after in-session eval; source-free async load
   in a runtime that never evaluated the module) plus the older graph
   vintages unchanged.

The map case is covered by construction: anything instantiating a map
mentioned its op (hoisted closure or imported factory), so the op's module
is part of that piece's bundle and evaluates in the reading session. The one
corner outside the construction — an op passed as a runtime VALUE from a
program not running in this session — throws the descriptive sentinel error
(tripwire; sync Actions cannot await the loader).

### E5 — legacy read path retirement (the series closer)

#### Decisions (recorded 2026-06-12, all user-directed)

- **Data wipe**: no production data to preserve — gate 2's stored-data
  evidence requirement dissolves; stored pre-flip graphs, bundleId-stamped
  claims, and E3/E4 pattern-value vintages need no read support.
- **Dynamic in-action artifacts: THROW.** Builder calls (lift/handler) inside
  a running action fail at creation time: "define the <kind> at module level"
  plus a transformer-bug hint (the CT-1644 hoist makes this unreachable from
  authored source — `security.test.ts`'s hoist test now doubles as proof).
  Mechanism: `builder/action-context.ts` ambient window, entered by
  `invokeJavaScriptImplementation` for EVERY action (the old registrar only
  armed for provenance-bearing invokers, which is why a suite-wide trace
  under-counted the blast radius), asserted at the two mint sites in
  `builder/module.ts`. The in-repo blast radius was the E1 regression test
  (now pins the throw) and two hand-written unhoisted test shapes
  (`pattern-scope`, ported to hoisted form).
- **Host-trusted values: PSEUDO-MODULES.** Each `trustHostValue` call mints a
  unique `host:<n>` identity (uniqueness over content-derivation — closures
  with identical bytes are NOT interchangeable) and registers the walked
  functions as its symbols in the engine's session-lifetime implementation
  index, stamping `{ identity, symbol }` entry refs so `moduleToJSON` emits a
  normal `$implRef` (body omitted — the live closure IS the value).
  CFC identity stays undefined (no provenance recorded): §5's fail-closed
  invariant, pinned in `host-pseudo-module.test.ts` + adversarial attack 11.
  Pattern FACTORIES are excluded from the walk — they resolve through the
  artifact index, and a host entry ref on a factory would poison the
  op-sentinel path.

#### What was deleted

`ensureImplementationRef` + ordinal shim (+ `implementation-ref.test.ts`),
the `setVerifiedFunctionRegistrar` ambient channel, the string-keyed
`verifiedFunctionIndex` / `getExecutableFunction` /
`registerDynamicVerifiedFunction`, the runner's legacy resolution arm,
`Module.implementationRef`, the `unsafe-host:` CFC debugName arm, the
bundleId `writeAuthorizedBy` verification arm (+
`ImplementationIdentity.bundleId`, `provenance.bundleId`, engine threading),
the stored-vintage read tolerances (`$opFallback`, dual-write carried
graphs), and the pre-flip canary + fixture.

#### What was added

- The live-trusted resolution arm: a module whose implementation carries
  trust-gated identity facts (module-eval provenance, or a host/artifact
  entry ref — both written only behind trust gates) runs that function
  directly. This is the in-memory instantiation path (trusted-builder tests,
  dynamic factory instantiation) that used to resolve through the legacy
  index; without it, live closures were silently severed into the SES
  stringify fallback.
- Claim semantics guard: a claim carrying a legacy bundleId stamp is
  recognized as STAMPED (and unservable — fails closed at verification)
  rather than treated as unstamped and re-bound to the next verified writer.
- The stored-pattern canary slims to live behaviors
  (`stored-pattern-rehydration.test.ts`): bare graphs from no-entry-ref
  writers still execute; refs-only values rehydrate by identity (sync +
  async net).

## Sequencing & parallelism

A → B → C → D strictly (B's `entryRefByValue` promotion is C's lookup
substrate; D's host registrar uses C's provenance conventions). E gated.
A is mergeable today. B and C are the bulk; C5 (red-team) is a merge gate for
C, not an afterthought.

## Risk register

| Risk | Mitigation |
|---|---|
| Trust-propagation gap at a copy site nobody audited | B2 runs both mechanisms side by side for a full suite pass before B3 flips readers; `map-op-by-identity` + nested-subpattern tests as canaries |
| `$implRef` stamped with stale/missing refs at eager-serialization points | C2a decision: instantiation-time stamping (op-sentinel timing, known good); test pins a cell-stored handler module carrying the ref |
| Stored `writeAuthorizedBy` claims break on identity switch | C4 dual-stamp + either-arm verification; bundleId kept until E; fixture canary |
| Dynamic (in-action-created) artifacts lose CFC identity | C1 registrar-site provenance with `dynamic: true`; red-team test |
| Eviction: `$implRef` misses `addressableByIdentity` for a running piece | Legacy ref + stringified fallback retained until E; eviction pinning decided at E (design open question 1) |
| Cross-package fallout from `Harness` shrink (D/E) | interface methods deleted only in the PR that removes their last caller; `deno task check` workspace-wide per PR |

## Verification (every PR)

```
cd packages/runner && deno task test
ENV=test deno test --no-check -A test/{map-op-by-identity,cfreg-*,cfc-*,action-fingerprint,resume-by-identity,load-by-identity*,esm-source-location,implementation-ref}.test.ts
deno task check && deno fmt --check && deno lint
cd ../.. && deno task cf check packages/patterns/address.tsx   # pattern smoke (from repo root)
```

Plus per-PR items listed above. CI: shepherd each PR; perf-check per the
targeted-job-rerun discipline.
