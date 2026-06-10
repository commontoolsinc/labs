# Content-Addressed Action Identity — Implementation Plan

Companion to [`content-addressed-action-identity.md`](./content-addressed-action-identity.md)
(the design). One PR per letter; each lands green and is independently
revertible. Phase 0 (ordinal-free `implementationRef` + legacy-alias shim)
shipped in #3997.

## Last Updated

2026-06-10

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

## PR E — the flip (gated; not scheduled yet)

Gate: B–D soaked on main; stored-data aging assessed (graphs rewrite on piece
re-instantiation, so legacy refs age out; sample production spaces if
available).

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
   warrants.

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
