# CFC enforcement × propagation × write-floor × trigger gating — the deployment mode matrix

_Epic H, stage H4 (first sub-step), of
[`docs/plans/cfc-future-work-implementation.md`](../plans/cfc-future-work-implementation.md).
Spec residual: SC-13 in [`cfc-spec-changes.md`](./cfc-spec-changes.md) (§18) and
the `enforce-strict` differentiation (SC-13 / §18.6.3). This section settles
**which combinations of the five CFC dials are conforming deployment states and
in what order a deployment may advance them**, before H4 lands `enforce-strict`
behavior and before H3a flips any shipped host — so the rollout ordering is
written down first._

## 1. The five dials (all runtime-configured, all orthogonal)

CFC has five independent runtime dials. Each is a monotone ladder; none
subsumes another. Their current homes and defaults:

| Dial | Values (weak → strict) | `Runtime` default | Governs |
|---|---|---|---|
| `cfcEnforcementMode` | `disabled` · `observe` · `enforce-explicit` · `enforce-strict` | `enforce-explicit` | whether a boundary **reason rejects** the commit ([types.ts](../../packages/runner/src/cfc/types.ts) `cfcEnforcementStrictness`) |
| `cfcFlowLabels` | `off` · `observe` · `persist` | `off` | whether the per-tx **flow join is derived and persisted** as `derived` label components (S16) |
| `cfcWriteFloor` | `off` · `observe` · `enforce` | `off` | whether the **write-side `requiredIntegrity` floor** (SC-18, Epic D3) is checked against the written value's integrity |
| `cfcTriggerReadGating` | `false` · `true` | `false` | whether the **§8.9.2 trigger reads** — the addresses whose invalidating writes scheduled this run — join the enforcement consumed sets: the sink-request ceiling and the `requiredIntegrity` input gate (SC-3 / H5; [runtime.ts](../../packages/runner/src/runtime.ts) `cfcTriggerReadGating`, [types.ts](../../packages/runner/src/cfc/types.ts) `CfcTriggerReadGating`, consumed in [prepare.ts](../../packages/runner/src/cfc/prepare.ts) `triggerReadSources`) |
| `cfcPolicyEvaluation` | `off` · `observe` · `enforce` | `off` | whether the **exchange-rule evaluator** (spec §4.4.5, Epic B5) rewrites gated labels to a fuelled fixpoint before the sink-request ceiling and `requiredIntegrity` input gates fit them. `observe` evaluates + diagnoses divergence but decides on the *un-rewritten* label; `enforce` decides on the *rewritten* label and **fails closed on fuel exhaustion or policy-lookup failure**. ([runtime.ts](../../packages/runner/src/runtime.ts) `cfcPolicyEvaluation` + `cfcPolicyRecords`, consumed in [prepare.ts](../../packages/runner/src/cfc/prepare.ts) `evaluateGatedConfidentiality`) |

They are orthogonal because they gate different things: the **enforcement mode**
decides what happens to a recorded reason (ignore / diagnose / reject); the
**flow dial** decides whether derived labels come into existence; the **write
floor** is one more reason-source, itself dialable so it can be observed before
it rejects; **trigger gating** widens what the existing gates count as consumed
(a handler scheduled by a labeled write is treated as having read it, even if
its executed branch never re-reads it); **policy evaluation** rewrites the label
a gate fits *before* the fit, so a discharge/exchange rule can admit a flow the
raw label would refuse (and, in `enforce`, a fuel-exhausted or unresolvable
rewrite becomes a fail-closed reason rather than a silent pass-through). A
deployment picks a point in the 4 × 3 × 3 × 2 × 3 cube — but most points are not
conforming, and the conforming ones are reachable only along a partial order.

### What each enforcement level means

- **`disabled`** — the boundary pass does not run as a gate; runtime-authored
  provenance mints still run (e.g. the external-ingest mark), but no reason ever
  rejects. CFC is descriptive only. This posture exists only by **explicitly
  passing** `cfcEnforcementMode: "disabled"` — no shipped host does today
  (toolshed constructs its `Runtime` with no CFC options and therefore runs the
  `enforce-explicit` default; see §3).
- **`observe`** — the boundary pass runs and records reasons as **diagnostics**;
  the commit still succeeds. Used to measure reason volume before enforcing.
- **`enforce-explicit`** — a recorded reason **rejects** the commit, and that
  **includes the missing-policy case**: a write that touches a labeled doc with
  **no resolvable schema/policy input** records a
  `missing schema write-policy input` reason
  ([prepare.ts](../../packages/runner/src/cfc/prepare.ts)), and the enforcement
  ladder rejects any reasoned transaction under both enforcing modes
  ([extended-storage-transaction.ts](../../packages/runner/src/storage/extended-storage-transaction.ts));
  asserted under explicit mode in
  [cfc-boundary.test.ts](../../packages/runner/test/cfc-boundary.test.ts)
  ("missing schema write-policy input"). "Explicit" refers to which checks
  *run* — those whose declared inputs (policy, resolvable schema) are present —
  not to tolerating absent policy on labeled docs; that case is already
  fail-closed.
- **`enforce-strict`** — everything `enforce-explicit` rejects, **plus**
  strict-only fail-closed rejects. The one specified today is the writer-fit
  misfit variant (SC-18b): the `canWrite` confidentiality misfit **rejects**
  rather than persist-and-flag; future checks that want a persist-and-flag
  grace under explicit put their reject here. This is the H4 target; today
  `enforce-strict` is rankable (strictness 3) but has **no distinct behavior**
  from explicit — H4 gives it one.

## 2. Rollout ordering (the partial order)

Two hard ordering constraints (SC-13), plus one that D3 adds and one that H5
adds:

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

4. **`cfcTriggerReadGating` is one-hop only until flow persists.** The gate may
   flip on at any point — it only *adds* consumed labels, so it is sound at any
   flow setting — but it closes only the **direct** trigger channel. A handler
   can evade it through an intermediary: the triggered handler writes an
   **unlabeled** doc; that doc's write schedules a second run, which egresses —
   and the second run's trigger reads point at the unlabeled intermediate, so
   they contribute nothing. Multi-hop closure requires `cfcFlowLabels: persist`
   stamping the intermediate doc's derived label so the second hop's trigger
   read picks it up. Same shape as the write floor in #3: sound anywhere,
   **complete only once flow persists**.

5. **`cfcPolicyEvaluation`: `observe` before `enforce`, and `enforce` only
   *loosens*.** The evaluator adds alternatives (discharge/exchange), so a
   rewritten label fits *more* ceilings than the raw one — turning it on can
   only admit flows the raw label refused, never reject a flow the raw label
   admitted, EXCEPT the deliberate fail-closed cases: in `enforce`, fuel
   exhaustion or a policy-lookup failure records a reason instead of passing
   the un-rewritten label through (invariant 6 — a policy violation disables
   exchange, it never silently downgrades). So `observe` is the honest
   dial-up step (diagnose which labels the rewrite would have changed, decide
   on the un-rewritten label) before `enforce` lets the rewrite actually
   admit. It is **sound at any flow / enforcement setting** — it consumes the
   same consumed labels the sink-request and input gates already fit, only
   rewritten first — so it may advance on its own schedule. It is only
   *useful* once `cfcPolicyRecords` are configured (an empty policy set makes
   evaluation a no-op at every setting).

Everything else is free: a deployment may sit at any enforcement level with
flow `off` (the floor and the explicit gate need no derived labels), and may
advance `cfcWriteFloor` / `cfcPolicyEvaluation` on their own schedules. The
only forbidden moves are advancing a *consuming* enforcement ahead of the
*production* dial it consumes.

```
cfcFlowLabels:   off ──▶ observe ──▶ persist ─────────┐
                                                       ├─▶ enforce-strict on
cfcEnforcementMode: disabled ▶ observe ▶ enforce-explicit ┘   flow-derived paths
                                                             + render ceiling (H3b)
cfcWriteFloor:   off ──▶ observe ──▶ enforce   (independent; complete once flow persists)
cfcTriggerReadGating: false ──▶ true           (independent; one-hop until flow persists)
cfcPolicyEvaluation: off ──▶ observe ──▶ enforce  (independent; only loosens, save fail-closed exhaustion)
```

## 3. Conforming deployment states

A **conforming state** is one where no enforcement consumes a label the flow
dial is not yet producing. The states a deployment is expected to pass through:

| State | enforcement | flow | write-floor | trigger | Meaning |
|---|---|---|---|---|---|
| **Operator (explicitly disabled)** | `disabled` | `off` | `off` | `false` | CFC descriptive only; provenance mints run, nothing rejects. Requires explicitly passing `cfcEnforcementMode: "disabled"` — no shipped host does today. |
| **Server hosts today (toolshed, background-piece-service)** | `enforce-explicit` | `off` | `off` | `false` | Neither host passes any CFC option ([toolshed/index.ts](../../packages/toolshed/index.ts), [background-piece-service main.ts](../../packages/background-piece-service/src/main.ts)), so both inherit the `Runtime` defaults. Conforming: explicit checks consume no derived labels. |
| **Shell today** | `enforce-explicit` | `persist` | `off` | `false` | Explicit checks enforce; flow labels persisted (H2, inv-9 active); floor not yet dialed. |
| **Shell + floor observe** | `enforce-explicit` | `persist` | `observe` | `false` | Add the write floor as diagnostics (D3 dial-up step). |
| **Shell + floor enforce** | `enforce-explicit` | `persist` | `enforce` | `false` | Floor rejects; complete on flow-endorsed writes (flow persists). |
| **Strict** | `enforce-strict` | `persist` | `enforce` | `true` | Writer-fit fail-closed (H4); render ceiling consumes derived labels (H3b); trigger reads gated, multi-hop complete since flow persists. The end state. |

Trigger gating may flip to `true` at any of these states (ordering constraint
#4: it is sound anywhere) — the table shows it flipping at the end state
because before `cfcFlowLabels: persist` it closes only the one-hop channel.

`cfcPolicyEvaluation` is omitted from the state columns above because it is
`off` in every shipped host today (no host passes `cfcPolicyRecords`, so the
evaluator has no rules to run). It advances on its own schedule (ordering
constraint #5: sound anywhere, only loosening save fail-closed exhaustion), so
a deployment adds `observe` then `enforce` alongside whichever of the states
above it is in, once it configures a policy set (e.g. the §10.1 standard
prompt-caveat profile).

**Non-conforming** examples (a linter/deploy-check should reject): any
`enforce-strict` with `cfcFlowLabels ≠ persist` (strict consumes derived labels
the dial isn't producing); `cfcFlowLabels: persist` with `cfcEnforcementMode:
disabled` is *permitted but pointless* (labels written, never consulted) — a
warning, not an error.

## 4. What `enforce-strict` adds (the H4 implementation contract)

H4's code step (separate PR) implements the strict-only rejects at the
enforcement ladder
([extended-storage-transaction.ts](../../packages/runner/src/storage/extended-storage-transaction.ts)),
each gated so `enforce-explicit` keeps today's behavior.

**Not part of the delta: missing-policy.** A write touching a labeled document
with no resolvable schema/policy input **already rejects under
`enforce-explicit`**: the prepare pass records a
`missing schema write-policy input for <id>` reason
([prepare.ts](../../packages/runner/src/cfc/prepare.ts)), the ladder rejects
any reasoned transaction under both enforcing modes, and
[cfc-boundary.test.ts](../../packages/runner/test/cfc-boundary.test.ts)
asserts the reject in explicit mode. Its SC-18c error contract (a stable reason
string naming the target) is likewise already shipped. H4 must **not** move
this check behind the strict gate — that would weaken the shipped shell
posture (anti-fail-closed).

The strict-only delta is:

- **Writer-fit reject (SC-18b).** The `canWrite` confidentiality misfit rejects
  under strict instead of persist-and-flag. Reason string names the rule id and
  path (SC-18c). This does **not** exist in code yet — it is H4's contract.
- **Future strict-only fail-closed cases.** Any new check that wants a
  persist-and-flag grace under explicit puts its reject at the strict level,
  same shape.

These are the fail-closed direction, so strict never *accepts* something
explicit rejects — it only *rejects more*. That keeps the strictness ranking
honest (`cfcEnforcementStrictness`: strict = 3 > explicit = 2) and the
anti-downgrade pin (a tx cannot be weakened below its established floor)
meaningful once strict carries distinct behavior.

## 5. Spec-owed

A spec PR to `commontoolsinc/specs` records the §18.6.3 conformance text: the
four-dial matrix, the "no consuming enforcement ahead of its producing dial"
ordering constraint, and the `enforce-strict` reject set. File it once H4's code
step lands and the strict rejects have concrete reason contracts to cite.
Tracked in [`cfc-spec-changes.md`](./cfc-spec-changes.md) SC-13.

## Provenance

Grounded in the four implemented dials — `cfcEnforcementMode`
([types.ts](../../packages/runner/src/cfc/types.ts)), `cfcFlowLabels` (H1),
`cfcWriteFloor` (D3, #4479), and `cfcTriggerReadGating` (H5, #4488) — plus the
SC-13 rollout constraint in `cfc-spec-changes.md` and the current host
postures: shell
([lib-shell/src/runtime.ts](../../packages/lib-shell/src/runtime.ts):
`enforce-explicit` + flow `persist`, H2); toolshed and
background-piece-service (no CFC options passed → `Runtime` defaults,
`enforce-explicit` + flow `off`).
