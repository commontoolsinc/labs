# CFC Spec Audit — packages/runner vs ~/src/specs/cfc
> **Historical — not maintained.** Created: 2026-06-09.
> Point-in-time audit of CFC spec versus implementation divergence. See `docs/history/README.md` for what "historical" means here.


Date: 2026-06-09. Spec bar: sections marked "Status: Normative"; ch. 14 (open
problems), 08-14 and 08-16 (redirect stubs to ch. 14) treated as non-normative.
Produced by seven parallel audit passes (one per spec slice plus one code-first
sweep); the highest-impact soundness claims were independently re-verified
against source.

## How the implementation relates to the spec

The runner implements a deliberate **phase-1 subset**: flat conjunctive labels
(atom arrays, no CNF clauses), schema-declared `ifc` annotations verified at
**commit time** (`prepareBoundaryCommit`,
`packages/runner/src/cfc/prepare.ts:2077`) with a prepared-digest recheck at
commit (`extended-storage-transaction.ts:656-673`), persisted per-path label
maps bound to content-addressed schema hashes, link/reference label
pass-through, write authority, UI-contract trusted events, sink-request replay
fidelity, and InjectionSafe schema sanitization. Default mode is
`enforce-explicit` (`runtime.ts:391`); the bare transaction default is
`disabled` (`cfc/types.ts:31`).

Terminology: spec `Label{confidentiality: Clause[], integrity: Atom[]}` ↔ impl
`IFCLabel{confidentiality?: unknown[], integrity?: unknown[]}`
(`label-view-core.ts:4`); spec boundary loop ↔ impl prepare/digest two-phase;
spec `CodeHash` write authority ↔ impl builtin-id strings or
`__ctWriterIdentityOf{bundleId,file,path}` bindings; spec `$actingUser` ↔ impl
`{__ctCurrentPrincipal: true}` placeholders.

The single largest architectural distance: **the spec derives output labels from
input labels (default transition §8.9.3 + PC propagation §8.9.2/§8.11); the
implementation never does** — it persists only schema-declared labels and
verifies declared constraints. Every "value-copy laundering" finding below is
downstream of that one posture.

---

## 1a. Gaps in existing features (implemented, but incomplete or divergent)

**Input requirement checks (`requiredIntegrity` / `maxConfidentiality`),
§8.10.3:**

- Consumed set is **transaction-global**, not scoped to the annotated input path
  (`prepare.ts:1694-1709`) — spec uses `collectConsumedLabelsAtOrBelow(path)`.
  Over-strict in one direction (unrelated labeled read can fail an unrelated
  write), under-strict in the other (see soundness S7).
- Satisfaction is whole-atom `deepEqual` membership (`prepare.ts:1747-1759`),
  not the spec's pattern matching with **shared-witness-key coherence** — two
  leaves matching via different witnesses both pass where the spec requires one
  shared witness.
- Ceiling checks are flat atom membership (`prepare.ts:1761-1771`), not
  clause-aware "every clause contains an allowed alternative". Fail-closed for
  opaque `anyOf` objects, but authored OR-clauses can never be satisfied.
- `labelAtPath` (`prepare.ts:65-87`) matches only ancestor-or-equal entries: a
  read of a **parent object** of a labeled field resolves to no label and is
  filtered out of the consumed set entirely (see soundness S7). The label-view
  machinery handles the same case correctly in the other direction
  (`rebaseCfcLabelView`), so this looks like an oversight.

**`exactCopyOf` (§8.4):**

- Compares two paths **within the same target document** by `deepEqual`
  (`prepare.ts:1819-1847`); spec compares handler-input→output via `refer()`
  identity. Cross-document/handler-input sources inexpressible; reference-form
  copies spuriously reject.
- **Wildcard (`items`) claim paths are silently unverified**: `walkIfcSchema`
  emits `"*"` segments (`prepare.ts:971-973`) but `writeDetailValueForTarget`
  matches literally, so a write at `["list","0"]` never matches `["list","*"]`
  and `deepEqual(undefined,
  undefined)` passes vacuously — while the label
  copy still happens (`prepare.ts:1857-1859`).
- Source label copied from the _schema-declared_ sibling entry only, not the
  stored/runtime label of the source; not transitive across copy chains.
- No `ifcEntryAppliesToAttemptedWrite` gating (unlike sibling checks): writing
  only the source while the target is untouched spuriously rejects; touching
  neither passes vacuously.

**Integrity combination — union everywhere, never meet (§8.6.2, §8.17.1):**

- `mergeLabel`/`mergeLabels` union integrity (`label-view-core.ts:68-92`,
  `prepare.ts:1906-1915`). Fine for link refresh/endorsement merges; wrong when
  two _different_ writes land at one path in one tx (`coalesceLabelEntries`,
  `prepare.ts:2012-2033`) — the surviving value claims integrity only the
  overwritten value had.
- SQLite null-origin (aggregate) columns inherit the **union** of all labeled
  columns' integrity (`deriveNullOriginIfc`, `sqlite-builtins.ts:167-178`) where
  §8.17.1 says "class-aware meet … never union". A `COUNT(*)` can claim a
  provenance atom held by one column. (Acknowledged in-repo as CT-1668.)
- Computation outputs get **no** integrity at all (`applyInputIfcToOutput`
  propagates only confidentiality, `builder/node-utils.ts:70-88`) — under-claim,
  fail-safe, but it means hereditary atoms (`PolicyCertified`-class) don't
  survive as §3.1.6.1/§15.1.1 require.

**Two inconsistent schema-IFC walkers (§4.2.1.1):** `walkIfcSchema`
(`prepare.ts:916-978`) descends into `anyOf`/`oneOf`/`allOf` and flatten-merges
branch-local `ifc` (spec says reject); `ContextualFlowControl.joinSchema`
(`cfc.ts:75-149`) doesn't descend at all, so branch-local confidentiality is
silently dropped from `lubSchema`-based tainting (the one **under-tainting
fail-open** in the core algebra). Same schema taints differently on the
propagation path vs the verification path. `joinSchema` also skips `prefixItems`
and skips `items` when `additionalProperties` is present (acknowledged TODO,
`cfc.ts:124`).

**Flow-precision claims (§8.5.4, §8.9.1):**

- Claims are minted and trust-gated at the builtin runtime path but **nothing
  consumes them** (`ifc.flowPrecisionClaim` has no reader) — currently inert.
- Claims are attached **regardless of op argument usage** (`map.ts:122-127`
  ignores `inferListOpArgumentUsage`) — a pre-staged unsound
  `PointwiseWriteDependency` for ops that read the whole array/params, armed for
  whenever a consumer lands.
- Trust gate is a compiled-in builtin allowlist (`flow-precision.ts:98-107`),
  not the user-scoped trust closure §4.8.7 requires; `CodeHash` claims for user
  modules unsupported.
- `filter`/`flatMap` have no structural-confidentiality counterpart: element
  labels pass through by reference (good), but membership/order/length carry
  **no** label — the §8.5.6.1 secret-search example (private query filtering
  public items) is unrepresentable, and the implemented default is _permissive_,
  not conservative.

**Sink gating (§5.2.1, §7.3-7.5):**

- The "sink gate" is request **immutability** only: `verifySinkRequestRelease`
  deep-equals the post-commit request against the prepared snapshot
  (`sink-request.ts:51-82`). No label is consulted, nothing is stripped, no
  `AuthorizedRequest` integrity fact is emitted. Today the only enforced sink
  property is replay fidelity, not information flow.
- No attempt/commit distinction, no durable consumed-intent record, no
  retries/`exp`/ `maxAttempts`; failed flushes are warn-and-drop
  (`sink-request.ts:109-117` — at least fail-closed) and invisible to CFC
  instrumentation.

**Trusted events / UI contracts (§6.2-6.3, §8.15.9):**

- Event identity `trusted-event:${type}:${id}:${path}`
  (`ui-contract.ts:609-615`) — no nonce/timestamp/payload digest; not unique,
  not single-use (dedup is per-transaction only).
- No payload binding: `verifyTrustedEventRequirements` (`prepare.ts:1776-1817`)
  checks a matching gesture exists for the path; the handler may write **any
  value** (spec §7.3.4 requires payloadDigest binding).
- No render binding: `EventProvenance` carries no
  `renderRef`/`snapshotDigest`/`targetPath` (§6.3.1's "primary evidence
  handle").
- `requiredEventIntegrity` are untyped strings scraped from pattern-authored
  `data-*` attributes (see soundness S12).

**Write authority (§8.15):**

- Verified-handler claims accept exactly **one** `__ctWriterIdentityOf` binding
  (`prepare.ts:307-328`); the spec's per-field union of handler identities
  (§8.15.2, §8.15.8 cross-pattern reuse) is only expressible for legacy
  builtin-string arrays.

**CAS / dual addressing (§17):**

- Causal path matches §17.1's envelope sketch. The CAS path is vestigial:
  `cid:<schemaHash>` docs are written with the **caller-claimed** hash,
  unverified on write (`ensureSchemaDocument`, `prepare.ts:2041-2054`) and
  trusted on read (`loadSchemaDocument`, `prepare.ts:2057-2075`). No
  `labelBindings`, no `expectedLabel` read API, no miss normalization. The
  compile cache (`compilation-cache/cell-cache.ts:369-401`) is the one
  spec-faithful CAS implementation. See soundness S5.

**Schema-evolution monotonicity (§4.2.2.1):** directions correct
(`schema-merge.ts:55-120`), but missing the normalized-profile eligibility gate,
`preservesStructuralMeaning` checks, and `labelHistory`.

**Persisted envelope layout (§4.6.4):** label paths are value-relative where the
spec says newly persisted envelopes MUST key under `/value`; no
`PathLabelTemplate` observation classes (`shape`/`iterate`/`children`...), and
read ops aren't captured per §8.10.1.1 (`ConsumedRead` has no `op`).

**Profiles (§18.3/§18.4):**

- AgentHarness: `PromptSlotBinding` has the right fields but they're optional,
  caller-supplied, and **never verified**;
  `evaluateHarnessWriteFileAuthorization` trusts a bare
  `role === "direct-command"` field (`harness-write-policy.ts:25-27`). No
  registry snapshots, no descriptor digests, no labeled descriptor fields.
  Opaque-handle pass-through is the one fully met item.
- TrustedRender: authored-by boundaries, blocked placeholders, and literal-text
  blocking are real and fail-closed
  (`packages/html/src/worker/reconciler.ts:384-421,643-708`); trusted-component
  registry has exactly one entry; no `RenderRef`/`snapshotDigest` machinery at
  all.
- Harness digests use `sha256(JSON.stringify(x))`
  (`packages/cf-harness/src/structured-result.ts:43`) — key-order-sensitive, no
  NFC; the runner's own digest is properly canonical
  (`data-model/src/value-hash.ts`). Inconsistent c14n across the TCB.

## 1b. Unimplemented areas (no code counterpart)

- **The entire generic policy calculus (spec layer 2)**: policy records, context
  principals, exchange-rule syntax/matching/binding, clause-local rewrite,
  fixpoint evaluation, declassification as guarded release, multi-party consent,
  response translation, error exchange rules / `SanitizedError`,
  `PolicyCertified` certification. Zero hits for any of it in the runner.
  Consequently every declassification-shaped behavior is either hard-coded into
  the evaluator or absent.
- **CNF label algebra**: flat atom lists; disjunctive clauses, clause
  subsumption, clause-local authority, §8.17.4 common-alternative property all
  unrepresentable. (§8.12.1's note blesses the degenerate all-singleton case,
  which the impl matches.)
- **The intent lifecycle (ch. 6-7)**: no `IntentEvent`/`IntentOnce`/refinement
  chain/ consumption cells/attempt cells/`commitIntent`/atomic claims.
  Single-use semantics — the central mechanism of ch. 6 — exist nowhere. §11's
  developer guidance references `commitIntent`, which doesn't exist.
- **Trust lattice (§2.2, §4.8)**: no
  `TrustStatement`/`VerifierDelegation`/concept reachability; `TrustSnapshot` is
  `{id, actingPrincipal, revision}` used only for `$currentPrincipal` resolution
  and owner checks.
- **Trusted derived identifiers (§2.4)**: no
  `TrustedDerivedId`/`DerivedByTrustedHash` anywhere; all coordination
  identifiers are raw strings (see soundness S14).
- **Access semantics (§3.1.4)**: no `canAccess`, no read-time checks at all;
  enforcement is write/commit-side plus sink snapshots.
- **Expiry/TTL (§3.2, §8.12.6)**: no `Expires` atoms, no cascade.
- **Projection (§8.3) and collection (§8.5) schema claims**: authorable,
  rejected fail-closed (`unsupportedTrustSensitiveReason`,
  `prepare.ts:1028-1046`) — correct posture. But `recomposeProjections`,
  `passThrough`, `combinedFrom`/`combinationType`, `transformation`, and
  spec-spelled `addedIntegrity` are **silently ignored** (not in `IFC_KEYS`, not
  in the reject list, dropped on merge) — an author writing spec-conformant
  annotations gets no enforcement and no error.
- **`OpaqueInput` (§8.13)**: authorable, lowered to `ifc.opaque` by the
  transformer, never read by the runner, and **silently dropped by
  schema-merge** — the one fail-open exception to the otherwise fail-closed
  treatment of unimplemented claims.
- **Per-output label derivation + PC propagation (§8.9.2/§8.9.3, §8.11)**: see
  architecture note; the router attack worked example in ch. 10 is not blocked.
- **§17.2-17.5 CAS structures**; **§11.2 static analysis**; **§11.1.3 inference
  rules** (no space-based confidentiality inheritance, no automatic `CodeHash`
  stamping).
- Chapter-10 invariants with no enforcement anywhere: #2 (default propagation),
  #3 (guarded exchange), #5 (authority-only secrets), #7 (robust
  declassification), #8 (transparent endorsement), #11 (user-scoped trust
  closure), #12 (label-metadata confidentiality).

---

## 2. Differences from spec pseudocode

1. **Boundary loop vs prepare/digest.** Spec (§8.10.1): per-attempt
   verify→propagate→ commit loop. Impl: verify once in `prepareCfc()`, then a
   canonical-digest recheck at commit with invalidation on any post-prepare
   activity. Materially different but defensible factoring of the same
   fail-closed contract — except the digest covers _activity_, not _that
   verification ran_ (see S2).
2. **Input requirements attached to write-target schemas, not handler-input
   schemas.** Spec walks the handler's input schema; impl walks the write
   target's and gates on write-applicability (`prepare.ts:1711+`). A structural
   inversion: requirements fire when a protected output is written, not when a
   protected input is consumed.
3. **`refer(ptr)` vs `deepEqual`.** Everywhere the spec compares content
   addresses, the impl deep-equals reconstructed values (`exactCopyOf`
   `prepare.ts:1842`, sink snapshots `sink-request.ts:77`). Equivalent for
   canonical JSON in-process; produces no auditable digest artifact and exhibits
   the `undefined/undefined` vacuous edge.
4. **Event processing: claim-before-handle vs at-least-once.** Spec (§6.2.2):
   `atomicClaimCell` then handle. Impl (`scheduler/events.ts:518-588`): queue,
   run, retry on conflict — exactly-once replaced by at-least-once with
   tx-conflict gating.
5. **Write authority: `CodeHash` atom membership vs source-binding identity.**
   Spec compares atoms; impl compares builtin-id strings or
   `{bundleId,file,path}` structures, with silent bundleId rebinding of authored
   claims (`prepare.ts:771-833`). `codeHash` exists only as a fallback and
   hashes `Function.prototype.toString`, not a shipped artifact.
6. **`AttemptedWrite`**: spec `{path, changed}` ordered sequence; impl bare
   addresses with changed-ness recomputed ad hoc in wildcard matching and final
   values reconstructed granularity-independently (`prepare.ts:1159-1270`) —
   equivalent in effect.
7. **Key drift**: spec `addedIntegrity` vs impl `addIntegrity`; spec
   `classification` shorthand dropped; impl adds `addIntegrity`,
   `ownerPrincipal`, `exactCopyOf`, `projection`, `collection`,
   `flowPrecisionClaim`, `uiContract` under `ifc`.
8. **Gesture integrity**: spec mints `UIRuntime`/`GestureProvenance` atoms; impl
   uses a realm-local WeakSet mark plus DOM dataset dictionaries — trust is a JS
   object-identity property that cannot persist, transfer, or be inspected by
   policy.
9. **Developer surface**: §11's branded types / JSDoc annotations /
   `$actingUser` / `$eventIntegrity` / `$now` are realized as ts-transformer
   type aliases (`packages/api/cfc.ts:195-387`) and
   `{__ctCurrentPrincipal:true}` placeholders with a stricter unspecced rule
   (literal `did:` subjects rejected).

---

## 3. In the code, not in the spec (should probably be specified)

1. **Enforcement-mode ladder + relevance predicate.**
   `disabled|observe|enforce-explicit|
   enforce-strict` and the
   `markCfcRelevant` criterion decide _whether CFC runs at all_ — the spec
   assumes verification at every boundary. Also: `enforce-strict` is currently
   **indistinguishable** from `enforce-explicit` in the commit gate.
2. **The prepared-digest two-phase commit** (digest contents,
   canonicalization/freeze rules, invalidation triggers, and the
   `prepareCfc(input)` contract).
3. **Setup-projection structural provenance**
   (`CFC_STRUCTURAL_PROVENANCE_SETUP_PROJECTION`, `prepare.ts:380-492`) — the
   load-bearing write-authority carve-out for pattern instantiation; §8.15.4
   covers it in one sentence.
4. **The implementation-identity scheme** (`bundleId`+`sourceFile`+`bindingPath`
   bindings, bundleId rebinding, bundleId-insensitive schema equality) — the
   root of trust for write authority, zero spec text.
5. **`ownerPrincipal` + `__ctCurrentPrincipal`** placeholder semantics and the
   mandatory companion-claim chain (trust snapshot + `represents-principal` +
   `writeAuthorizedBy` + `uiContract`).
6. **`addIntegrity`** annotation (used by sanitizer and label persistence; zero
   spec hits).
7. **Claim-only labelMap entries** (entry presence = "policy applies here") and
   the value-relative path layout — the mechanism that makes later unlabeled
   writes to protected docs CFC-relevant.
8. **Carried label views + dereference-trace merging + the minted
   `LinkReference` atom** — the runtime's main label-transport mechanism;
   `LinkReference` (and `PromptSlotInfluence`) are absent from the §15 atom
   registry.
9. **The uiContract trusted-event system** (helper taxonomy, WeakSet renderer
   mark, provenance/dataset matching) — only ch. 14 _proposals_ mention
   `uiContracts`; this is the implementation's primary UI-evidence mechanism and
   should be normative.
10. **The schema-merge per-key direction table** (grow-only vs shrink-only vs
    frozen) — the actual store-label-monotonicity enforcement rules live only in
    code.
11. **Post-commit outbox + sink-release re-verification contract** (idempotency
    keys, flush-once, verify-against-prepared-snapshot).
12. **Schema-sanitization / contamination scoping** is _ahead_ of the normative
    spec (08-14 redirects to non-normative ch. 14): instruction-inertness
    analysis, caveat-kind aliases, the InjectionSafe discharge — implemented,
    tested, unspecced.

---

## 4. Soundness findings

Ordered by severity. Tagged **[hole]** = looks unintended, **[phase-1]** =
consistent with the staged-rollout posture but worth recording as the
load-bearing assumption.

- **S1 [hole] Memory v2 server has no ACL/ownership check.**
  `authorizeSessionOpen` verifies only that the `session.open` invocation is
  self-signed and names the space
  (`packages/toolshed/routes/storage/memory.ts:26-74`); the v2 server then
  accepts `transact`/`query` from any open session, using the principal only for
  scope addressing. Legacy `checkACL` (`packages/memory/access.ts`, `acl.ts`) is
  wired only to the legacy consumer; `ACLManager` writes ACL docs nothing on v2
  reads. Net: any DID that can reach the websocket can read/write any space —
  which voids the §9 threat-model rows for network adversaries and other users,
  and makes every client-side label guarantee advisory. (No tracking comment
  found, unlike S4's seam.)
- **S2 [hole] `prepareCfc(input)` is a verification bypass on a public
  interface.** Supplying an input skips `prepareBoundaryCommit` entirely
  (`extended-storage-transaction.ts:311-323` — verified); the commit digest only
  confirms the input matches actual activity, not that policy ran. Combined with
  the next item this is reachable, and even alone it's an unguarded TCB edge
  (`storage/interface.ts:746`).
- **S3 [hole] The live transaction is exposed to anything holding a Cell.**
  `CellImpl.tx` is `public readonly` (`cell.ts:610` — verified), and
  `setCfcEnforcementMode` / `prepareCfc` are on the public tx interface
  (`interface.ts:700,746`). Unless a membrane strips it (none found;
  `security.test.ts` has no assertion for it), handler code can disable
  enforcement for its own transaction or pre-prepare with a self-assembled
  digest input. Needs either a membrane test pinning unreachability or moving
  these to an internal surface.
- **S4 [hole] Schema-authored integrity minting is unguarded for non-principal
  atoms.** `derivePersistedLabel` persists `ifc.integrity`/`addIntegrity` from
  pattern-authorable schemas (`prepare.ts:1849-1877`); only
  `authored-by`/`represents-principal` kinds are gated. Anyone who authors a
  schema can mint `InjectionSafe` — the exact atom the prompt-injection screen
  and `requiredIntegrity` consumers trust. Trusted minting (compile cache) and
  forgery share one channel. The client-asserted-label seam is acknowledged for
  compiled-code atoms (`cell-cache.ts:405-417`) but applies, uncommented, to
  every label in the system (server never inspects `cfc` metadata).
- **S5 [hole] `cid:` schema-document poisoning.** Caller-claimed hash, no
  write-side verification, no read-side re-hash (`prepare.ts:2035-2075`). The
  loaded schema drives label derivation for _other_ principals' writes, so a
  same-space writer can alter what labels everyone else persists. Violates §17.6
  ("neither path may silently bypass the other path's access rules"). The
  compile cache shows the correct pattern.
- **S6 [hole] Paramless SQL writes bypass the write ceiling.**
  `checkSqliteWriteCeiling` returns immediately when `params === undefined`
  (`builtins/sqlite/write-ceiling.ts:34`), and the guard allows
  `INSERT … SELECT` / `UPDATE t SET public_col = secret_col` — intra-database
  relabeling that re-emerges under the destination column's (weaker) label. Not
  covered by the documented "source A" deferral in
  docs/specs/sqlite-builtin/06-cfc.md.
- **S7 [hole] Vacuous pass of `requiredIntegrity`/`maxConfidentiality`.**
  Consumed reads are filtered to those with **persisted stored labels**
  (`prepare.ts:1694-1709` — verified) and the checks skip when none remain. A
  handler consuming only unlabeled (or in-flight-schema-labeled, or
  **parent-of-labeled**) inputs writes into a protected slot unchecked. The
  spec's own pseudocode skips on empty consumed sets, but its consumed set
  includes unlabeled inputs as empty-label reads that then _fail_ integrity
  floors — the impl inverts "all inputs endorsed" into "all labeled inputs
  endorsed". Three audit passes found this independently.
- **S8 [hole] SQLite label declarations live in mutable cell data.** Per-column
  `ifc` (read labels _and_ write ceilings) is a plain field of the db-handle
  cell's value (`sqlite-builtins.ts:295,424`); nothing prevents
  weakening/deleting it, and schema-envelope monotonicity never sees it. A
  store's effective label can go down — exactly what §8.12.1 exists to prevent.
- **S9 [hole] labelMap replace-on-write loses accumulated atoms.** A path
  holding link-derived or carried-view confidentiality beyond the schema loses
  those atoms when a later schema-covered write re-derives the label from the
  schema alone (`prepare.ts:2253-2295`); no `canUpdateStoreLabel`-style
  restrictiveness check, no regression test.
- **S10 [hole] `ifc.opaque` silently dropped** by schema-merge
  (`schema-merge.ts:6-19`) — authored opacity claims don't even survive metadata
  persistence. Add to the fail-closed reject list with the other ignored keys
  (`recomposeProjections`, `passThrough`, `combinedFrom`, `transformation`,
  `addedIntegrity`).
- **S11 [hole] Authoring-layer `setSchema` strips the conservative
  confidentiality join without a trust gate.**
  `mapWithPattern`/`filterWithPattern`/`flatMapWithPattern` call the _untrusted_
  `flowPrecisionSchemaForBuiltin` variant and `setSchema` replaces the link
  schema wholesale (`cell.ts:1988,2081,2124`, `cell.ts:1773-1781`), discarding
  the input-confidentiality join `applyInputIfcToOutput` just attached. Exactly
  the §8.9.1 forbidden shape (less-restrictive labeling without verified trust);
  muted today because enforcement rides persisted labelMaps, not declared
  schemas.
- **S12 [hole] Forgeable recognizer evidence + trusted-event replay.**
  `uiContractDataset`/`eventIntegrity` come from pattern-authored `data-*`
  attributes (`packages/html/src/event-provenance.ts:66-95`) — any real click on
  an element the pattern decorates satisfies any contract the same pattern
  declares. And the WeakSet trust mark propagates through `Cell.set` re-emission
  (`cell.ts:1094`, `ui-contract.ts:406-439`) with nothing consumed: one gesture
  can authorize unboundedly many protected writes over time. The anti-synthetic
  half (unmarked events rejected) is solid and tested.
- **S13 [hole] Identity fallback can misattribute writes.** `identityForInput`
  falls back to the transaction's _current_ identity for inputs recorded before
  any identity was set (`prepare.ts:2082-2085`, same in
  `writeAuthorizedByReason`) — partially reopening the cross-context borrowing
  the per-input capture comment says it exists to prevent.
- **S14 [phase-1→hole] `createRef` vs §2.4.** Raw digests with no
  label/integrity envelope; lossy untyped canonicalization (functions →
  `toString`, cycles → null); **fail-open `crypto.randomUUID()` fallbacks** on
  missing cause (`create-ref.ts:25-31,
  66-90`) where the spec requires
  fail-closed; deterministic IDs + open sync = existence probing (§17.1 MUST
  NOT). `fetchJson`'s `inputHash` additionally writes a content- equality oracle
  for possibly-confidential inputs into a shared doc.
- **S15 [hole, adjacent pkg] Render declassification minted by untrusted
  markup.** `declassifyConfidentiality` is read from static VDOM props and
  accumulated down the tree (`packages/html/src/worker/reconciler.ts:360-381`);
  default render policy has no ceiling (every atom renders unless a pattern opts
  into a boundary). Any pattern can wrap a secret in a boundary that
  declassifies it — the unguarded-release shape ch. 5 forbids, currently pinned
  by tests as intended.
- **S16 [phase-1] Value-copy laundering.** Read labeled data, write a derived
  plain value to an unlabeled cell, commit unlabeled, fetch it out (no
  label-gated egress). The default-transition absence; the single biggest
  spec/impl distance. Named here because every other mitigation composes with
  it.
- **S17 [hole] Policy applicability steered by author-controlled link schemas.**
  `wildcardPolicyMatchesValue` falls back to the _written link's embedded
  schema_ when the target is unreadable (`prepare.ts:1509-1535`); a mismatching
  embedded schema makes the policy entry not apply, skipping
  `writeAuthorizedBy`/`requiredIntegrity`/`uiContract` for that write. Should
  fail closed.
- **S18 [phase-1] Enforcement perimeter.** Raw `IStorageTransaction.write` never
  marks relevance; `["cfc"]`/`cid:`/`source` path writes are excluded from
  verification by address pattern (`prepare.ts:887-895`); bare-tx default mode
  is `disabled`; pattern tests default to `observe`
  (`packages/cli/lib/test-runner.ts:835`). All rest on "sandbox keeps raw tx
  away from untrusted code" — which S3 currently undermines.
- **Minor**: empty `maxConfidentiality` array means "no ceiling" not "public
  only" (`observation.ts:76-81`); label-view/display reads swallow errors as "no
  label" (`label-view-state.ts:54-66` — renderer treats undefined as blocked,
  but the LLM observed-confidentiality path treats it as unconfidential,
  stacking with the opt-in ceiling); label metadata at `["cfc"]` is freely
  introspectable incl. `Caveat.source` identities (inv. 12);
  `sink-inventory.ts`/`INITIAL_SINK_ROLLOUT_GATE` and `StorageValue.labels` are
  dormant security-looking code; harness digest c14n inconsistent with runner
  c14n.

## What is implemented well (don't "fix" these away)

Commit gate fails closed in enforce modes incl. digest-drift rejection and
read/write-after-prepare invalidation; sink release verifies against the
**prepared** snapshot and skips on mismatch; projection/collection claims
rejected fail-closed; schema-merge monotonicity directions match the spec and
are tested; link-write label derivation merges source metadata + link schema and
mints provenance, failing closed on missing source metadata; exact-copy happy
path with granularity-independent value reconstruction; rendered-text authorship
boundary (blocked placeholder, literal-text blocking) is the most spec-faithful
piece of ch. 6; SES/cfreg sandbox surface is credible (modulo S3); sqlite
write-ceiling parser is genuinely fail-closed for the bound-param shapes it
covers; InjectionSafe sanitizer matches §8.10.5 including the
stricter-than-JSON-Schema closed-object rule.

---

## Suggested fix order (everything except next-phase work)

Ordering logic: close the bypasses first (a gate that can be switched off isn't
a gate), then make the verifier's inputs trustworthy (checks over forgeable
labels are theater), then fix check semantics (false passes), then harden
event/egress surfaces, then profiles and hygiene. Sizes: S = hours-to-a-day, M =
days, L = a week+.

Cross-cutting discipline: failing test first for every item (red-green); small
commits; every semantic _tightening_ lands in observe mode and rides the
diagnostics channel before flipping to enforce; the "implemented well" list
above is the do-not-regress set.

### Remediation status — updated 2026-06-11

The four wave bundles landed the bulk; several items had focused follow-up PRs,
and a few sub-aspects remain phase work. Conservative status (✅ merged · ⚠️
partial / sub-aspect deferred · 🔜 next-phase):

| Item                                                                                  | Status | PR(s) / note                                                                                                                                                           |
| ------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1–8 — Wave 0 (S2, S3, S13, S17, S10, flow-precision, empty-maxConf, S14-min)          | ✅     | #3970                                                                                                                                                                  |
| 9 cid: verify (S5), 10 integrity-mint (S4)                                            | ✅     | #3972 (Wave 1)                                                                                                                                                         |
| 11 `["cfc"]`/`cid:`/`source` chokepoint (S18)                                         | ✅     | #3972, #3996 (+ follow-up #4029)                                                                                                                                       |
| 12 SQLite column `ifc` (S8)                                                           | ✅     | #4021 — grow-only monotone merge                                                                                                                                       |
| 13 default-mode + cf-test enforce flip                                                | ✅     | #3999                                                                                                                                                                  |
| 14 vacuous-pass + ancestor reads (S7)                                                 | ⚠️     | #3973 (Wave 2) + #4015 (provenance-only reads don't gate); vacuous-pass tightening deferred (needs per-write provenance)                                               |
| 15–18 — exactCopyOf, shared schema-IFC walker, integrity meet, labelMap monotone (S9) | ✅     | #3973 (observe-first)                                                                                                                                                  |
| 19 SQL ceiling (S6), 20 trusted-event (S12), 23 sink-flush surfaced                   | ✅     | #3975 (Wave 3)                                                                                                                                                         |
| 21 label-aware sink ceiling                                                           | ✅     | #3993                                                                                                                                                                  |
| 22 LLM-observation fail-closed                                                        | ✅     | #4025 — read-error ≠ "no label"; ungrantable marker                                                                                                                    |
| 24 `writeAuthorizedBy` union                                                          | 🔜     | next-phase ("coming soon")                                                                                                                                             |
| 25 harness fixes                                                                      | ⚠️     | partly via wave bundles; not independently verified                                                                                                                    |
| 26 render declassification (S15)                                                      | ✅     | #3994 — default-allow knob; product revisit pending                                                                                                                    |
| 27 `enforce-strict` semantics                                                         | ✅     | no code — already distinguished (fuse `cfc-writeback` requires `parentAnnotation`)                                                                                     |
| 28 hygiene                                                                            | ✅     | #4051 (28a dead-code) · #4052 (28b `Caveat.source` redaction at the `getCfcLabel` response) · 28c `/value` equivalence already documented · 28d §15 registry spec-side |
| A1 session ACL (S1)                                                                   | ✅     | #3989                                                                                                                                                                  |
| A2 server sole-acceptor of `["cfc"]`/`cid:`                                           | 🔜     | next-phase                                                                                                                                                             |

Adjacent work also landed: S16 default-transition / flow-label propagation
(#4011, #4012); content-addressed action identity B/C/D (#4008, #4009, #4013);
one-runtime-per-identity (#3995). Still genuinely open: #24, A2, the S7
vacuous-pass tightening, and same-tx instantiation + link-write.

### Wave 0 — close the bypasses (all small, independent)

1. **`prepareCfc(input)` bypass (S2)** — always run `prepareBoundaryCommit`; the
   input param only feeds digest computation (or move it to an
   internal/test-only surface). Test: a caller-supplied input cannot skip a
   policy reject. (S)
2. **Tx control surface off the public interface (S3)** —
   `setCfcEnforcementMode` / `prepareCfc` off `IExtendedStorageTransaction`
   (internal interface), plus a security.test.ts case pinning that sandboxed
   handler code can't reach `cell.tx` controls. (S–M)
3. **Identity fallback (S13)** — drop `?? state.implementationIdentity`;
   unattributed write-policy inputs fail closed in enforce modes. (S)
4. **Author-steered applicability (S17)** — `wildcardPolicyMatchesValue`:
   unresolvable link target under a value-conditioned entry ⇒ entry _applies_
   (fail closed). (S)
5. **Reject unsupported `ifc.*` keys (S10 + key drift)** — `opaque`,
   `recomposeProjections`, `passThrough`, `combinedFrom`/`combinationType`,
   `transformation`, spec-spelled `addedIntegrity`: prepare-reject +
   schema-merge preserves-or-rejects instead of silently dropping. (S)
6. **Defuse the flow-precision time bomb** — condition claim attachment on
   `inferListOpArgumentUsage` (no pointwise claim when the op reads
   `array`/`params`). (S)
7. **Empty `maxConfidentiality` semantics** — declared-empty = deny-all (or
   reject empty arrays at authoring); pick one and pin it. (S)
8. **`createRef` fail-open fallbacks (S14-minimal)** — replace `randomUUID()`
   fallbacks with throws; survey call sites first, stage warn→throw if needed.
   Full TrustedDerivedId envelope stays phase work. (S code, M fallout risk)

### Wave 1 — make the verifier's inputs trustworthy

9. **`cid:` schema-doc verification (S5)** — read-side re-hash à la
   `verifySourceDocs`/compile-cache; assert hash on write. (S–M)
10. **Integrity-mint gating (S4)** — split author-mintable _claims_ from
    runtime-only _evidence_ families (`InjectionSafe`, compiled-code,
    provenance); deny evidence families in plain schema
    `integrity`/`addIntegrity`; sanitizer + compile cache mint via a privileged
    channel. Needs a short design note — subtlest item in the wave. (M)
11. **Chokepoint guard for `["cfc"]`/`cid:`/`source` writes (S18-partial)** —
    explicit privileged-writer assertion at the extended-tx layer instead of
    address-pattern exclusion in `valueWriteTargets`. (S–M)
12. **SQLite column `ifc` out of mutable cell data (S8)** — move into the schema
    envelope or guard handle-cell writes with monotone merge over
    `tables[].ifc`. (M)
13. **Default-mode hardening** — bare-tx default `disabled` → runtime-inherited
    (or `observe`); cli pattern-test default `observe` → `enforce-explicit` (do
    the test flip _after_ Wave 2 lands to avoid churn against the old
    semantics). (S each, M fallout)

### Wave 2 — verifier semantics: the false-pass cluster (observe-first rollout)

14. **Vacuous pass + ancestor reads (S7)** — unlabeled consumed reads enter the
    consumed set with empty labels (so `requiredIntegrity` fails without
    witnesses); `labelAtPath` aggregates descendant labelMap entries for
    ancestor reads (subtree join). The biggest behavioral change in the plan;
    expect false-fail fallout — observe, watch diagnostics, then enforce. (M–L)
15. **`exactCopyOf` repairs** — immediate: reject wildcard (`*`) claim paths
    fail-closed; then wildcard expansion if patterns need it; add
    `ifcEntryAppliesToAttemptedWrite` gating; copy the source's _stored_ label
    (not just schema-declared); kill the `undefined`/`undefined` vacuous pass.
    (M)
16. **One shared schema-IFC walker** — `joinSchema` gains
    `anyOf`/`oneOf`/`allOf` descent (+ `prefixItems`,
    `items`+`additionalProperties` TODO), or both paths extract a common walker;
    conflicting branch-local `ifc` rejected consistently per §4.2.1.1. (M)
17. **Integrity meet where combination happens** — same-path distinct-write
    coalescing stops unioning integrity (last verified write wins, or
    intersect); sqlite null-origin integrity → empty pending propagation classes
    (closes CT-1668). Keep union only for link/endorsement _refresh_ merges and
    document the distinction. (M)
18. **labelMap monotone update (S9)** — merge persisted entries with grow-only
    confidentiality instead of replace; regression test: link-derived atoms
    survive a later schema-covered write. (S–M)

### Wave 3 — events and egress

19. **Paramless SQL ceiling bypass (S6)** — writes against ceiling-bearing dbs
    require attributable shapes; `INSERT…SELECT`/`UPDATE col=col` verify
    source-column labels fit the destination ceiling, else reject. (M)
20. **Trusted-event hardening (S12)** — nonce-unique event ids; consume-on-use
    (session-scoped) so one gesture authorizes one matching write; verify
    provenance against the runtime-serialized envelope, not candidate-embedded
    data; runtime-mint or remove the `eventIntegrity` string channel; stop
    WeakSet-mark propagation through handler re-dispatch. Biggest design item of
    the wave. Full §7.3 payload-digest binding stays phase work. (M–L)
21. **Minimal label-aware sink ceiling** — join request-input confidentiality
    (carried views + stored labels reachable from request cells) against
    per-sink `maxConfidentiality` from `sink-inventory.ts` (activates the
    dormant module). Limited until the default transition (phase) closes
    laundering, but gates direct flows. (M)
22. **LLM observation path fail-closed** — metadata read errors are errors, not
    "no label" (`label-view-state.ts:54-66` consumer side). (S)
23. **Sink-flush failures surfaced** — `cfcInstrumentation` + diagnostics
    instead of `console.warn`-and-drop. (S)

### Wave 4 — profiles, authority, hygiene

24. **`writeAuthorizedBy` union composition** — accept arrays of verified
    `__ctWriterIdentityOf` bindings; transformer emit support (§8.15.2/§8.15.8).
    (M)
25. **Harness fixes** — canonical digests via `value-hash` (not
    `JSON.stringify`); verify `PromptSlotBinding` digests/eventId when present;
    enforce modes require a verified eventId for `direct-command`. Registry
    snapshots stay phase work. (M)
26. **Render declassification (S15)** — `declassifyConfidentiality` requires
    verified authority (interim: trusted-chrome components only, or remove the
    prop); revisit the default-allow render policy. Product decision involved.
    (M)
27. **`enforce-strict` gets real semantics or is removed** — e.g. strict =
    explicit + reject unknown sink names + no observe escape hatches; decide
    after Wave 2. (S)
28. **Hygiene** — delete `StorageValue.labels`; redact `Caveat.source` in
    label-view introspection (full inv-12 labeling stays phase); `/value` prefix
    wire-format decision (fix or document equivalence); spec §15 registry sync
    (`LinkReference`, `PromptSlotInfluence`, caveat alias kind strings). (S
    each)

### Track A — server (parallel from day 1)

- **A1. Session ACL (S1)** — ownership/membership check in
  `authorizeSessionOpen` / v2 server (port legacy `checkACL` semantics or a
  space-owner check). Everything client-side assumes this boundary exists. (M–L)
- **A2. Server-side acceptance of `["cfc"]`/`cid:` writes** — the stated
  end-state in `cell-cache.ts:405-417` ("server becomes the sole acceptor").
  Borders on phase-2 scope, but A1 alone restores the space boundary. (L)

### Explicitly excluded as next-phase work

Policy calculus (records, exchange rules, declassification, fixpoint), CNF
clause algebra, the intent lifecycle (incl. full §7.3 request binding), trust
lattice/delegations, the TrustedDerivedId envelope, read-time access checks,
expiry, projection/collection claim _support_ (they stay fail-closed), default
transition + PC propagation (S16 value-copy laundering), §17 CAS
`labelBindings`/`expectedLabel`, observation op classes, per-row sqlite labels,
`RenderRef`/`snapshotDigest`, harness registry snapshots, §11.2 static analysis.
Waves 0–2 convert these from "silently absent" to "visibly rejected or
fail-closed", which is the correct resting state until each phase lands.
