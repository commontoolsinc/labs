# S16 Design — Default Label Transition (Flow-Label Propagation)

Date: 2026-06-10. Companion to `cfc-spec-audit.md` (S16: value-copy laundering).
Spec inputs: §8.9 (propagation), §8.10 (boundaries), §8.11 (content vs flow),
§8.12 (store monotonicity), §4.6 (reactive integration, storage envelope), ch.
14.4.2 (contamination scoping). A running list of spec edits this design needs
is kept in `cfc-spec-changes.md` — items referenced as **SC-n** below.

## 1. Problem

The runner persists only schema-declared labels and verifies declared
constraints. It never derives output labels from input labels. So: read labeled
data, write a derived plain value to an unlabeled cell, commit, fetch it out —
the label is gone (audit S16). The spec closes this with the default transition
(§8.9.3: output confidentiality = CNF join of all input confidentiality) plus PC
propagation (§8.9.2: everything observed in the attempt's journal taints all
outputs). Every other audit mitigation composes with this one; it is the single
biggest spec/impl distance.

Two halves, both required:

- **Propagation** (this design): outputs of a transaction get labels derived
  from what the transaction read.
- **Egress** (audit Wave 3): at least one enforced label-gated release check per
  channel class, so the propagated labels bite. Propagation without egress
  gating changes nothing observable; egress without propagation is laundered
  around. §10 below inventories the egress seams this design feeds.

## 2. Verified ground truth the design rests on

| Fact                                                                                                                                                        | Evidence                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| One action = one fresh tx; no sharing, no long-lived txs                                                                                                    | `scheduler/action-run.ts:308`, `scheduler/events.ts:429`; commit at `action-run.ts:452`, `events.ts:501` |
| lift/computed/derive run through the same one-tx-per-run path                                                                                               | `builder/module.ts:353-391,517-522`                                                                      |
| map/filter element ops run in their own per-element txs; the coordinator reads the list as links only (`items: { asCell: ["cell"] }`), never element values | `builtins/map.ts:15-20,114,157-162,201-230`                                                              |
| Internal reads are metadata-marked (`ignoreReadForScheduling`, `internalVerifierRead`), not address-distinguished                                           | `storage/reactivity-log.ts:25-54`, `cell.ts:1778-1779`                                                   |
| Persisted labels: `CfcMetadata { version, schemaHash, labelMap.entries[{path,label}] }` at doc path `["cfc"]`, written by `prepareBoundaryCommit`           | `cfc/types.ts:131-141`, `cfc/prepare.ts:2479-2494`                                                       |
| labelMap update today: per-path grow-only union merge                                                                                                       | `cfc/prepare.ts:2114-2135,1994-2003`                                                                     |
| Read-side resolution: `labelAtPath` = longest ancestor-or-equal prefix only (no descendant aggregation — audit S7); label views do two-way rebase           | `cfc/prepare.ts:68-90`, `cfc/label-view-core.ts:133-164`                                                 |
| Link reads contribute via dereference traces + carried views                                                                                                | `link-resolution.ts:57-66`, `cfc/label-view-state.ts:68-96`                                              |
| Write targets exclude `cid:`, `["cfc"]`, `["source"]`, `["internal"]`+link                                                                                  | `cfc/prepare.ts:887-895`                                                                                 |
| CFC relevance is caller-marked (link writes, schema-ifc reads/writes, sqlite row labels), not computed                                                      | `data-updating.ts:198`, `schema.ts:968`, `cell.ts:242,1086`                                              |
| `["cfc"]` writes cannot wake value readers: trigger match requires component-wise path overlap and subscriptions are at `["value",…]` paths                 | `reactive-dependencies.ts:231-246` (`arraysOverlap`), `scheduler/trigger-index.ts:301`                   |
| Flow-precision claims are minted but consumed by nothing                                                                                                    | audit §1a; `cfc/flow-precision.ts`                                                                       |

## 3. Design decisions

### D1 — The boundary is the transaction; the conservative label is one join per tx

Spec §8.9.2's conservative PC is the join of _every_ observation in the
attempt's journal, and §8.9.3's default output confidentiality is the join of
_all_ input confidentiality. Without trusted flow-precision claims, every output
path therefore gets the same label: **join of everything read**. So phase A
computes exactly one joined label per transaction:

```
J(tx) = ⋃ { resolveReadLabel(r).confidentiality
            | r ∈ tx.reads, not internal, not excluded-address }
      ∪ ⋃ { labels carried via dereference traces recorded in tx }
      ∪ ⋃ { trigger labels (phase A2, §5) }
```

- Flat atom-set union with structural dedup — the CNF join degenerates to set
  union for all-singleton clauses, which is all the impl represents (§8.12.1
  note blesses this; SC-12).
- `resolveReadLabel` must use **subtree-join** semantics: ancestor-or-equal
  longest-prefix _plus_ aggregation of labelMap entries strictly below the read
  path. This is audit Wave 2 #14 (S7's `labelAtPath` fix) and is a hard
  prerequisite — without it a parent-object read of a labeled field contributes
  nothing to J.
- Excluded reads: metadata-marked internal reads, plus the address-pattern
  mirror of the write-side exclusions (`["cfc"]`, `["source"]`, `cid:` docs).
  Program text and schema docs do not taint outputs (profile decision, SC-6;
  revisit when label-metadata confidentiality — invariant 12 — lands).
  The `["cfc"]`/`["source"]` patterns match the **raw** document paths (root
  siblings of `value`), not canonicalized logical paths — a user field named
  `source` lives at raw `["value","source"]` and is *not* excluded, on either
  the read or the write side (PR #4011 review).
- Content labels and flow labels deliberately collapse into one join (§8.11.4
  stores them in one array; at tx granularity the distinction is conceptual).

### D2 — Every value write target gets the derived label; persistence is per-path with provenance components

For each target in `valueWriteTargets` (existing exclusions unchanged), the
prepared commit persists a **derived** label component at the written path. The
labelMap entry format grows a provenance tag (wire version 1→2, SC-1):

```ts
// Shown at module scope.
type LabelMapEntry = {
  path: readonly string[];
  label: IFCLabel;
  origin: "declared" | "link" | "derived"; // v2; absent = "declared" (v1 compat)
};
```

Per-component update rules — this is the load-bearing change, and it subsumes
audit Wave 2 #18 (S9) instead of patching it:

| Component  | Source                                                   | Update rule                                                                                                                                                                                                   |
| ---------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `declared` | schema `ifc` (`derivePersistedLabel`)                    | grow-only monotone merge, exactly today's schema-merge discipline (§8.12 store-label monotonicity applies **here**)                                                                                           |
| `link`     | link writes + carried views (`derivePersistedLinkLabel`) | replaced when the link at that path is rewritten; merged with nothing                                                                                                                                         |
| `derived`  | this design: `J(tx)` at commit                           | **replace-on-overwrite**: last attempted write to the path in the committing tx sets it (§8.10.2.2 last-write-wins); an ancestor write **clears derived entries strictly below it** (the old subtree is gone) |

Read-side resolution (labelAtPath, label views, input-requirement checks, egress
checks) joins all components — so a doc with a declared policy _and_
runtime-derived taint shows both, and a later schema-covered write can no longer
erase link/derived atoms (S9 fixed by construction, not by adding a
restrictiveness check to a conflated map).

**Why replace-on-overwrite is sound** (and the union ratchet is not needed): the
derived component describes the _current value_ at the path. If tx T2 overwrites
a path whose old value was secret-derived, then either T2 read something secret
(its own J covers the new value) or it didn't (the new value genuinely isn't
secret-derived; reads of the old value journaled the old label at read time, so
nothing retroactive is lost). §8.12's monotone ratchet governs the **store
policy** (declared component), not per-value data labels — the spec needs to say
this explicitly (SC-1, SC-2). Residual channels are §7.2-7.3.

Skip-if-unchanged is mandatory: if the recomputed components equal the persisted
ones, no `["cfc"]` write is issued. Reactive re-runs re-derive identical J
constantly (reload re-runs ~39 actions); without the skip we'd churn storage and
network on every recompute. Equality = canonical structural compare (existing
`cfcLabelViewsEqual` shape, `label-view-core.ts:166-174`).

Entry-count hygiene: an entry whose label equals the effective label of its
parent entry is redundant and must be dropped at persist time (§4.6.4
operational guidance already permits this).

### D3 — Relevance becomes computed, not caller-marked

Today `markCfcRelevant` is a manual call at four sites; a plain value write to a
labeled doc relies on the writer remembering to mark. With the default
transition, relevance is a property of the journal:

```
relevant(tx) ⇔ ∃ read of a doc with nonempty labelMap (or carried view)
             ∨ ∃ value-write target whose doc has a nonempty labelMap
             ∨ explicitly marked (existing sites stay)
```

The second disjunct is required so an unlabeled-input tx that overwrites a
labeled path still runs prepare (to enforce declared policy and to clear/replace
the derived component). The fast path is the complement: a tx that reads only
unlabeled docs and writes only unlabeled docs does **zero** CFC work beyond a
per-doc "has labels?" flag check (§8 perf).

### D4 — Pointwise precision comes from transaction granularity, not from flow-precision claims

Verified: `map`'s coordinator tx reads the list as an array of cell links
(`MAP_LIST_SCHEMA`, `builtins/map.ts:15-20`) and passes `element` as a Cell;
each element op runs in its own tx that reads only its element. Under D1/D2 this
yields exactly the §8.5 split with no extra machinery:

- element output label = that element's taint (per-element tx J),
- result-container label = the list container/structure taint (coordinator J:
  array shape + link identities, **not** element contents),
- filter/flatMap membership/length taint = the coordinator's J, which includes
  whatever the predicate results it read carry — closing the §8.5.6.1 membership
  gap the audit flagged as permissive-by-default.

Consequences:

1. `ifc.flowPrecisionClaim` is not needed for the precision it was staged for —
   minting has been **deleted** (decision §13.3; this branch). The key stays
   reserved-and-tolerated for already-persisted schemas (SC-7).
2. The "blind passing" idiom (pass cells/links, don't `.get()`) is the
   runner-native realization of §8.13 opaque inputs: not reading is what avoids
   taint, and the journal already tells the truth. Phase A needs no `ifc.opaque`
   propagation support; `opaque` remains in the fail-closed reject set (Wave 0
   #5). Builtin coordinators that today materialize values they only pass
   through should be audited and narrowed to link reads instead (each narrowing
   is a real precision win under D1).
3. An op that _does_ read the whole array (`usesArray`) taints its outputs with
   the whole array — correct and conservative.

### D5 — Phase A derives confidentiality only; integrity comes later

§8.9.3 also wants `TransformedBy{codeHash, inputs}` plus the hereditary-atom
meet on outputs. The impl currently attaches no integrity to computed outputs
(fail-safe under-claim). Phase A keeps that posture: derived component carries
`confidentiality` only, `integrity` stays empty. Phase C adds (in order): a
propagation-class registry per atom type (hereditary vs value-bound — needs the
§15 registry table, SC-10), the hereditary meet across inputs, then
`TransformedBy` minting using the existing implementation-identity machinery
(`bundleId`/`sourceFile`/`bindingPath` bindings) as the code identity.
Confidentiality-first staging needs a spec conformance note (SC-9). Note the
same-path integrity-union bug (audit Wave 2 #17) must land before phase C so the
meet isn't fed by unsound unions.

## 4. The prepare-time algorithm (delta to `prepareBoundaryCommit`)

1. Relevance check per D3 (cheap flags; bail to fast path if not relevant).
2. Build the consumed set from `tx.getReadActivities()` minus internal +
   excluded reads — the _same_ set already assembled for input-requirement
   checks (`prepare.ts:1713-1728`), but **without** the filter-to-label-bearing
   step for J's purposes (unlabeled reads contribute nothing to J anyway; the S7
   fix separately makes them visible to `requiredIntegrity` as empty labels).
3. Resolve each read's label: persisted labelMap (subtree join) ⊕ carried view /
   dereference-trace contributions (`cfcLabelViewForDereferenceTraces`,
   `label-view-state.ts:78-86`). Join everything into `J`.
4. For each value write target, stage the labelMap delta for the target doc:
   upsert `derived` entry at the canonical write path with `J` (last write per
   path wins), drop `derived` entries strictly below it, keep `declared`/`link`
   entries untouched (their existing derivation paths run as today), collapse
   redundant children, skip if net-unchanged.
5. Existing declared/link verification and persistence proceed unchanged; the
   staged metadata write goes into the same prepared digest so the commit-time
   recheck covers it (S2's "digest must cover that verification ran" fix applies
   here too).

No enforcement decision changes in phase A: deriving and persisting J is pure
propagation. Enforcement continues to live in the existing consumers (input
requirements, write ceilings) and the Wave 3 egress checks.

## 5. Phase A2 — trigger labels (reactive PC completion)

§8.9.2 requires PC to include "trigger or gating reads that determined whether
the handler ran at all". At tx granularity the journal covers everything the run
read — except _why it ran_. The residual channel: dep X (labeled) changes; the
rerun takes a branch that never re-reads X and writes a public flag — "X changed
now" leaks as write timing/existence (~1 bit per change event).

Fix: when the scheduler dirties an action, record the invalidating write
addresses (the trace plumbing in `scheduler/dirty-dependencies.ts` /
`trigger-index.ts` already identifies them diagnostically); at prepare time join
those addresses' current labels into J. Event-handler runs need nothing extra —
the event payload read is in the journal already.

Separable from A1 (strictly additive to J), spec profile text needed for how a
dependency-scheduled rerun defines its trigger set (SC-3).

## 6. What phase A explicitly does not do

- No CNF clauses, no exchange rules, no declassification — over-taint has no
  policy relief valve yet; the relief valves that do exist are structural
  (per-element txs, link passing, replace-on-overwrite) (ch. 14.4.2 is the
  acknowledged open problem; §9 risks).
- No observation classes (`shape`/`value`/`iterate` of §4.6.3) — one label per
  path covers all observation kinds (SC-4, SC-8 record the consequences).
- No read-time access checks, no expiry, no sink request binding — unchanged
  audit phase exclusions.
- No retroactive relabeling: if a source's label grows after an output was
  derived, the output keeps its point-in-time label until something rewrites it.
  With monotone declared sources and replace-on-rederive this self-corrects on
  the next recompute of live reactive nodes; cold copies stay stale-low (SC-2
  asks the spec to state the intended model).

## 7. Soundness notes and residual channels

1. **Laundering (S16 core)**: closed for any flow that transits a committed tx —
   the write carries J, and J survives further hops via D1+D2. Combined with
   egress gating (§10) the audit's fetch-it-out exit is label-checked.
2. **Existence/creation channel**: a derived entry replaced by a public
   overwrite shrinks the _whole-path_ label, including what §4.6.3 would call
   `shape`; "this path was once written" can persist as a public 1-bit fact.
   Accepted residual until observation classes (SC-4).
3. **Trigger timing** pre-A2: §5's ~1-bit-per-change channel. A1 ships with it
   documented; A2 closes it.
4. **Whole-doc (empty-path) subscriptions**: trigger matching means a subscriber
   at path `[]` would be woken by `["cfc"]` writes. Audit found value
   subscriptions live under `["value",…]`; implementation must assert (test)
   that no system path subscribes at the envelope root, or labelMap writes need
   a dedicated notification carve-out.
5. **Cross-space**: J flows into write targets in other spaces; derived atoms
   persisted there expose label metadata to that space's readers — invariant-12
   territory, deferred with a profile note (SC-14).
6. **Forgeable inputs**: J is computed from persisted labels and carried views;
   S4 (unguarded integrity minting) and S5 (`cid:` poisoning) feed the
   verifier's inputs and stay on the Wave 1 critical path. Propagated
   confidentiality is union-only, so forged _confidentiality_ can only
   over-taint (annoying, not unsound); forged integrity is the dangerous
   direction and is phase C's gate.

## 8. Performance plan

- **Fast path**: per-doc `hasCfcLabels` flag maintained on doc load and labelMap
  write; relevance check is O(reads) flag lookups on in-memory docs. A tx
  touching no labeled docs pays only that.
- **Label-bearing txs**: J is one pass over the consumed set with memoized
  per-doc metadata reads (piggyback the per-tx read cache from PR #3899); atom
  dedup via the existing structural-dedup helpers.
- **Churn control**: skip-if-unchanged comes for free — the storage journal's
  novelty diffing elides value-identical writes before they become commit ops
  (verified: an identical recomputed labelMap produces zero `["cfc"]` write
  details; pinned in `cfc-labelmap-components.test.ts`). Plus
  `["cfc"]`-writes-don't-wake- value-readers (verified): reactive load stays
  flat; storage/network sees labelMap writes only when taint actually changes.
  The prepare-side cost of recomputing + serializing the candidate metadata each
  relevant tx remains (acceptable; revisit only if profiling says otherwise).
- **Blast-radius metrics before enforcement**: extend `cfcInstrumentation` (the
  `onRelevantTx` seam exists, `extended-storage-transaction.ts:161-170`) with:
  relevant-tx %, J size distribution, labeled-doc count growth, labelMap bytes
  per doc, derived-entry replace/clear counts. These run in observe mode and
  decide the persist flip.
- **Benches**: add a labeled-variant to the existing default-app perf benches
  (note-create path) + a reload bench with N labeled docs; guard the fast path
  with a zero-labels bench asserting no measurable regression.

## 9. Risks

| Risk                                                                                              | Exposure                                                                       | Mitigation                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Over-taint spread (UI state, scaffolding, instantiation writes all inherit J of busy handler txs) | UX: spurious ceilings/blocks once egress gates land; semi-sticky via labelMaps | replace-on-overwrite (not ratchet); per-element tx granularity; link-passing idiom; observe-mode blast-radius metrics gate the flip; ch. 14.4.2 scoping is acknowledged future work |
| Reload/perf regression                                                                            | default-app reload re-runs ~39 actions; each prepare now joins labels          | fast path (no labels → no work); skip-if-unchanged; benches in CI before flip                                                                                                       |
| Wire-format migration (labelMap v2 `origin`)                                                      | persisted docs                                                                 | additive field; absent = `declared`; single-reader format (runner); version-gated write                                                                                             |
| Label-metadata write conflicts (two txs writing one doc's labelMap)                               | storage conflicts/retries                                                      | labelMap delta computed at prepare from latest metadata; commit conflict → normal retry rereads metadata (same discipline as value writes)                                          |
| sqlite builtins (per-column/row labels in cell data, S8)                                          | derived J double-counts or misses column labels                                | sqlite read path already resolves its own labels; J consumes whatever the journal + labelMaps expose today; S8's move-into-envelope lands independently (Wave 1 #12)                |

## 10. Egress inventory (where J must eventually bite)

Owner decision (2026-06-10): **rendering is the first egress channel to gate.**
The declassify-prop half of S15 is handled by PR #3994
(`renderDeclassificationPolicy` knob: `allow` default today, `deny` available;
verified-authority gating deferred). The remaining phase-D piece is the
**default render ceiling**: the reconciler's existing `maxConfidentiality` bound
(`childRenderPolicyForNode` → `canRenderCellUnderPolicy`) gets a default policy
of roughly _acting-user identity atoms + an allow-list of caveat-kind label
classes_, admitted by default and tightened over time (SC-16 specs the profile).
Text-integrity render boundaries (`<cf-cfc-authorship verifyTextIntegrity>`) gate
this same render egress channel and follow the same monotonic-composition
discipline — see
[`cfc-render-boundary-composition.md`](./cfc-render-boundary-composition.md)
(confidentiality narrows/intersects; text integrity unions/ANDs; nesting only
tightens). CT-1796.

| Channel                       | Check today                                                                              | With propagation                                                                                                                          |
| ----------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Render/display (**first**)    | authored-by boundaries; opt-in `maxConfidentiality` bounds; declassify knob per PR #3994 | derived labels reach the render label views automatically; default ceiling = user identity + allow-listed caveat classes, tightened later |
| Sink requests (network)       | replay fidelity only (`sink-request.ts:51-82`)                                           | Wave 3 #21 (after render): join request-input labels (now including derived) vs per-sink `maxConfidentiality` from `sink-inventory.ts`    |
| LLM prompt assembly           | observed-confidentiality treats errors as "no label"                                     | Wave 3 #22 fail-closed + derived labels flow in via label views                                                                           |
| Handler→protected-slot writes | `maxConfidentiality` input checks (vacuous-pass S7)                                      | Wave 2 #14 makes them sound; derived labels make them meaningful for computed data                                                        |
| CLI/FUSE reads                | none (acting user = owner)                                                               | unchanged in phase A; revisit with multi-user spaces + server ACL (Track A)                                                               |

## 11. Phasing and prerequisites

Status update (2026-06-10, post-design): audit Waves 0–3 landed on main (#3970,
#3972, #3973, #3975) — S2/S3 closed, Wave 2 shipped exactCopyOf gating, CT-1668,
joinSchema descent, and **S9 as a grow-only union ratchet** (prior + ancestor
confidentiality unioned into every re-written path's label — a deliberate
stand-in for the missing default transition). W2.14 (S7) did NOT land;
implemented in this branch as `effectiveReadLabel` (recursive reads join
descendant labelMap entries; non-recursive reads keep ancestor-or-equal).
Verified read-granularity ground truth: schema'd traversal records leaf reads
_plus_ a recursive root read; `getRaw()` and uninspected schema-less gets record
only the recursive root read — that was the live S7 hole. Consequence of the
root read: any doc read joins the doc's full label set (within-doc precision
deferred to observation classes, SC-8). Sequencing constraint: the Wave 2
grow-only ratchet must be replaced by component update rules **in the same arc
as J** — removing it earlier reopens a laundering window, since the ratchet is
currently the only thing carrying taint across value overwrites.

- **A0 (prerequisites)**: ~~S2/S3~~ (landed, Wave 0); subtree-join read
  resolution (S7 — **done**, this branch, `effectiveReadLabel`); labelMap v2
  component schema (**done**, this branch — origin tags, per-component
  coalesce/resolution); skip-if-unchanged (**done** — provided by journal
  novelty diffing, pinned by test).
- **A1 (core)** — **done, this branch**: `cfcFlowLabels` dial; computed
  relevance with self-minted-metadata exclusion; J over consumed reads +
  dereference traces; derived-component persistence with replace-on-overwrite +
  ancestor clearing + written-path collapse; ratchet restricted to legacy
  entries under persist; derived entries exempt from the schema-write-policy
  guard; laundering repro green end-to-end (propagation + existing
  maxConfidentiality egress). Notable journal-truth finding: `cell.set()` reads
  the prior value, so a set-overwrite of a tainted doc conservatively re-derives
  the taint; only read-free writes (raw root writes) shed it.
- **A1 (core)**: computed relevance + fast path; J computation; derived
  component persistence (replace + descendant clear + collapse); dials (§12);
  instrumentation + benches. Red-green: the laundering repro (read labeled →
  write derived → read back unlabeled) lands first as a failing test, plus
  do-not-regress tests for map element/container split.
- **A2**: trigger labels via scheduler invalidation sources.
- **B (precision/relief)** — **done, this branch**: the pointer/content split
  (SC-8). Link-resolution reads are probe-marked and skipped by the flow
  derivation; link-origin labelMap entries are excluded from J
  (`effectiveReadLabel({excludeLinkOrigin})`); link-covered writes aren't
  stamped (per-slot link labels are the pointwise answer);
  `flowPrecisionClaim` minting deleted (§13.3). Membership taint (§8.5.6.1):
  pure-link-structure container writes get exact-path **`structure`** stamps
  with J — a fourth labelMap component labeling the container's shape
  (membership/key set/order/length). Shape observers (reads at exactly the
  container path, recursive ancestor reads) join it; reads strictly below
  (slot pointer reads, dereferences, per-slot triggers) don't — that
  asymmetry closes the filter length/enumeration channel without re-smearing
  the per-element split, and keeps a reconciler's batch-first-run residue
  confined to shape taint instead of feeding back into later per-element
  results. Bare link leaves and removals stay unstamped (blind passing;
  SC-4 existence residual). Pre-component readers treat `structure` as
  covering — over-taint, fail-safe. Residual: observing WHICH element sits
  at a slot via pointer identity alone (no dereference) escapes the shape
  stamp — placement rides the slot's link entry only; full closure needs
  observation classes (SC-4/SC-8).
- **C (integrity)**: propagation-class registry (§15 + SC-10); hereditary meet;
  TransformedBy minting on implementation identity; reconcile §4.6.1 vs §8.9.3
  (SC-15); requires Wave 2 #17 (integrity-union fix) and Wave 1 #10 (mint
  gating).
- **D (egress activation)**: render first — default render ceiling (acting-user
  identity + allow-listed caveat classes; on top of PR #3994's declassification
  knob), then Wave 3 #21/#22 (sink ceilings, LLM path), all consuming derived
  labels.

## 12. Rollout dials and testing

New runtime option `cfcFlowLabels: "off" | "observe" | "persist"`, orthogonal to
the enforcement-mode ladder (which governs _rejection_, not propagation; SC-13
specs the combined matrix):

- `off` — today's behavior.
- `observe` — compute relevance + J, emit diagnostics/metrics and would-persist
  deltas; write nothing. A development/debugging tool and a brief sanity stage,
  **not** a metrics-gated rollout ceremony (owner decision 2026-06-10: build it
  and fix after, tests green is the bar — propagation rejects nothing, so the
  audit's observe-first discipline for semantic tightenings doesn't apply here;
  the first actual tightening is the phase-D render ceiling, which has its own
  knob-then-flip path per PR #3994).
- `persist` — write derived components. Enforcement consumers then see them
  under the existing enforcement modes; no new rejection class is introduced by
  this design itself.

Testing: unit (J join semantics, component update rules, descendant clear,
skip-if-unchanged); integration repros for S16 laundering, map pointwise split,
filter membership taint, link pass-through parity (derived vs carried agree);
multi-runtime harness (PR #3958) for a cross-user flow where user B fetches user
A's laundered derivative and the label survives; perf benches per §8.
Pattern-test default mode stays `observe` until audit Wave 2 lands (per audit
fix-order note).

## 13. Decisions (resolved 2026-06-10) and remaining recommendations

1. **Blast-radius acceptance** — _decided_: build it and fix after; tests green
   is the bar. No metrics-gated persist flip; instrumentation stays as a
   debugging tool (§8), §12 updated accordingly.
2. **Render declassify prop (S15)** — _decided_: PR #3994 lands the
   `renderDeclassificationPolicy` knob (`allow` default, `deny` available;
   verified-authority gating deferred).
3. **flowPrecisionClaim** — _decided and done (this branch)_: minting removed
   from `map`/`filter`/`flatMap` (builtin and authoring layers),
   `cfc/flow-precision.ts` deleted; result containers get plain array schemas
   via `builtins/list-result-schema.ts`. Tx decomposition already yields the
   precision the claims were staged for (D4). `flowPrecisionClaim` is
   reserved-and-ignored on read — NOT fail-closed rejected, because existing
   persisted link schemas embed it (tolerance pinned in `schema-merge.ts` and
   `cfc-boundary.test.ts`). If dependency-structure assertions return, the
   expected carrier is static analysis earlier in the pipeline
   (transformer/compiler — §14.4.4 territory), not runtime schema metadata;
   realistic runtime consumers would be non-decomposable ops (sqlite row
   transforms under per-row labels, batched LLM calls).
4. **First egress channel** — _decided_: rendering. Default ceiling ≈
   acting-user identity atoms + allow-listed caveat-kind classes, admitted by
   default and tightened later (§10, SC-16).
5. **Naming** — _decided_: implementation keeps
   `origin: "declared" | "link" | "derived"` (provenance axis, drives the update
   rules); the spec edit (SC-1) uses §8.12.4's existing store-label/data-label
   vocabulary for the update-discipline axis, with data labels subdivided into
   link-carried and transition-derived. Avoid naming the component "flow": J
   mixes content and flow contributions by design (§8.11.4), and most of J is
   ordinary content propagation.
