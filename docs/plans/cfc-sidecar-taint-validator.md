# CFC sidecar taint validation and confidentiality disposition

Issue: CT-2314

Parent: CT-2298

Status: implementation-ready after the rulings in [Surprises and open
questions](#surprises-and-open-questions)

## Verdict

The runsc sidecar path has two independent fail-open ambiguities. First,
`isPublicRunscTaint` treats every non-empty xattr label member as
confidentiality, so an integrity-only result becomes `opaque` even though the
harness's model-context lattice is confidentiality-only. Second,
`runscTaintLabel` copies whatever arrays happen to be named `confidentiality`
and `integrity` into an `IFCLabel` without establishing that the root, clauses,
or atoms are runner-interpretable. The implementation should put one exported
`parseIfcLabel(value: unknown): IFCLabel` boundary in the runner CFC module,
make malformed or absent sidecar labels a synthetic denial rather than an empty
label, make disposition depend only on validated confidentiality, and record
origin plus per-sandbox-invocation evidence before tool adapters can drop or
combine results. That cut makes integrity-only gVisor fallback provenance
observable without weakening confidentiality, and makes “public” mean a
genuine, validated runsc assertion rather than a manufactured `{}`.

## Scope and non-goals

This plan owns:

- one runner-owned parser for untrusted `IFCLabel` JSON;
- runsc sidecar use of that parser and a confidentiality-only output
  disposition;
- an origin discriminator separating runsc evidence from harness-generated
  denials;
- boundary-level, per-invocation evidence and a run aggregate satisfying the
  CT-2298 memo's origin, agreement, boundary, and absence-is-unknown criteria;
- the tests and live documentation needed for those contracts.

It does not change the CFC enforcement-mode dials, invent a second gVisor label
type, translate gVisor principals into runner principals, relax the non-empty
input-label guard, or change FUSE label propagation. CT-2313 owns FUSE mount
write safety; CT-2315 owns `PromptSlotInfluence` and the FUSE label-type
collapse.

## Defect as verified

### Disposition is taken from both lattice dimensions

`isPublicRunscTaint` recursively scans every value under `xattrJSON`, without
distinguishing `confidentiality` from `integrity`; when `xattrJSON` is absent it
falls back to the human-oriented `string` field
(`packages/cf-harness/src/sandbox/docker-runsc.ts:672-700`). The resulting
boolean selects all three channel dispositions together: public gives observed
stdout, stderr, and exit status; anything else gives opaque stdout, stderr, and
exit status (`packages/cf-harness/src/sandbox/docker-runsc.ts:752-788`).

The harness's downstream model-influence aggregate deliberately removes
integrity and joins only confidentiality
(`packages/cf-harness/src/contracts/cfc-model-context.ts:66-105`). It creates
model-context observations only for `observed` channels
(`packages/cf-harness/src/contracts/cfc-model-context.ts:107-129`). Treating
integrity as a reason to hide sandbox bytes is therefore a second, inconsistent
lattice rule at the sidecar boundary.

The replacement rule is:

> After the sidecar label has passed `parseIfcLabel`, stdout, stderr, and exit
> status are `observed` exactly when `label.confidentiality` is absent or empty;
> otherwise all three are `opaque`. Integrity never changes disposition and is
> retained unchanged on all three observations and the diagnostic.

### The sidecar does not parse an `IFCLabel`

`runscTaintLabel` accepts any arrays found at the two expected keys and copies
their members without checking atom, clause, or root shape
(`packages/cf-harness/src/sandbox/docker-runsc.ts:682-690`).
`cfcResultFromRunscSidecar` checks the envelope version, container identity,
and presence of `cfcTaint`, then immediately uses that copied value as the
label (`packages/cf-harness/src/sandbox/docker-runsc.ts:702-750`). A missing
`xattrJSON`, a primitive atom, or an unknown label key can therefore become an
empty or partially discarded label rather than a refusal.

The read boundary distinguishes a missing sidecar file from path, read, and
JSON failures, but all present failures are represented only as denied
`CfcSandboxResult`s whose labels are `{}`
(`packages/cf-harness/src/sandbox/docker-runsc.ts:1134-1184` and
`packages/cf-harness/src/sandbox/docker-runsc.ts:641-670`). There is no adjacent
origin value, so a consumer cannot distinguish a genuine runsc clean label from
a harness-manufactured empty label.

### Integrity-bearing runsc sidecars are reachable

Wilk's fallback-store claim is correct on
`origin/wkelly/cfc-fuse-label-flow` at
`5dcd311ecfe573be3f701f5ac238fd70190189c8`. The fallback store constructs a
`HostFilesystemProvenance` atom and adds it to the integrity dimension before
marshalling the protected content-label xattr
(`/Users/ben/code/gvisor@5dcd311e:pkg/sentry/fsimpl/gofer/gofer.go:1097-1113`);
the fallback write path invokes that addition before saving the value
(`/Users/ben/code/gvisor@5dcd311e:pkg/sentry/fsimpl/gofer/gofer.go:1332-1340`).
The atom constructor sets the dedicated host-filesystem-provenance enum and a
filesystem subject
(`/Users/ben/code/gvisor@5dcd311e:pkg/cfc/atom.go:204-209`), and the xattr
marshaller emits non-empty integrity arrays
(`/Users/ben/code/gvisor@5dcd311e:pkg/cfc/xattr.go:24-61`). An integrity-only
sidecar is therefore reachable today and the present `opaque` classification is
not hypothetical.

## Existing runner CFC vocabulary

The public TypeScript carrier is intentionally broad: `CfcAtom` aliases every
JSON value, including strings, numbers, arrays, and objects
(`packages/api/cfc.ts:15-27`). That authoring type is not an untrusted-wire
parser.

The runner's label vocabulary is already centralized:

- `IFCLabel` has optional confidentiality clauses and integrity atoms, and the
  only label keys are `confidentiality` and `integrity`
  (`packages/runner/src/cfc/label-view-core.ts:10-13` and
  `packages/runner/src/cfc/label-view-core.ts:62-65`).
- A confidentiality clause is an object atom or the canonical sole-key
  `{ anyOf: [...] }` form; `isOrClause` already recognizes that discriminator
  (`packages/runner/src/cfc/clause.ts:10-35`). Empty `anyOf` is deliberately
  retained as an unsatisfiable, fail-closed clause
  (`packages/runner/src/cfc/clause.ts:48-75` and
  `packages/runner/src/cfc/clause.ts:160-167`).
- Runner atom classification gives a known `type` URI its registered class and
  gives unknown types, primitive atoms, and kind-shaped records the conservative
  `value-bound` default (`packages/runner/src/cfc/atom-classes.ts:4-20` and
  `packages/runner/src/cfc/atom-classes.ts:60-67`).
- The representation table recognizes canonical type-URI families and a finite
  set of legacy `kind` families; `type` wins when both are present
  (`packages/runner/src/cfc/label-field-classification.ts:161-177` and
  `packages/runner/src/cfc/label-field-classification.ts:191-212`).
- `UnknownCfcMetadataVersionError` is the relevant refusal precedent: an
  uninterpretable stored format throws so consumers cannot reinterpret it as
  unlabeled (`packages/runner/src/cfc/metadata.ts:24-40`). The metadata shape
  predicate itself is shallow and does not validate label entries
  (`packages/runner/src/cfc/metadata.ts:42-54`).

There is no runner API that deeply parses an untrusted `IFCLabel` or
`CfcLabelView`. The new API therefore belongs in a focused parser module rather
than in metadata or a harness-local shape helper.

## Validator design

### Location and public contract

Add `packages/runner/src/cfc/label-parser.ts` and export its value, error, and
path type from `packages/runner/src/cfc/mod.ts`, the existing runner CFC public
entry point (`packages/runner/src/cfc/mod.ts:1-82`). Its exact API is:

```text
export type InvalidIfcLabelPath = readonly (string | number)[];

export class InvalidIfcLabelError extends TypeError {
  readonly path: InvalidIfcLabelPath;
  readonly reason: string;
}

export function parseIfcLabel(value: unknown): IFCLabel;
```

`parseIfcLabel` accepts a decoded value, not JSON text. It either returns a
detached plain-data `IFCLabel` whose complete tree has been checked or throws
`InvalidIfcLabelError`. The error carries a structural path and a stable reason
so the harness can make a useful diagnostic without matching prose. This is the
one parser used both by the sidecar reader and by any future sandbox-ingest mint;
neither caller grows a parallel shape test.

The parser reuses `IFCLabel`, `isOrClause`, `CLASSIFIED_KIND_FAMILIES`, and
`isObjectNotArray`. It does not call `atomPropagationClass` to decide validity:
that function intentionally assigns primitive values a conservative class, not
wire-format legitimacy (`packages/runner/src/cfc/atom-classes.ts:60-67`). It
does not call `isCfcMetadata`, because that predicate validates a versioned
metadata envelope rather than its label entries
(`packages/runner/src/cfc/metadata.ts:51-54`).

### Accepted grammar and refusals

The parser applies these rules recursively:

| Input | Result |
| --- | --- |
| Root | A plain record with only `confidentiality` and/or `integrity`; `{}` is a valid explicit public label. Unknown root keys refuse. Present dimensions must be arrays. Empty dimensions normalize away. |
| Runner object atom | Accept a plain JSON record with either an own, non-empty string `type`, or—only when `type` is absent—an own string `kind` in `CLASSIFIED_KIND_FAMILIES`. Check every nested value is JSON data and return a detached copy. Unknown `type` URIs remain valid and later receive the runner's fail-safe `value-bound` propagation class. |
| gVisor principal string, for example `"finance"` | Refuse at its array index. gVisor's policy engine may use it, but it is not a runner object atom, has no runner field representation, and has no registered propagation class. The validator does not invent a mapping or silently turn it into an opaque runner principal. |
| `{ anyOf: [...] }` in confidentiality | Accept when `isOrClause` recognizes the canonical sole-key form and every alternative is a valid object atom. Preserve an empty `anyOf` as the runner's deliberate unsatisfiable clause. Refuse nested clauses and primitive alternatives. |
| `{ anyOf: [...] }` in integrity | Refuse: integrity contains atoms, not confidentiality clauses. |
| Unknown key inside an atom | Accept after recursively checking its value as JSON; atom families are open for extension. |
| Unknown key at the label root | Refuse. Discarding it could erase a future confidentiality dimension. |
| Non-JSON value, array atom, object with neither accepted `type` nor accepted `kind`, malformed dimension, or malformed clause | Refuse with `InvalidIfcLabelError`; never return `{}` as recovery. |

This deliberately makes the runtime carrier narrower at an untrusted boundary
than the compile-time `CfcAtom` alias. A valid unknown object atom is safe
because runner propagation drops unknown integrity claims on combination
(`packages/runner/src/cfc/atom-classes.ts:17-18`); a primitive policy string is
not admitted merely because TypeScript can express it.

### Why PR #7143's helper must not return

PR #7143 proposed a 360-line harness-local `ifc-label-shape.ts` that hardened a
generic object walk against proxies, getters, cycles, non-enumerable keys, and
depth abuse. The sidecar is produced by `JSON.parse`
(`packages/cf-harness/src/sandbox/docker-runsc.ts:1171-1173`), so it cannot
contain those JavaScript object capabilities, while a harness-local checker
would duplicate runner clause and atom semantics and could not be the shared
boundary for a future sandbox-ingest mint. The runner-owned parser should
validate the actual JSON grammar, return a detached checked value, and rely on
the existing runner discriminators; reproducing PR #7143 would buy defenses
against values this transport cannot create at the cost of a second label
language and a second place for it to drift.

### gVisor wire compatibility

The gVisor marshaller passes opaque runner JSON atoms through unchanged
(`/Users/ben/code/gvisor@5dcd311e:pkg/cfc/xattr.go:142-145`), so canonical
runner object atoms and sole-key `anyOf` clauses can make the round trip. Its
native atoms instead marshal as objects with an internal type URI, numeric type
code, and optional subject/params
(`/Users/ben/code/gvisor@5dcd311e:pkg/cfc/xattr.go:142-183`). Those are valid
unknown object atoms to the runner and conservatively value-bound. The parser
does not translate their type code.

The gVisor-native multi-alternative clause includes both `anyOf` and `type`
(`/Users/ben/code/gvisor@5dcd311e:pkg/cfc/xattr.go:117-139`). Because the
runner's clause discriminator requires `anyOf` to be the sole key
(`packages/runner/src/cfc/clause.ts:22-35`), that object is accepted as an
unknown typed atom, not reinterpreted as a runner disjunction. The compatibility
question this exposes is listed for Wilk below.

## Disposition, origin, and run evidence

### Sidecar result origin

Extend `SandboxCommandResult`, whose present contract carries only raw process
fields and optional `cfcResult`
(`packages/cf-harness/src/sandbox/types.ts:149-173`), with:

```text
export type CfcSandboxResultOrigin = "runsc-sidecar" | "synthetic";

export interface SandboxCommandResult {
  // existing fields
  cfcResult?: CfcSandboxResult;
  cfcResultOrigin?: CfcSandboxResultOrigin;
}
```

The invariant is bidirectional: origin is present exactly when `cfcResult` is
present. A successfully decoded, envelope-matched, label-validated sidecar gets
`runsc-sidecar`. Harness denials for invalid container identity, unsupported
version, missing taint, missing `xattrJSON`, invalid label, read error, path
error, or JSON syntax get `synthetic`. No configured result directory and
`Deno.errors.NotFound` remain absence—neither field is present—matching the
reader's existing absent branches
(`packages/cf-harness/src/sandbox/docker-runsc.ts:1134-1169`).

`cfcResultFromRunscSidecar` must require `cfcTaint.xattrJSON`, call
`parseIfcLabel` exactly once, and pass the returned label to both the disposition
check and all three channel constructors. `cfcTaint.string` remains diagnostic
text only. `InvalidIfcLabelError` produces a distinct
`runsc_cfc_sidecar_invalid_label` synthetic denial whose details include the
error path and reason; JSON syntax retains `runsc_cfc_sidecar_parse_error`.

### Boundary placement

Collect evidence around `SandboxRuntime.run`/`runShell`, not from builtin tool
outputs. Tool adapters are not a lossless boundary:

- `bash` forwards its sandbox result, while its trusted current-directory
  marker separately depends on observed stdout
  (`packages/cf-harness/src/tools/bash.ts:58-63` and
  `packages/cf-harness/src/tools/bash.ts:188-215`).
- `read_file` drops the sandbox `cfcResult` when the process exits nonzero and
  returns a structured error instead
  (`packages/cf-harness/src/tools/read-file.ts:145-160`).
- `edit_file` performs read, write, and verify invocations, uses the read label
  as write input, then synthesizes one combined tool result from only read and
  verify (`packages/cf-harness/src/tools/edit-file.ts:479-608` and
  `packages/cf-harness/src/tools/edit-file.ts:782-870`).
- `run_skill_script` forwards the final sandbox result into both its tool output
  and execution record (`packages/cf-harness/src/tools/run-skill-script.ts:1181-1209`
  and `packages/cf-harness/src/tools/run-skill-script.ts:1210-1249`).

Add `packages/cf-harness/src/sandbox/observed-sandbox.ts` with a transparent
`observeSandboxRuntime(runtime, observer)` decorator. Its observer runs once
after every actual `run` or `runShell` result and once for a thrown runtime
call; path resolution and any tool refusal before a sandbox call produce no
event. The decorator delegates description, readiness probes, path methods, and
all optional runtime methods without changing their results. `runShell` must
not double-count when the underlying runtime implements it in terms of `run`:
the wrapper invokes one underlying public method and observes only that returned
promise.

The engine keeps both the raw runtime and the run-owned decorated runtime.
Builtin tools and diagnostics receive the decorated runtime. Child engines
receive the raw runtime and create their own decorator; the present child
constructor instead receives `this.engine.sandbox`
(`packages/cf-harness/src/prompt-loop.ts:4540-4555`), so that line must use a
new read-only `sandboxForDelegation` accessor to prevent a child observation
from also poisoning its parent.

### Evidence and aggregate types

Add `packages/cf-harness/src/sandbox-evidence.ts` with these run-state data
contracts and pure derivations:

```text
export type HarnessSandboxEvidenceOrigin =
  | CfcSandboxResultOrigin
  | "absent"
  | "runtime-error";

export interface HarnessSandboxInvocationEvidence {
  type: "cf-harness.sandbox-invocation-evidence";
  version: 1;
  sequence: number;
  at: string;
  origin: HarnessSandboxEvidenceOrigin;
  disposition: "observed" | "opaque" | "denied" | "unknown";
  label?: IFCLabel;
  cfcInvocationContext?: HarnessCfcInvocationContext;
  reason?: string;
}

export type HarnessSandboxTaint =
  | {
    type: "cf-harness.sandbox-taint";
    version: 1;
    status: "known";
    label: IFCLabel;
  }
  | {
    type: "cf-harness.sandbox-taint";
    version: 1;
    status: "unknown";
    reason: string;
  };
```

The evidence extractor validates the `CfcSandboxResult` envelope, reparses each
of its three labels with the same runner parser, and requires stdout, stderr,
and exit status to have identical dispositions and deep-equal parsed labels. A
genuine agreeing result records its full label. A synthetic result, absent
result, invalid result, disagreement, or runtime throw records no trusted label
and yields an `unknown` aggregate. This is deliberately stricter than
`prompt-loop`'s present shallow `version === 1` cast
(`packages/cf-harness/src/prompt-loop.ts:1813-1825`).

The aggregate is confidentiality-only: a known label joins the new evidence's
confidentiality clauses using the existing model-context join semantics, while
the full integrity label remains on the per-invocation evidence. A fresh run
starts explicitly `known` with `{}` and an empty evidence list. Once any
invocation makes the aggregate `unknown`, later clean evidence cannot restore
it. A resumed run-state artifact that lacks these new fields is normalized to
`unknown`, not clean, because absence of an older audit field is not evidence
that its sandbox invocations were public. `HarnessRunState` currently has model
context and invocation contexts but no sandbox-taint/evidence field
(`packages/cf-harness/src/run-state.ts:150-221`).

The engine appends and persists evidence inside the sandbox observer callback,
before control returns to the tool. That covers tool paths that drop results
and runtime calls that throw. Tool output artifacts remain useful detailed
records because the engine writes the complete output before appending its run
reference (`packages/cf-harness/src/engine.ts:1941-1986`), but they are no
longer the source of the run aggregate.

## Consumer trace

Every present consumer of sidecar disposition and label has the following
outcome under this plan:

| Consumer | Verified behavior and planned effect |
| --- | --- |
| `docker-runsc.ts` | It creates identical observed/opaque dispositions and labels for stdout, stderr, and exit status (`packages/cf-harness/src/sandbox/docker-runsc.ts:752-788`). It will use the one parsed label, confidentiality-only disposition, and adjacent origin. |
| Builtin tools | `bash` and `run_skill_script` forward raw results; `read_file` can drop one; `edit_file` merges multiple invocations (`packages/cf-harness/src/tools/bash.ts:206-215`, `packages/cf-harness/src/tools/read-file.ts:145-160`, `packages/cf-harness/src/tools/edit-file.ts:558-608`, `packages/cf-harness/src/tools/run-skill-script.ts:1209-1249`). Their public output contracts remain unchanged; the boundary observer makes their lossiness irrelevant to run evidence. |
| Model-facing prompt loop | `opaque` and `denied` streams become typed non-observations/handles, while `observed` streams return text (`packages/cf-harness/src/prompt-loop.ts:2049-2080`); exit status follows the same split (`packages/cf-harness/src/prompt-loop.ts:2182-2200`). Only observed channels feed model context (`packages/cf-harness/src/prompt-loop.ts:2269-2305`). Integrity-only results therefore become visible but add no confidentiality to model context. Invalid labels become denied and add no model context. |
| Transcript | Raw `cfcResult` is stripped from model-facing output (`packages/cf-harness/src/prompt-loop.ts:1827-1845`), but a compact summary retains each policy, label, reason, and diagnostic (`packages/cf-harness/src/prompt-loop.ts:2203-2267`). The transcript stores the resulting model-facing JSON (`packages/cf-harness/src/prompt-loop.ts:4124-4154`). No transcript schema change is needed. |
| Missing metadata policy | The prompt loop treats no tool-level `cfcResult` according to enforcement mode and fails closed in enforcing modes (`packages/cf-harness/src/prompt-loop.ts:4381-4443`); diagnostics publishes the same absence rule (`packages/cf-harness/src/diagnostics.ts:268-301`). That output-release policy stays separate from run evidence: absence always makes the audit aggregate unknown, even where disabled/observe mode exposes bytes. |
| Run state | It retains model-context confidentiality and invocation input labels but no sandbox-output aggregate (`packages/cf-harness/src/run-state.ts:180-221`). It gains `sandboxTaint` and `sandboxInvocationEvidence`; model-context fields do not change. |
| Artifacts | `run-state.json` is atomically serialized from the full state (`packages/cf-harness/src/artifacts.ts:68-83` and `packages/cf-harness/src/artifacts.ts:159-164`); tool outputs are separately serialized in full (`packages/cf-harness/src/artifacts.ts:287-300`). The additive state fields therefore need normalization/round-trip tests, not a new artifact file. |
| Diagnostics probes | Capability collection performs one sandbox shell call and a second when `/fabric` is configured (`packages/cf-harness/src/diagnostics.ts:505-553`). Because they execute in the sandbox, the decorated runtime records them unless Ben chooses the exclusion described below. |
| Console status | A step's status is derived from release decisions, policy events, and tool output status—not nested `cfcResult` (`packages/cf-harness/console/steps.ts:481-519`). Transcript omissions resolve back to tool artifacts and display CFC-denied positions as `[redacted by CFC]` (`packages/cf-harness/console/steps.ts:564-648`). |
| Console CFC pane | The pane displays release policy, policy events, and invocation input labels (`packages/cf-harness/console/src/steps-view.ts:150-232`). Although the console loads full run state, it passes only decisions, events, invocation contexts, omissions, and tool artifacts into step construction (`packages/cf-harness/console/run-store.ts:263-291`). The implementation leaves output evidence in the audit artifact pending the UI ruling below. |
| Child runs | A child engine currently receives the parent's exposed sandbox runtime (`packages/cf-harness/src/prompt-loop.ts:4549-4555`). Passing the raw runtime instead gives each run its own observer and aggregate. |

## Every file in the implementation cut

### Runner

1. `packages/runner/src/cfc/label-parser.ts` — add
   `InvalidIfcLabelPath`, `InvalidIfcLabelError`, `parseIfcLabel`, and private
   root/dimension/clause/atom/JSON-value checks described above.
2. `packages/runner/src/cfc/mod.ts` — export the parser, refusal type, and path
   type from the public CFC entry point.
3. `packages/runner/test/cfc-label-parser.test.ts` — pin the complete accepted
   grammar, detached return value, error path/reason, and refusal cases.

### Harness runtime and state

4. `packages/cf-harness/src/sandbox/docker-runsc.ts` — delete
   `hasNonEmptyXattrValue` and `runscTaintLabel`; make
   `isPublicRunscTaint(IFCLabel)` confidentiality-only; require and parse
   `xattrJSON`; distinguish invalid-label diagnostics; return origin with the
   result from `#readCfcResultSidecar`.
5. `packages/cf-harness/src/sandbox/types.ts` — add
   `CfcSandboxResultOrigin` and the paired optional `cfcResultOrigin` field.
6. `packages/cf-harness/src/sandbox/observed-sandbox.ts` — add the transparent
   runtime decorator and observer event type at the actual invocation boundary.
7. `packages/cf-harness/src/sandbox-evidence.ts` — add the evidence/aggregate
   types, three-channel parser/agreement check, append derivation, unknown
   dominance, and confidentiality-only join.
8. `packages/cf-harness/src/run-state.ts` — add `sandboxTaint` and
   `sandboxInvocationEvidence`, initialize a new run as explicit known `{}`,
   expose one append helper, and clone the new data on read/patch.
9. `packages/cf-harness/src/artifacts.ts` — normalize resumed artifacts:
   preserved valid evidence stays valid; a missing or malformed new aggregate
   becomes unknown. Generic persistence remains unchanged.
10. `packages/cf-harness/src/engine.ts` — retain raw and decorated runtimes,
    append/persist evidence in the observer, expose the raw delegation accessor,
    and ensure diagnostics and tools use the decorated runtime.
11. `packages/cf-harness/src/prompt-loop.ts` — pass
    `engine.sandboxForDelegation` to child engines. No disposition renderer or
    model-context behavior changes.

### Harness tests and live documentation

12. `packages/cf-harness/test/docker-runsc-sandbox.test.ts` — update the legacy
    string confidentiality fixture to a runner object atom; assert origin and
    all-channel agreement; add integrity-only and invalid-label cases.
13. `packages/cf-harness/test/sandbox-evidence.test.ts` — exercise extraction,
    agreement, confidentiality aggregation, synthetic/absent/error unknown,
    and irreversible unknown.
14. `packages/cf-harness/test/observed-sandbox.test.ts` — exercise exact-once
    observation of `run`/`runShell`, throws, and no observation for non-run
    methods.
15. `packages/cf-harness/test/engine.test.ts` — pin boundary placement across a
    tool-dropped result, explicit clean initialization, diagnostic probes, and
    persistence/resume normalization.
16. `packages/cf-harness/test/subagent-fabric-posture.test.ts` — pin child-only
    evidence by proving the parent decorator is not reused.
17. `packages/cf-harness/test/artifacts.test.ts` — round-trip the additive
    run-state evidence fields and normalize a legacy artifact to unknown.
18. `packages/cf-harness/docs/CURRENT_STATE.md` — document validated sidecar
    labels, confidentiality-only release, origin, the per-invocation audit, the
    aggregate, and absence/unknown semantics.

No console source file, CFC spec, or experimental-options registry entry changes
unless an open question below is ruled differently. The normative harness spec
already requires fail-closed missing mediation and per-invocation input-label
transport; the implementation supplies audit evidence rather than adding a new
mode. The plan itself is the only file changed by CT-2314 stage 1.

## Tests and their killing mutations

### Existing acceptance coverage

The test file named in the issue is actually
`packages/cf-harness/test/docker-runsc-sandbox.test.ts` on this checkout.

- The observed-sidecar test proves a genuine empty xattr label releases both
  streams and exit status, but it does not assert origin
  (`packages/cf-harness/test/docker-runsc-sandbox.test.ts:478-527`). This is a
  foundation for **origin** and **agreement**, not complete coverage of either.
- The missing-sidecar test proves the runtime returns no `cfcResult` when the
  file is absent, but it does not record run-level unknown
  (`packages/cf-harness/test/docker-runsc-sandbox.test.ts:529-553`). This is a
  foundation for **absence-is-unknown**, not its acceptance test.
- The opaque-sidecar test proves confidentiality makes stdout and exit status
  opaque, but uses a now-refused string atom and omits stderr agreement
  (`packages/cf-harness/test/docker-runsc-sandbox.test.ts:555-601`). This is a
  foundation for **agreement**, not complete coverage.
- No existing test observes at `SandboxRuntime` boundary, distinguishes
  synthesized from runsc evidence, proves all three channel labels agree,
  persists unknown, proves unknown is irreversible, or separates parent/child
  evidence. The memo's four criteria are therefore all incomplete today.

### New and changed tests

Each row states the mutation that the test must kill.

| Test | Required assertion | Killing mutation |
| --- | --- | --- |
| Parser: runner atom | A typed runner object atom is returned intact in confidentiality and integrity; the returned tree does not alias the input. | Reject all unknown types, strip atom fields, or return the input arrays directly. |
| Parser: gVisor principal string | `"finance"` throws `InvalidIfcLabelError` at `/confidentiality/0`. | Accept every `CfcJsonValue` because `CfcAtom` permits it. |
| Parser: `anyOf` | A sole-key `anyOf` with valid object alternatives parses; empty `anyOf` remains unsatisfiable; nested clauses and primitive alternatives refuse. | Treat every `anyOf` record as an atom, reject the empty fail-closed form, or skip alternative validation. |
| Parser: unknown root key | `{ confidentiality: [], availability: [] }` refuses. | Pick the two known keys and silently discard the rest. |
| Parser: object extensibility | An unknown non-empty `type` URI and unknown nested atom fields parse; an unclassified `kind`-only object refuses. | Whitelist only today's `CFC_ATOM_TYPE` values or accept every string `kind`. |
| Sidecar: integrity only | A gVisor-shaped host-filesystem-provenance object under integrity yields `observed` stdout, stderr, and exit status, each retaining the full integrity label and `runsc-sidecar` origin. | Restore the old recursive “any label value means opaque” predicate or drop integrity on observed results. |
| Sidecar: confidentiality | A typed confidentiality atom yields `opaque` on all three channels with equal labels and genuine origin. | Check integrity instead, leave stderr observed, or construct channel labels independently. |
| Sidecar: malformed/absent label | String atom, malformed `anyOf`, unknown root key, and missing `xattrJSON` each yield a synthetic denied result and never an observed `{}`. | Restore array copying, recover parser refusal as `{}`, or use `cfcTaint.string` as a label fallback. |
| Sidecar: origin matrix | Valid sidecar is `runsc-sidecar`; envelope, label, path, read, and JSON failures are `synthetic`; missing file/config has neither field. | Omit origin, mark a manufactured denial genuine, or attach origin without a result. |
| Agreement | Evidence accepts only three equal policies and three deep-equal parsed labels. | Trust stdout alone, compare disposition without label, or accept mixed observed/opaque channels. |
| Boundary: dropped result | A nonzero `read_file` sandbox result appears in run evidence even though the structured tool error omits `cfcResult`. | Collect from the final builtin output instead of the runtime decorator. |
| Boundary: pre-sandbox refusal | A path-validation rejection adds no invocation evidence. | Observe attempted tool calls rather than actual runtime calls. |
| Boundary: throw | A runtime throw appends `runtime-error` and makes aggregate unknown before the error propagates. | Notify only after successful results. |
| Known/unknown aggregate | A new run is explicit known `{}`; absent/synthetic/disagreement makes it unknown; a later clean result cannot repair it. | Leave the field absent, treat absent as clean, or overwrite unknown with the newest label. |
| Resume and artifact round trip | New fields survive persistence; an artifact without them resumes unknown. | Default a missing field to known `{}` or omit it from normalized state. |
| Diagnostics boundary | Capability probe invocations are present in evidence under the recommended ruling. | Give diagnostics the raw runtime while tools use the decorator. |
| Child boundary | A child sandbox call appears only in the child's evidence; the parent remains unchanged. | Pass the parent's decorated runtime into the child engine. |

## Blast radius

- **Harness sessions.** Every engine-owned sandbox invocation participates in
  the audit, independent of `disabled`, `observe`, `enforce-explicit`, or
  `enforce-strict`. The enforcement mode still controls model exposure when
  mediation is absent (`packages/cf-harness/src/diagnostics.ts:284-301`); the
  evidence aggregate answers the different question “what did the run prove?”
- **Tool behavior.** Confidential output remains opaque. Integrity-only output
  changes from opaque to observed. Malformed present sidecars change from
  partially trusted/empty labels to denied results. Model-context accumulation
  remains confidentiality-only
  (`packages/cf-harness/src/contracts/cfc-model-context.ts:107-168`).
- **Artifacts and resume.** `run-state.json` gains additive evidence fields;
  tool-output and transcript artifact formats do not change. Older run states
  load conservatively as unknown.
- **CT-2189 demo.** The Gmail/Plaid native CFC flow does not rely on a sandbox
  sidecar, so its value flow and UI are unchanged. It picks up only the exported
  runner parser surface if later ingest code adopts it.
- **CT-2091 demo.** Skill scripts execute through the sandbox and retain their
  `cfcResult` (`packages/cf-harness/src/tools/run-skill-script.ts:1181-1249`).
  Integrity-only host-filesystem provenance becomes observable and auditable;
  confidentiality still withholds bytes. This issue does not relax the
  enforcing invocation guard for non-empty input labels.
- **Live docs.** `packages/cf-harness/docs/CURRENT_STATE.md` changes with the
  implementation. No historical memo is edited.
- **Experimental flags.** No flag is added, removed, renamed, or reinterpreted.
  Existing CFC enforcement and substrate options keep their meaning, so
  `docs/development/EXPERIMENTAL_OPTIONS.md` requires no edit.
- **Console.** Existing redaction and policy-event display remain intact. The
  new run-state evidence is audit-only unless Ben chooses a visible status in
  the question below.

## Gates before push

Run from the worktree, using the pinned Deno binary documented in
`docs/development/DEPENDENCIES.md` if the `mise` shim cannot execute:

1. Repository gates required for every code change:
   - `deno fmt --check`
   - `deno lint`
   - `deno task check`
2. Relevant package suites:
   - `deno task --cwd packages/runner test`
   - `deno task --cwd packages/cf-harness test`
3. Applicable independent gates from `AGENTS.md`:
   - `deno task check-docs`
   - `deno task check-conflict-markers`
   - `deno task check-control-characters`
   - `deno task check-package-cycles` because the harness starts consuming a
     new runner public value
   - `deno task check-unused-deps`
   - `deno task check-single-copy-deps`
   - `deno task check-deno-pins`

`check-no-waitfor`, history-index, verb-session, completion-slot, command-doc,
local-program, append-only baseline, test-alias, and pattern-tier gates do not
cover any file in this cut. Run one if the implementation expands into its
governed surface.

## Surprises and open questions

- **For Wilk — can a gVisor-native multi-principal clause reach the sidecar in
  the target build?** Position A (recommended): gVisor carries runner-authored
  sole-key `anyOf` JSON opaquely, while its native `{type, anyOf}` value remains
  one unknown runner atom; no translation enters the validator. Position B:
  teach the runner parser that gVisor's wrapper is a disjunction. Position B
  creates the second representation/bijection that CT-2298 rejects, so it needs
  an explicit cross-runtime wire decision rather than a convenient parser case.
- **For Wilk — should the fallback provenance atom adopt a Common Fabric type
  URI?** Position A (recommended for this cut): accept its existing typed object
  as an unknown runner atom, where propagation is conservatively value-bound,
  and preserve it in per-invocation evidence. Position B: reject atom types not
  in the runner registry, which would make the verified integrity-bearing
  fallback sidecar unparseable until both repositories change together.
- **For Ben — are diagnostic capability probes part of a run's sandbox taint?**
  Position A (recommended): yes; they are real sandbox executions and excluding
  them could hide exposure, so the engine gives diagnostics the decorated
  runtime. Position B: keep operational probes outside semantic run taint and
  record them in a separate diagnostic evidence class. Position B avoids a
  probe poisoning a run but requires a principled second boundary.
- **For Berni — what may a run aggregate claim about integrity?** Position A
  (recommended): aggregate confidentiality only and retain full integrity per
  invocation, because integrity meet is class-aware and a union would
  over-claim. Position B: define and store a full run-level integrity meet now.
  Position B is useful for later provenance queries but expands CT-2314 into a
  new cross-invocation lattice definition.
- **For Ben — does sandbox evidence need a console surface in this issue?**
  Position A (recommended): persist it in `run-state.json`; keep the present
  console focused on release decisions, policy events, input labels, and
  redactions. Position B: add a run badge and per-step output-evidence pane now.
  Position B makes synthetic denial and unknown immediately visible, but adds
  UI/schema work not required to make the audit authoritative.
- **For Ben — do the memo's four criteria land in CT-2314 or a follow-up?**
  Position A (recommended): land origin, agreement, boundary, and
  absence-is-unknown together because the issue names them as acceptance
  criteria; parser/disposition without the boundary still lets tool adapters
  erase the evidence. Position B: limit CT-2314 implementation to parser,
  disposition, and origin, then track the run aggregate separately. Position B
  is a smaller patch but does not meet the stated acceptance contract.

## Ordering with sibling issues

1. CT-2314 owns and lands the runner parser first. CT-2315 must import this API
   and must not add a FUSE-local or harness-local label parser.
2. CT-2313 is code-independent and may land before or alongside CT-2314, but it
   must land before treating a writable `/fabric` demo as safe when the FUSE
   daemon's CFC mode is off.
3. CT-2315 follows CT-2314 for its validator dependency, then removes the third
   FUSE label representation and corrects `PromptSlotInfluence` without changing
   this plan's sidecar disposition rule.
4. Re-run the CT-2189 and CT-2091 demos after all three siblings land. CT-2091
   specifically proves that a host-provenance integrity label is retained and
   does not withhold public bytes; CT-2189 proves native runner label flow is
   unchanged.

## Completion criteria

The implementation is complete when one runner-owned parser governs sidecar and
future sandbox-ingest labels; primitive gVisor principals and unknown root keys
refuse; integrity-only output is observed with integrity preserved;
confidentiality remains opaque; invalid or absent evidence cannot become
unlabeled; all three channels agree; every actual sandbox invocation is
recorded in exactly one run; unknown is irreversible; parent and child evidence
are separate; artifacts round-trip the result; the live harness documentation
describes it; and all applicable gates above pass.
