# Prompt influence caveat, registry alignment, and the FUSE label type

Status: decision-gated only on the caveat source and FUSE `observes` scope.
The lattice and type-retirement outcomes are settled by the CFC specification.

Issue: [CT-2315](https://linear.app/common-tools/issue/CT-2315)

## Verdict

`PromptSlotInfluence` is not an integrity atom on the wrong lattice; it is a
labs-specific atom type that the CFC specification does not define. The
specification represents prompt influence as
`Caveat(kind: CFC_CONCEPT_KIND.PromptInfluence, source: Reference)` in
confidentiality and keeps the prompt slot that authorizes a command as separate
`PromptSlotBound` integrity evidence
(`cfc-specs@8b8613ea:cfc/14-open-problems-and-proposals.md:80-121,313-341`;
`cfc-specs@8b8613ea:cfc/15-atom-registry.md:24-38,51-78`). Section 3.4 also
forbids automatically copying control integrity into value integrity
(`cfc-specs@8b8613ea:cfc/03-core-concepts.md:243-264`), and AH-CFC-8 already
states that influence is not integrity and cannot authorize a side effect
(`docs/specs/agent-harness/02-cfc-integration.md:55-61`). The implementation
therefore emits the standard caveat on the confidentiality-only invocation,
retains the full slot binding in the invocation record, and deletes the
`PromptSlotInfluence` constant, types, propagation entry, and runtime-mint
entry. It adds no integrity twin and no output-side mint.

The runner propagation registry has a second, independent contradiction. Its
header says confidentiality atoms have no propagation class, but the table
lists `Caveat` and `Resource`
(`packages/runner/src/cfc/atom-classes.ts:4-39`). Both registry consumers
inspect integrity arrays only: the hereditary meet filters
`label.integrity`, and projection carry iterates `label.integrity`
(`packages/runner/src/cfc/prepare.ts:2472-2493,2890-2924`). Remove both
confidentiality families from the registry. An incorrectly placed copy in
integrity still gets the fail-safe `value-bound` default, so the removal does
not make an unrecognized integrity atom propagate
(`packages/runner/src/cfc/atom-classes.ts:60-66`).

The FUSE half remains a separate type-ownership correction. FUSE's local
`CfcLabel` uses `unknown[]` and its local `CfcLabelView` omits `observes`
(`packages/fuse/annotations.ts:26-37`), even though cell projection returns the
runner view and FUSE casts it down
(`packages/fuse/cell-bridge.ts:2221-2231`). Replace the duplicates with
`IFCLabel` and `CfcLabelView` from `@commonfabric/runner/cfc`. This dependency
runs from Operation to Foundation and is allowed
(`AGENTS.md:16-20,28-34`); FUSE already imports the same runner entry point
(`packages/fuse/cfc-writeback.ts:3-10`). CT-2314's validator is consumed at
`parsePreparedWriteback`, the untrusted JSON-to-typed-writeback seam
(`packages/fuse/cfc-writeback.ts:1266-1279`), and is not designed here.

## Scope and non-goals

This plan covers:

- replacing the raw prompt-slot influence atom with the standard
  prompt-influence confidentiality caveat;
- tracing and retiring every live definition, producer, consumer, fixture, and
  public export of `PromptSlotInfluence` and its now-unused run-manifest helper
  type;
- removing confidentiality-only `Caveat` and `Resource` from the runner's
  integrity propagation registry;
- preserving `PromptSlotBound` as trusted prompt authority and the full prompt
  binding as retained invocation metadata;
- replacing FUSE's third label/type pair with runner-owned types; and
- consuming CT-2314's runner-owned label validator at FUSE prepare parsing.

This plan does not add host-minted prompt integrity, copy invocation or control
integrity onto values, change the normal `TransformedBy`/hereditary derivation
rules, change gVisor's confidentiality-only invocation contract, design a
validator, enable writable `/fabric` (CT-2313), change the regular-file label
ratchet, or design FUSE observation-class projection.

## Defect as verified

### Labs has a second prompt-influence vocabulary

The shared CFC API already defines the standard prompt-influence concept and a
caveat constructor (`packages/api/cfc.ts:142-154,574-580`). The standard
profile consumes exactly a `Caveat` with that kind and correlates its `source`
with disclosure, acknowledgment, or disclaimer evidence
(`packages/runner/src/cfc/standard-profile.ts:164-261`). The prompt-injection
helper and demo use the same split: prompt influence is a confidentiality
caveat, while direct-command authority is `PromptSlotBound` integrity
(`packages/patterns/cfc/prompt-injection/atoms.ts:3-17,27-42`;
`packages/patterns/cfc-agent-prompt-injection-demo/main.tsx:293-328`).

The harness instead defines a second atom family. `PromptSlotBinding` is a
`PromptSlotBound`-shaped trusted record containing a source, role, kernel,
surface, and optional capture evidence
(`packages/cf-harness/src/contracts/prompt-slot.ts:7-31`).
`createPromptSlotInfluenceAtom` copies most of that record plus selected run
manifest fields into the labs-only `PromptSlotInfluence` shape
(`packages/cf-harness/src/contracts/cfc-invocation-context.ts:209-249`), and
`createHarnessPromptSlotInfluenceLabels` places the result directly in each
selected input path's confidentiality array
(`packages/cf-harness/src/contracts/cfc-invocation-context.ts:251-273`). The
placement is taint-like, but the atom vocabulary is not the CFC caveat
vocabulary.

The prior changes that establish the present code are recorded in
[#3589](https://github.com/commontoolsinc/labs/pull/3589),
[#3972](https://github.com/commontoolsinc/labs/pull/3972), and
[#4024](https://github.com/commontoolsinc/labs/pull/4024). Those links are
change provenance only; the current specification and HEAD code decide this
plan.

### Confidentiality propagation is the required behavior

`runsc-cfc` accepts invocation input confidentiality and deliberately rejects
any invocation entry with integrity before joining accepted labels into initial
or stdin-source taint (`pkg/cfc/invocation_context.go:41-55,58-93` on
`origin/wkelly/cfc-fuse-label-flow` in the gVisor checkout). The harness
likewise retains only confidentiality from a released sandbox result, joins it
across model observations, and copies it into later model-authored invocation
inputs (`packages/cf-harness/src/contracts/cfc-model-context.ts:66-76,107-191`).
Replacing the raw atom with a caveat preserves that real taint channel.

The runner's protected-write screen does not match either the old
`PromptSlotInfluence` type or the prompt-influence caveat kind. It keeps every
consumed read carrying any confidentiality in the gating set
(`packages/runner/src/cfc/prepare.ts:3915-3939,4188-4199`). The standard profile
is the component that interprets `Caveat.kind` at release
(`packages/runner/src/cfc/standard-profile.ts:164-261`). Therefore the
replacement strengthens vocabulary alignment without weakening the generic
write screen.

There is no output-side prompt integrity to reconstruct. The explicit
invocation record already retains the prompt binding and run metadata
(`packages/cf-harness/src/contracts/cfc-invocation-context.ts:85-100`), the
engine appends that context before sandbox execution
(`packages/cf-harness/src/engine.ts:2181-2250`), and run state keeps the list
(`packages/cf-harness/src/run-state.ts:182-195`). The policy trace and run
report copy the retained context without assigning it value integrity
(`packages/cf-harness/src/prompt-loop.ts:2989-3009`;
`packages/cf-harness/src/contracts/policy-trace.ts:93-104,175-193`;
`packages/cf-harness/src/contracts/run-report.ts:381-395`).

### The caveat source is narrower than the current binder type

The specification's caveat has `source: Reference`
(`cfc-specs@8b8613ea:cfc/04-label-representation.md:94-95`), while
`PromptSlotReference` currently accepts any nonempty string or object and its
normalizer checks only those two conditions
(`packages/cf-harness/src/contracts/prompt-slot.ts:11-16,60-64,101-114`). The
default CLI source is an extension-shaped record, and a run manifest may
supply a similar object (`packages/cf-harness/src/contracts/prompt-slot.ts:150-181`;
`packages/cf-harness/src/cli.ts:3119-3132`). The old influence builder did not
embed `PromptSlotBinding.source`, so moving that source onto the wire exposes a
previously irrelevant validation boundary. Stage 0 resolves its exact portable
shape before implementation.

### The integrity registry contains confidentiality families

`atomPropagationClass` exists for integrity derivation: hereditary atoms can
survive a meet, while value-bound and provenance atoms do not propagate
(`packages/runner/src/cfc/atom-classes.ts:4-20`). Nevertheless its map includes
`Caveat` and `Resource`, which the spec and API classify as confidentiality
atoms (`packages/runner/src/cfc/atom-classes.ts:22-39`;
`packages/api/cfc.ts:35,74-87,142-154`).

The two production call sites settle the correction:

- flow derivation separately unions `label.confidentiality`, then calls the
  registry only for members of `label.integrity`
  (`packages/runner/src/cfc/prepare.ts:2465-2493`); and
- projection separately copies confidentiality, then calls the registry only
  for source integrity atoms (`packages/runner/src/cfc/prepare.ts:2890-2924`).

Consequently `Caveat` and `Resource` should leave the map rather than changing
the header to bless confidentiality atoms in an integrity-only mechanism. The
unknown-type default remains `value-bound`, so malformed integrity placement
continues to fail safe (`packages/runner/src/cfc/atom-classes.ts:60-66`).

### FUSE owns weaker duplicates

Runner `IFCLabel` types confidentiality clauses and integrity atoms, and runner
`CfcLabelView` entries may carry an effective `observes` class
(`packages/runner/src/cfc/label-view-core.ts:10-13,43-60`). FUSE redeclares the
label arrays as `unknown[]` and a view without `observes`, then uses those types
for every annotation field (`packages/fuse/annotations.ts:26-37,50-70,84-132`).

The local types are consumed directly in three production files:

1. `annotations.ts` types public, fail-closed, topology, content, namespace,
   metadata, directory-entry, callable, and symlink labels, then clones,
   canonicalizes, joins, and projects them
   (`packages/fuse/annotations.ts:174-200,305-435,543-570,801-815`).
2. `cell-bridge.ts` imports the local pair, casts the runner's actual view, and
   threads it through projection and annotation construction
   (`packages/fuse/cell-bridge.ts:19-37,2221-2287,3061-3079`).
3. `cfc-writeback.ts` uses the local label for every direct and metadata label
   in a prepare record and for reconstructed annotations
   (`packages/fuse/cfc-writeback.ts:13-24,97-125,1455-1520`).

The annotation types flow indirectly through `tree.ts`, the entity-projection
benchmark, and FUSE tests (`packages/fuse/tree.ts:14-20,387-418,543-568`;
`packages/fuse/entity-projection.bench.ts:454-468`;
`packages/fuse/annotations.test.ts:36-51`;
`packages/fuse/tree.test.ts:120-128`;
`packages/fuse/cfc-writeback.test.ts:46-69`;
`packages/fuse/cell-bridge.test.ts:3192-3213`). These callers are in the
type-check and regression radius even when their logic does not change.

The cast also hides an observation-class mismatch. FUSE generation omits
`observes`, and exact-path lookup combines entries without consulting it
(`packages/fuse/annotations.ts:305-317,423-435`). Runner merging keeps
observation classes separate so shape observations do not smear onto value
reads (`packages/runner/src/cfc/label-view-core.ts:235-261`). Type collapse
makes that disagreement visible but does not decide a new projection policy.

## Producer and consumer inventory

| Site | Role and current assumption | Planned disposition |
| --- | --- | --- |
| `CFC_ATOM_TYPE.PromptSlotBound`, `CfcPromptSlotBoundAtom`, and `cfcAtom.promptSlotBound` (`packages/api/cfc.ts:104,506-522,644-660`) | Public integrity authority vocabulary | Retain unchanged. |
| `PromptSlotBinding`, `normalizePromptSlotBinding`, and `createCliPromptSlotBinding` (`packages/cf-harness/src/contracts/prompt-slot.ts:18-31,101-181`) | Trusted harness binding record, separate from sandbox taint | Retain the binding; tighten only its `source` contract selected in Stage 0. |
| CLI and interactive service (`packages/cf-harness/src/cli.ts:3119-3132`; `packages/cf-harness/src/interactive-chat-service.ts:1529-1538`) | Trusted binding producers | Preserve authority behavior; supply a portable source reference. |
| `evaluateToolPolicy` (`packages/cf-harness/src/prompt-loop.ts:2597-2703`) | Requires `direct-command` binding for effectful tools | No change. Influence never satisfies this authority check. |
| `CFC_ATOM_TYPE.PromptSlotInfluence`, `CfcPromptSlotInfluenceAtom`, and `CfcPromptSlotRunManifest` (`packages/api/cfc.ts:105,524-545`) | Public labs-only vocabulary | Delete after all consumers migrate. |
| `createPromptSlotInfluenceAtom` (`packages/cf-harness/src/contracts/cfc-invocation-context.ts:209-249`) | Builds the labs-only raw atom | Delete; do not translate its role/kernel/run-manifest payload into integrity. |
| `createHarnessPromptSlotInfluenceLabels` (`packages/cf-harness/src/contracts/cfc-invocation-context.ts:251-273`) | Puts the raw atom in confidentiality | Rename to `createHarnessPromptInfluenceLabels` and emit `cfcAtom.caveat(PromptInfluence, source)` under confidentiality, with no integrity. |
| `confidentialityOnlyIfcLabel` and model-context accumulation (`packages/cf-harness/src/contracts/cfc-model-context.ts:66-76,107-191`) | Confidentiality is the model-influence channel; integrity is discarded | No source change; tests pin caveat propagation through this consumer. |
| Run state, policy trace, and run report (`packages/cf-harness/src/run-state.ts:182-195`; `packages/cf-harness/src/contracts/policy-trace.ts:93-104,175-193`; `packages/cf-harness/src/contracts/run-report.ts:381-395`) | Retain generic label views and the full slot binding | Envelope types remain unchanged; regenerated artifacts contain caveats. |
| Console artifact readers (`packages/cf-harness/console/run-store.ts:275-290`; `packages/cf-harness/console/steps.ts:656-697,1096-1146`; `packages/cf-harness/console/graph.ts:133-171`; `packages/cf-harness/console/src/steps-view.ts:36-52,155-162`) | Associate contexts with outputs, then display the top-level atom type | Display the caveat kind while preserving generic fallback for old/unknown clauses. |
| Harness audit (`packages/cf-harness/audit/conformance-manifest.ts:136-149`) | Names the raw atom as the mechanism separating influence from authority | Name the standard caveat and its lack of authority. |
| `atomPropagationClass` (`packages/runner/src/cfc/atom-classes.ts:4-66`) | Misclassifies the retired type as provenance and lists two confidentiality families | Remove `PromptSlotInfluence`, `Caveat`, and `Resource`; keep the unknown fail-safe default. |
| `RUNTIME_MINTED_INTEGRITY_ATOM_TYPES` (`packages/runner/src/cfc/prepare.ts:4748-4799`) | Treats `PromptSlotInfluence` as trusted runtime integrity evidence | Remove only that member; retain `PromptSlotBound` and the other evidence families. |
| Standard profile and protected-write screen (`packages/runner/src/cfc/standard-profile.ts:164-261`; `packages/runner/src/cfc/prepare.ts:3915-3939,4188-4199`) | Profile matches prompt caveat kind; write screen treats any confidentiality as gating input | No semantic change; characterization tests show the corrected caveat reaches both paths. |
| Authoring re-export (`packages/api/cfc-authoring.ts:25-45`) | Publishes both retired helper types | Remove `CfcPromptSlotInfluenceAtom` and the now-unused `CfcPromptSlotRunManifest`. |
| Generated compiler ambient (`packages/static/assets/types/cfc.ts:45-63,308-344`) | Mirrors the authoring export and retired constant/type | Regenerate from `cfc-authoring.ts`; do not hand-edit. |
| Pattern author index (`packages/patterns/cfc/INDEX.md:35-50`) | Recommends the retired type as shared vocabulary | Remove it and describe `Caveat(PromptInfluence)` as the influence vocabulary. |
| API surface test (`packages/api/test/cfc-surface.test.ts:9-35,171-195`) | Instantiates the retired type | Remove the positive fixture and add a negative surface guard. |
| Harness unit tests and audit fixtures (`packages/cf-harness/test/cfc-invocation-context.test.ts:124-310`; `packages/cf-harness/test/engine.test.ts:1279-1369`; `packages/cf-harness/test/console/steps.test.ts:1225-1344`) | Pin the raw type in confidentiality | Replace expectations and generated fixture payloads with caveats. |
| Live spec-delta note (`docs/specs/cfc-spec-changes.md:178-184`) | Calls the retired implementation type a missing spec-registry atom | Remove that request and state the registry-side separation. |

## Implementation plan

### Stage 0 — settle the caveat source boundary

Wilk selects the portable `Reference` carried by the caveat. The recommended
route is the trusted binding's `promptSlot.source`, narrowed from arbitrary
`Record<string, unknown>` to the repository's chosen serializable reference
shape. It keeps influence tied to the originating input without copying
authority fields into confidentiality. The alternative is a stable reference
to the retained invocation record; it offers a uniform host-owned identity but
requires a reference-mint and resolution contract that HEAD does not have.

Checkpoint: construct the exact CLI, run-manifest, and interactive-chat source
variants and pass the resulting caveat through CT-2314's label validator and
the standard-profile source-equality matcher. If any source cannot be
represented and compared without a cast, stop and revise the source contract
before changing producers. Under the invocation-reference route, use the
current context's `runId` and `sequence` to construct the stable reference in
`cfc-invocation-context.ts`; do not copy the arbitrary binding source onto the
wire.

### Stage 1 — replace the harness atom with the standard caveat

If Stage 0 selects the binding-source route, narrow `PromptSlotReference` and
`isPromptSlotReference` in
`packages/cf-harness/src/contracts/prompt-slot.ts` to the portable shape. If it
selects the invocation-reference route, leave that persisted binding contract
unchanged and construct the reference from trusted context fields in
`cfc-invocation-context.ts`. In both routes, keep `PromptSlotBinding` and every
authority field as retained invocation metadata and tool-policy input.

In `packages/cf-harness/src/contracts/cfc-invocation-context.ts`:

- import `CFC_CONCEPT_KIND` and `cfcAtom` from `@commonfabric/api/cfc`;
- delete `CF_HARNESS_PROMPT_SLOT_INFLUENCE_ATOM_TYPE`,
  `HarnessPromptSlotInfluenceAtom`, and `createPromptSlotInfluenceAtom`;
- rename `createHarnessPromptSlotInfluenceLabels` to
  `createHarnessPromptInfluenceLabels`;
- make that helper accept only an optional selected `source` and path list,
  deriving the route-specific source in `createHarnessCfcInvocationContext`;
- emit `cfcAtom.caveat(CFC_CONCEPT_KIND.PromptInfluence, source)` as the single
  confidentiality clause at every selected path; and
- preserve merge order in `createHarnessCfcInvocationContext` and emit no
  invocation integrity.

Do not change `confidentialityOnlyIfcLabel`; dropping integrity there is the
required model-context boundary
(`packages/cf-harness/src/contracts/cfc-model-context.ts:66-76`). Do not put
`PromptSlotBound` on the invocation wire; gVisor refuses invocation integrity,
and the binding already reaches the harness authority gate separately.

Checkpoint: the invocation-context tests show the exact caveat and source at
each path, no `PromptSlotInfluence` payload fields, and empty/absent integrity.
A two-invocation harness test shows a released prompt caveat joining the next
model-authored input through `cfc-model-context.ts`.

### Stage 2 — align retained artifacts, displays, and harness documentation

Update the three console name extractors in
`packages/cf-harness/console/steps.ts`,
`packages/cf-harness/console/graph.ts`, and
`packages/cf-harness/console/src/steps-view.ts`. When a clause is a `Caveat`
with a string `kind`, display the last segment of `kind`; retain the existing
top-level-type and JSON fallbacks for historical and unknown clauses. Never
treat the nested `source` as authority.

Update H3 in `packages/cf-harness/audit/conformance-manifest.ts` to say that
the sandbox receives a prompt-influence caveat rather than `PromptSlotBound`.
Regenerate the three audit artifacts containing the old type:

- `packages/cf-harness/audit/test/fixtures/runs/cfc-audit-fixture/run-state.json`
- `packages/cf-harness/audit/test/fixtures/runs/cfc-audit-fixture/policy-trace.json`
- `packages/cf-harness/audit/test/fixtures/runs/cfc-audit-fixture/run-report.json`

Update `packages/cf-harness/README.md` and AH-CFC-7/8 in
`docs/specs/agent-harness/02-cfc-integration.md` to name the standard caveat,
its source, and its non-authorizing role. Align the corresponding rows in
`docs/specs/agent-harness/04-cfc-spec-correspondence.md`. The harness system map
contains no prompt-influence or `cfcInputLabels` claim on HEAD, so it needs no
content change; repeat that search during implementation before concluding the
coherence sweep.

Checkpoint: new run artifacts display `prompt-influence`, historical raw-atom
artifacts still display `PromptSlotInfluence` through the generic fallback,
and the audit fixture suites accept regenerated output.

### Stage 3 — repair the propagation registry and retire runner assumptions

In `packages/runner/src/cfc/atom-classes.ts`, remove
`CFC_ATOM_TYPE.PromptSlotInfluence`, `CFC_ATOM_TYPE.Caveat`, and
`CFC_ATOM_TYPE.Resource` from `CLASS_BY_TYPE`. Keep the header's integrity-only
contract and unknown `value-bound` fallback. No production caller changes:
both call sites already pass only integrity members
(`packages/runner/src/cfc/prepare.ts:2486-2493,2904-2924`).

In `packages/runner/src/cfc/prepare.ts`, remove
`CFC_ATOM_TYPE.PromptSlotInfluence` from
`RUNTIME_MINTED_INTEGRITY_ATOM_TYPES` and update the nearby comment so the
trusted prompt binder refers only to `PromptSlotBound`. Do not add another
prompt atom, a provenance mint, or a special required-integrity rule.

Add a runner characterization to `cfc-flow-integrity.test.ts`: a
prompt-influence caveat and a resource atom in confidentiality survive the
ordinary confidentiality join, while copies deliberately placed in integrity
do not survive a derived transformation. This pins the two call sites' lattice
separation even though the private map's absence is also checked by review.

Checkpoint: the characterization fails if either family is reclassified as
hereditary or confidentiality stops joining, and a source search finds no
runner reference to `PromptSlotInfluence`.

### Stage 4 — retire the public and ambient type surface

After Stages 1–3 remove runtime consumers:

1. Replace the positive retired-type fixture in
   `packages/api/test/cfc-surface.test.ts` with a negative surface assertion
   that fails type checking if the constant is reintroduced.
2. Remove both type re-exports from `packages/api/cfc-authoring.ts`.
3. Run `deno task gen-cfc-types` in `packages/static`; this regenerates
   `packages/static/assets/types/cfc.ts` from the authoring surface
   (`packages/static/scripts/generate-cfc-types.ts:8-27,318-335`).
4. Delete `CFC_ATOM_TYPE.PromptSlotInfluence`,
   `CfcPromptSlotInfluenceAtom`, and the now-unreferenced
   `CfcPromptSlotRunManifest` from `packages/api/cfc.ts`, after the runtime,
   authoring, and generated-ambient consumers no longer name them.
5. Remove the retired type from `packages/patterns/cfc/INDEX.md` and identify
   `CfcCaveatAtom` plus `CFC_CONCEPT_KIND.PromptInfluence` as the supported
   authoring vocabulary.
6. Correct SC-10 in `docs/specs/cfc-spec-changes.md` so it no longer requests
   registration of the implementation-only atom and instead states that
   confidentiality families do not receive integrity propagation classes.

Checkpoint: `deno task check-cfc-types` in `packages/static` passes, the API
surface negative guard type-checks, and this search returns no match:

```sh
rg -n "PromptSlotInfluence|CfcPromptSlotRunManifest" packages docs/specs \
  --glob '!docs/history/**' --glob '!docs/plans/**'
```

### Stage 5 — collapse the FUSE types

In `packages/fuse/annotations.ts`:

- delete local `CfcLabel` and `CfcLabelView`;
- import `IFCLabel` and `CfcLabelView` from `@commonfabric/runner/cfc`;
- replace every annotation, constant, helper argument, and helper result typed
  as `CfcLabel` with `IFCLabel`;
- type the two label halves separately in `cloneLabel`,
  `canonicalLabelForGeneration`, and `joinLabelList`, because an indexed write
  through `keyof IFCLabel` widens to incompatible element unions;
- preserve stable-JSON deduplication and ordering rather than substituting
  runner `mergeLabel`, which also normalizes confidentiality clauses
  (`packages/runner/src/cfc/label-view-core.ts:179-217`); and
- preserve `entry.observes` in `canonicalLabelView` so two views that differ in
  effective observation metadata cannot share a projection generation. Do not
  filter entries by `observes` in this cut.

In `packages/fuse/cell-bridge.ts`, import the runner types beside
`cfcLabelViewForCell`, delete their imports from annotations, remove the cast in
`#cfcLabelViewForCell`, and change local label parameters to `IFCLabel`
(`packages/fuse/cell-bridge.ts:19-37,2221-2287`).

In `packages/fuse/cfc-writeback.ts`, import `IFCLabel` beside the existing
runner CFC imports, replace every direct/metadata prepare-label and helper
signature, and remove `CfcLabel` from the annotations import
(`packages/fuse/cfc-writeback.ts:3-24,97-125,1455-1520`). This narrows static
members from arbitrary `unknown` to `CfcConfClause` and `CfcAtom`; it does not
validate parsed JSON.

Checkpoint: `deno task check` passes with no cast in
`#cfcLabelViewForCell`, and exact annotation tests preserve both label halves
and distinguish generations by `observes`.

### Stage 6 — consume CT-2314's validator at the FUSE boundary

After CT-2314 exports the runner-owned sidecar label validator, call it in
`parsePreparedWriteback` after the existing envelope/operation/target checks
and before the `CfcPreparedWriteback` return cast
(`packages/fuse/cfc-writeback.ts:1266-1279`). Validate every present direct
label (`contentLabel`, `nameLabel`, `existenceLabel`, `namespaceLabel`,
`linkTextLabel`, and `targetIdentityLabel`) and every present member of
`metadataLabels` (`packages/fuse/cfc-writeback.ts:97-105`). On failure return
`null`, preserving `setPreparedXattr`'s `malformed-prepare` path
(`packages/fuse/cfc-writeback.ts:905-941`).

The same seam covers recovery. `#load` admits a recovery record only through
`isRecoveryRecord`, and `isRecoveryRecord` reuses `parsePreparedWriteback` for
its embedded prepare (`packages/fuse/cfc-writeback.ts:1211-1247,1418-1436`).
CT-2315 adds no validator implementation, atom registry, recursive walk, or
FUSE-local parser.

Checkpoint: malformed direct and metadata labels fail both live prepare and
recovery tests, while a valid runner label round-trips unchanged.

## Every file touched

| File | Named change |
| --- | --- |
| `packages/cf-harness/src/contracts/prompt-slot.ts` (binding-source route only) | Narrow `PromptSlotReference` and its normalizer to the selected CFC source-reference shape. |
| `packages/cf-harness/src/contracts/cfc-invocation-context.ts` | Delete the labs atom builder/constants/types; emit the standard caveat in `createHarnessPromptInfluenceLabels`. |
| `packages/cf-harness/console/steps.ts` | Render caveat kinds in argument summaries and remove the old-type comment. |
| `packages/cf-harness/console/graph.ts` | Render caveat kinds in graph input and aggregate labels. |
| `packages/cf-harness/console/src/steps-view.ts` | Render caveat kinds in the CFC pane and remove the old-type comment. |
| `packages/cf-harness/audit/conformance-manifest.ts` | Correct H3's mechanized account. |
| `packages/cf-harness/README.md` | Document the standard caveat and retained authority binding. |
| `packages/cf-harness/test/cfc-invocation-context.test.ts` | Replace raw-atom expectations and pin the chosen source. |
| `packages/cf-harness/test/engine.test.ts` | Pin caveats on every model-authored sandbox slot. |
| `packages/cf-harness/test/prompt-loop.test.ts` | Add the two-invocation confidentiality-propagation case. |
| `packages/cf-harness/test/console/steps.test.ts` | Pin artifact readback and historical fallback display. |
| `packages/cf-harness/test/console/graph.test.ts` | Pin caveat-kind graph display. |
| `packages/cf-harness/test/console/src/steps-view.test.ts` | Pin caveat-kind CFC-pane display. |
| `packages/cf-harness/audit/test/fixtures/runs/cfc-audit-fixture/run-state.json` | Regenerate invocation caveats. |
| `packages/cf-harness/audit/test/fixtures/runs/cfc-audit-fixture/policy-trace.json` | Regenerate invocation caveats. |
| `packages/cf-harness/audit/test/fixtures/runs/cfc-audit-fixture/run-report.json` | Regenerate invocation caveats. |
| `packages/runner/src/cfc/atom-classes.ts` | Remove the retired type and confidentiality families from the integrity registry. |
| `packages/runner/src/cfc/prepare.ts` | Remove the retired type from the trusted integrity-mint gate and update its comment. |
| `packages/runner/test/cfc-flow-integrity.test.ts` | Pin confidentiality-family join and non-propagating integrity behavior. |
| `packages/api/cfc.ts` | Remove the retired constant, atom type, and dead run-manifest helper type. |
| `packages/api/cfc-authoring.ts` | Remove the two dead type re-exports. |
| `packages/api/test/cfc-surface.test.ts` | Remove the positive fixture and add a negative surface guard. |
| `packages/static/assets/types/cfc.ts` | Regenerate the compiler ambient after the authoring export removal. |
| `packages/patterns/cfc/INDEX.md` | Replace the retired type recommendation with the standard caveat vocabulary. |
| `docs/specs/cfc-spec-changes.md` | Correct SC-10's propagation-registry requirement. |
| `docs/specs/agent-harness/02-cfc-integration.md` | Name the caveat representation and its non-authorizing role. |
| `docs/specs/agent-harness/04-cfc-spec-correspondence.md` | Align AH-CFC-7/8 correspondence with the standard caveat. |
| `packages/fuse/annotations.ts` | Delete duplicate types; use runner types and retain `observes` in generation. |
| `packages/fuse/cell-bridge.ts` | Import runner types and remove the runner-view cast. |
| `packages/fuse/cfc-writeback.ts` | Use `IFCLabel` and call CT-2314's validator in `parsePreparedWriteback`. |
| `packages/fuse/annotations.test.ts` | Pin typed label halves and `observes` generation identity. |
| `packages/fuse/cfc-writeback.test.ts` | Add live and recovery malformed-label coverage. |

No change is expected in `cfc-model-context.ts`, the standard profile, the
prompt-injection demo, run-state/policy-trace/report contracts, the harness
system map, `docs/specs/cfc-enforcement-matrix.md`, or
`docs/development/EXPERIMENTAL_OPTIONS.md`; each already expresses or
generically carries the intended behavior.

## Tests

### Existing tests to change

- `cfc-invocation-context.test.ts` and `engine.test.ts` currently pin the raw
  atom under confidentiality and no integrity
  (`packages/cf-harness/test/cfc-invocation-context.test.ts:124-310`;
  `packages/cf-harness/test/engine.test.ts:1279-1369`). Replace the clause with
  `Caveat(PromptInfluence, source)` and keep the no-integrity assertion.
- `console/steps.test.ts` expects the old top-level type name from retained
  contexts (`packages/cf-harness/test/console/steps.test.ts:1225-1344`). Update
  new-run fixtures to expect `prompt-influence` and add one old-run fallback
  assertion.
- `cfc-surface.test.ts` imports and instantiates the retired public type
  (`packages/api/test/cfc-surface.test.ts:9-35,171-195`). Remove it and pin the
  absence of the constant with a type-error assertion.
- Regenerate the three audit JSON fixtures; do not hand-edit generated output.
- Keep the prompt-loop test that rejects model-supplied `cfcInputLabels`,
  because a model-authored caveat remains a label-forgery input
  (`packages/cf-harness/test/prompt-loop.test.ts:1597-1677`).

### New tests and their falsifying mutations

1. **Exact caveat representation** — create a bound prompt and assert every
   selected invocation path contains
   `Caveat(kind: PromptInfluence, source: selectedReference)`, with no
   `PromptSlotInfluence` role/kernel/run-manifest payload and no integrity.
   Mutation: restore the raw atom, copy `PromptSlotBound`, omit the source, or
   place anything in integrity; the exact assertion fails.
2. **Source validation** — on the binding-source route, exercise valid CLI,
   run-manifest, and interactive source shapes plus a non-serializable/invalid
   object. Mutation: restore the current nonempty-object-only predicate; the
   invalid source is accepted and the test fails. On the invocation-reference
   route, assert the caveat source is derived from `runId`/`sequence` and does
   not contain the arbitrary binding source. Mutation: copy
   `PromptSlotBinding.source`; the exact assertion fails.
3. **Model-context propagation** — release a prompt caveat from invocation 1
   and assert invocation 2 carries it in confidentiality. Mutation: remove
   `confidentialityOnlyIfcLabel`, skip model-context accumulation, or convert
   influence to integrity; the second invocation loses the clause.
4. **Display semantics** — feed the steps, graph, and view helpers a prompt
   caveat and assert `prompt-influence`; feed the historical raw atom and assert
   `PromptSlotInfluence`. Mutation: name only `clause.type` or remove the
   fallback; one arm fails.
5. **Retired API surface** — add a `@ts-expect-error` assertion that
   `CFC_ATOM_TYPE.PromptSlotInfluence` is absent. Mutation: reintroduce the
   member; the now-unused directive fails type checking.
6. **Registry lattice separation** — derive from labels carrying `Caveat` and
   `Resource` in confidentiality and deliberately mirrored in integrity.
   Assert confidentiality joins and the integrity copies do not propagate.
   Mutation: classify either family as hereditary or consult the registry over
   confidentiality; the result changes and the test fails.
7. **FUSE preserves both runner-label halves** — pass a runner
   `CfcLabelView` containing an `anyOf` confidentiality clause, an object
   integrity atom, and `observes: "value"`; assert the projected xattr
   preserves both halves. Mutation: alter `cloneLabel`,
   `canonicalLabelForGeneration`, or `joinLabelList` to omit or coerce a half;
   the exact assertion fails. Alias/cast absence remains a type-check/review
   invariant.
8. **Projection generation includes observation class** — derive generations
   from otherwise identical `value` and `shape` views and assert they differ.
   Mutation: keep `canonicalLabelView` dropping `observes`; they compare equal.
9. **Malformed live prepare labels fail** — provide one invalid direct label
   and one invalid metadata label. Assert `setPreparedXattr(...).ok === false`
   and `malformed-prepare`. Mutation: remove the CT-2314 validator call or
   validate only direct labels; an input is accepted.
10. **Malformed recovery labels fail** — load a recovery record with one
    invalid embedded label and assert no prepared record is restored. Mutation:
    bypass `parsePreparedWriteback` from `isRecoveryRecord` or validate only the
    live xattr path; the record re-enters the store.

Run focused files while iterating, then `deno task test` from
`packages/cf-harness`, `packages/runner`, `packages/api`, `packages/static`, and
`packages/fuse`. The package suites, API negative guard, generated-asset check,
and source search together cover behavior and surface retirement.

## Blast radius

### Harness sessions and artifacts

Every trusted-prompt-bound model-authored sandbox invocation changes its
`cfcInputLabels` clause from the labs raw atom to a standard caveat. The
affected paths remain those named by `cfcPromptSlotInputLabelPaths` or its
fallback (`packages/cf-harness/src/contracts/cfc-invocation-context.ts:291-305`).
The sidecar remains confidentiality-only, so `runsc-cfc` continues accepting
it. Model-context accumulation remains confidentiality-only and preserves the
caveat into later calls.

The version-1 invocation, run-state, policy-trace, and run-report envelopes do
not change. New artifacts contain the caveat; historical artifacts containing
the raw atom remain parseable because those contracts carry generic
`CfcLabelView` entries (`packages/cf-harness/src/contracts/cfc-invocation-context.ts:85-100`;
`packages/cf-harness/src/contracts/policy-trace.ts:93-104`). Console fallback
rendering keeps the historical type legible. Code importing the labs-only
public atom/type stops compiling, intentionally; the live-tree source search
identifies every in-repository caller before deletion.

### Demos

- **CT-2091 (hostile fetched skill): affected.** Skill/prompt influence enters
  and leaves the sandbox as the standard confidentiality caveat. The demo must
  not expect a `PromptSlotInfluence` integrity atom on output; ordinary sandbox
  output integrity follows `TransformedBy` and hereditary-input rules, outside
  this issue. Durable FUSE label writeback still depends on CT-2313/CT-2314.
- **CT-2189 (Gmail + Plaid bills): no direct execution-path change.** Its data
  does not pass through the sandbox. It remains a regression smoke for shared
  CFC types and documentation.
- **Runner prompt-injection demo: no migration.** It already uses
  prompt-influence confidentiality and `PromptSlotBound` direct-command
  integrity (`packages/patterns/cfc-agent-prompt-injection-demo/main.tsx:293-328`).

### FUSE, documentation, and flags

All CFC-enabled FUSE projections and prepared writebacks enter the type-check
radius. The type collapse is byte-preserving except that projection generation
accounts for the already-present `observes` member. Once CT-2314 validation is
consumed, malformed label JSON currently admitted by the shallow cast is
rejected; valid runner labels remain unchanged.

The API and generated ambient lose a non-spec public type. Live harness and
pattern-author documentation moves to the existing caveat vocabulary. No
experimental flag, mode, default, or fallback changes; the CFC registry in
`docs/development/EXPERIMENTAL_OPTIONS.md` is reviewed but not edited.

## Ordering with CT-2313 and CT-2314

1. **Prompt caveat and type retirement can land independently.** Stages 0–4 do
   not need the sidecar validator, although Stage 0 should test the chosen
   source against CT-2314's API if it is available.
2. **CT-2314 precedes the FUSE validation call.** CT-2315 imports and invokes
   its runner-owned validator in `parsePreparedWriteback`; it does not create a
   temporary local validator.
3. **CT-2315's FUSE collapse precedes writable enablement.** CT-2313's immediate
   read-only refusal may land independently, but any later writable `/fabric`
   enablement should follow the canonical types and validator call.

## Gates before push

Use the repository-pinned Deno 2.9.4 binary at
`/Users/ben/.local/share/mise/installs/deno/2.9.4/bin/deno` for every Deno
command:

1. `deno fmt --check`
2. `deno lint`
3. `deno task check`
4. `deno task test` in every touched package: `cf-harness`, `runner`, `api`,
   `static`, and `fuse`
5. `deno task check-cfc-types` in `packages/static`
6. `deno task check-no-waitfor`
7. `deno task check-docs`
8. `deno task check-conflict-markers`
9. `deno task check-control-characters`
10. `deno task check-skill-facts`
11. `deno task check-package-cycles`
12. `deno task check-single-copy-deps`
13. `deno task check-unused-deps`
14. `deno task check-deno-pins`
15. `deno task check-docs-history-index`
16. `deno task check-verb-session-sync`
17. `deno task check-completion-slots`
18. `deno task check-command-docs`
19. `deno task check-local-program`
20. `deno task check-baselines-append-only`
21. `deno task check-test-aliases`
22. `deno task check-pattern-tiers`

Run `deno task cfcheck` if implementation changes a pattern; this plan changes
only the pattern vocabulary index and uses the prompt-injection demo as a
reference.

## Surprises and open questions

Resolved surprise: the protected-write prompt-injection screen reads neither
the retired type nor the caveat kind; it retains every confidentiality-bearing
read. Only the standard release profile matches `PromptInfluence`
(`packages/runner/src/cfc/prepare.ts:3915-3939,4188-4199`;
`packages/runner/src/cfc/standard-profile.ts:164-261`). No screen migration or
compatibility branch is needed.

- **For Wilk — what exact `Reference` should identify prompt influence from a
  harness slot?** **Position A (recommended):** use `PromptSlotBinding.source`,
  after narrowing it to a validated serializable CFC reference. The caveat then
  names the originating input while the retained invocation record carries
  role, kernel, surface, and run metadata. **Position B:** mint a stable
  reference to the retained invocation record and use that as the caveat
  source. It gives every harness path one host-owned identity, but needs a new
  reference/resolution contract. The current `PromptSlotReference` accepts any
  nonempty object, which is wider than the spec's `Reference`.
- **For Ben — does `observes` semantics belong in CT-2315?** **Position A
  (recommended):** preserve `observes` in the projection-generation digest but
  keep existing conservative projection behavior, then open a focused design
  for mapping FUSE content/name/topology xattrs to runner observation classes.
  **Position B:** make FUSE class-aware in this issue. That is more complete,
  but it is not a type collapse: current lookup ignores `observes`, and changing
  it can remove confidentiality or integrity from emitted file labels.

## Completion criteria

The implementation is complete when:

- every prompt-bound model-authored invocation carries a standard
  prompt-influence confidentiality caveat with the owner-approved source and no
  invocation integrity;
- the retained invocation record, not a value-integrity twin, records which
  prompt slot steered the call;
- no live production, test, ambient, or documentation surface outside this plan
  or frozen history defines or recommends `PromptSlotInfluence` or
  `CfcPromptSlotRunManifest`;
- the propagation registry contains integrity families only, and
  confidentiality caveats/resources continue to join through the
  confidentiality path;
- retained artifact displays remain useful for both new caveats and historical
  raw atoms;
- FUSE has no local `CfcLabel`/`CfcLabelView` definition or runner-view cast;
- every live and recovered prepared-writeback label passes CT-2314's runner
  validator before entering typed FUSE state; and
- every mutation-sensitive test and listed gate passes.
