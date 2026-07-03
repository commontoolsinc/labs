# CFC enforcement × propagation × write-floor — the deployment mode matrix

_Epic H, stage H4 (first sub-step), of
[`docs/plans/cfc-future-work-implementation.md`](../plans/cfc-future-work-implementation.md).
Spec residual: SC-13 in [`cfc-spec-changes.md`](./cfc-spec-changes.md) (§18) and
the `enforce-strict` differentiation (SC-13 / §18.6.3). This section settles
**which combinations of the CFC dials are conforming deployment states and
in what order a deployment may advance them**, before H4 lands `enforce-strict`
behavior and before H2/H3a flip any shipped host — so the rollout ordering is
written down first._

## 1. The four dials (all runtime-configured, all orthogonal)

CFC has four independent runtime dials. Each is a monotone ladder; none
subsumes another. Their current homes and defaults:

| Dial | Values (weak → strict) | `Runtime` default | Governs |
|---|---|---|---|
| `cfcEnforcementMode` | `disabled` · `observe` · `enforce-explicit` · `enforce-strict` | `enforce-explicit` | whether a boundary **reason rejects** the commit ([types.ts](../../packages/runner/src/cfc/types.ts) `cfcEnforcementStrictness`) |
| `cfcFlowLabels` | `off` · `observe` · `persist` | `off` | whether the per-tx **flow join is derived and persisted** as `derived` label components (S16) |
| `cfcWriteFloor` | `off` · `observe` · `enforce` | `off` | whether the **write-side `requiredIntegrity` floor** (SC-18, Epic D3) is checked against the written value's integrity |
| `cfcTriggerReadGating` | `false` · `true` | `false` | whether the **§8.9.2 trigger reads** (the addresses whose invalidating writes scheduled a rerun) join the enforcement consumed sets (SC-3, Epic H5, #4488) |

They are orthogonal because they gate different things: the **enforcement mode**
decides what happens to a recorded reason (ignore / diagnose / reject); the
**flow dial** decides whether derived labels come into existence; the **write
floor** is one more reason-source, itself dialable so it can be observed before
it rejects; the **trigger-read gate** widens the consumed sets the existing
gates quantify over. A deployment picks a point in the 4 × 3 × 3 × 2 cube — but
most points are not conforming, and the conforming ones are reachable only
along a partial order.

### What each enforcement level means

- **`disabled`** — the boundary pass does not run as a gate; runtime-authored
  provenance mints still run (e.g. the external-ingest mark), but no reason ever
  rejects. This is the operator/toolshed posture where CFC is descriptive only.
- **`observe`** — the boundary pass runs and records reasons as **diagnostics**;
  the commit still succeeds. Used to measure reason volume before enforcing.
- **`enforce-explicit`** — a recorded reason **rejects** the commit. "Explicit"
  because it enforces only the checks whose inputs are explicitly present
  (declared policy, resolvable schema); a write that touches a labeled doc with
  **no resolvable policy input** is flagged, not rejected.
- **`enforce-strict`** — everything `enforce-explicit` rejects, **plus** the
  fail-closed cases explicit tolerates: a missing/unresolvable policy on a
  labeled write **rejects** (not flags), and the writer-fit misfit variant
  (SC-18b) rejects rather than persist-and-flag. This is the H4 target; today
  `enforce-strict` is rankable (strictness 3) but has **no distinct behavior**
  from explicit — H4 gives it one.

## 2. Rollout ordering (the partial order)

Two hard ordering constraints (SC-13), plus one that D3 adds:

1. **`cfcFlowLabels`: `observe` before `persist`.** Persisting derived label
   components changes what is stored on real user documents; a deployment must
   first observe (diagnostics + benches: SC-11 idempotence, volume) that
   derivation is stable and cheap before it writes those components. This is
   the H1 → H2 step.

2. **`persist` before any enforcement that *consumes* derived labels.** An
   enforcement check that reads a `derived` component to make a reject decision
   is only sound once those components are actually being written — otherwise
   the check sees a partial label and either under-blocks (if it treats absence
   as public) or over-blocks (if fail-closed). So `enforce-strict` on the
   flow-derived paths presupposes `cfcFlowLabels: persist`. Concretely:
   `enforce-strict` (H4) and the render ceiling that consumes derived labels
   (H3a/H3b) must not precede H2.

3. **`cfcWriteFloor`: `observe` before `enforce`** (the D3 analogue of #1). The
   floor is a new reason-source; observe its miss volume on real schemas before
   it rejects. Independent of the flow dial — the floor credits the flow meet
   only when `cfcFlowLabels: persist` (else it credits nothing, fail-closed), so
   `cfcWriteFloor: enforce` is *sound* at any flow setting but is only
   *complete* (does not over-reject a legitimately flow-endorsed write) once
   flow persists.

Everything else is free: a deployment may sit at any enforcement level with
flow `off` (the floor and the explicit gate need no derived labels), and may
advance `cfcWriteFloor` on its own schedule. The only forbidden moves are
advancing a *consuming* enforcement ahead of the *production* dial it consumes.

`cfcTriggerReadGating` (H5) adds no ordering constraint: it consumes only
**stored** labels of the trigger addresses (not flow-derived ones), and it is
fail-closed — folding trigger reads into the consumed sets can only reject
*more*, never less, so turning it on is sound at any point in the cube (and a
no-op unless something enforces). Like the other dials it is anti-downgrade
pinned per transaction: once the runtime enables it at tx creation, code
reaching the tx cannot turn it off. It ships `false` pending the per-prepare
metadata-read cost measurement called for in the H5 plan.

```
cfcFlowLabels:   off ──▶ observe ──▶ persist ─────────┐
                                                       ├─▶ enforce-strict on
cfcEnforcementMode: disabled ▶ observe ▶ enforce-explicit ┘   flow-derived paths
                                                             + render ceiling (H3b)
cfcWriteFloor:   off ──▶ observe ──▶ enforce   (independent; complete once flow persists)
```

## 3. Conforming deployment states

A **conforming state** is one where no enforcement consumes a label the flow
dial is not yet producing. The states a deployment is expected to pass through:

| State | enforcement | flow | write-floor | Meaning |
|---|---|---|---|---|
| **Operator / toolshed** | `disabled` | `off` | `off` | CFC descriptive only; provenance mints run, nothing rejects. |
| **Shell today** | `enforce-explicit` | `persist` | `off` | Explicit checks enforce; flow labels persisted (H2, inv-9 active); floor not yet dialed. |
| **Shell + floor observe** | `enforce-explicit` | `persist` | `observe` | Add the write floor as diagnostics (D3 dial-up step). |
| **Shell + floor enforce** | `enforce-explicit` | `persist` | `enforce` | Floor rejects; complete on flow-endorsed writes (flow persists). |
| **Strict** | `enforce-strict` | `persist` | `enforce` | Missing-policy and writer-fit fail-closed (H4); render ceiling consumes derived labels (H3b). The end state. |

**Non-conforming** examples (a linter/deploy-check should reject): any
`enforce-strict` with `cfcFlowLabels ≠ persist` (strict consumes derived labels
the dial isn't producing); `cfcFlowLabels: persist` with `cfcEnforcementMode:
disabled` is *permitted but pointless* (labels written, never consulted) — a
warning, not an error.

The trigger-read gate composes freely with every state above: each state ×
`cfcTriggerReadGating ∈ {false, true}` is conforming wherever the state is
(fail-closed widening, §2). The expected move is dialing it `true` from any
enforcing state once the H5 cost measurement clears; with `cfcEnforcementMode:
disabled` it is *permitted but pointless*, like `persist`-without-enforcement.

## 4. What `enforce-strict` adds (the H4 implementation contract)

H4's code step (separate PR) implements the strict-only rejects at the
enforcement ladder
([extended-storage-transaction.ts](../../packages/runner/src/storage/extended-storage-transaction.ts)),
each gated so `enforce-explicit` keeps today's behavior:

- **Missing-policy fail-closed.** A write touching a labeled document with no
  resolvable schema/policy input **rejects** under strict (flags under
  explicit). Error contract (SC-18c): a stable reason string naming the target
  and the absent policy.
- **Writer-fit reject (SC-18b).** The `canWrite` confidentiality misfit rejects
  under strict instead of persist-and-flag. Reason string names the rule id and
  path.

Both are the fail-closed direction, so strict never *accepts* something explicit
rejects — it only *rejects more*. That keeps the strictness ranking honest
(`cfcEnforcementStrictness`: strict = 3 > explicit = 2) and the anti-downgrade
pin (a tx cannot be weakened below its established floor) meaningful once strict
carries distinct behavior.

## 5. Spec-owed

A spec PR to `commontoolsinc/specs` records the §18.6.3 conformance text: the
dial matrix, the "no consuming enforcement ahead of its producing dial"
ordering constraint, and the `enforce-strict` reject set. File it once H4's code
step lands and the strict rejects have concrete reason contracts to cite.
Tracked in [`cfc-spec-changes.md`](./cfc-spec-changes.md) SC-13.

## Provenance

Grounded in the four implemented dials — `cfcEnforcementMode`
([types.ts](../../packages/runner/src/cfc/types.ts)), `cfcFlowLabels` (H1),
`cfcWriteFloor` (D3, #4479), and `cfcTriggerReadGating` (H5, #4488) — plus the
SC-13 rollout constraint in
`cfc-spec-changes.md` and the current shell posture
([lib-shell/src/runtime.ts](../../packages/lib-shell/src/runtime.ts):
`enforce-explicit` + flow `persist`, H2).
