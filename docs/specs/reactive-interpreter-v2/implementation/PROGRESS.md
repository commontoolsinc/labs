# Reactive Interpreter v2 — Progress

One row per work order; log entries newest-last. Every landed row carries
measured numbers (OFF vs ON, same commit) once W3 exists.

## Status

| WO | Status | Measured outcome |
| --- | --- | --- |
| W0 — plan + decisions | ✅ done (`804f881b7`) | — |
| W1 — IR v2 core | ✅ done (`667ecf1bd`) | rog.ts + unit tests; internals table-indexed; normalized control tags |
| W2 — builder-born ROG | ✅ done (`b01b75554`) | Zero-recognition front-end at pattern() finalization (WeakMap side-table); str→interpolate native; unknown refs fail-closed to effect boundaries; full runner suite 738/0 with construction ALWAYS-ON (baseline parity) |
| W3 — flag-on dispatch + measurement harness | ✅ done (runner level) | W3a–W3f (`88d139fba`…`886ee0a8b`). Vertical slice green; differential + fallback oracles; measurement harness. Numbers (compute-heavy pure pattern): **nodes −58–64%, docs flat/−1, wall −70–75%**, census interpreted. Flag-ON triage 27→15→4→**1** (only reload-sibling-overdirty: legacy-topology introspection + interpreter-node REHYDRATION IDENTITY, tracked follow-up). **Flag-OFF 738/0** (byte-clean). Gates landed: liveTrusted leaf trust (SECURITY), leaf caps (instantiatesPattern/needsCellContext/writesInput; v1's schema suppression DROPPED as unsound), scope_narrowing + narrowest-read-scope threading (opt-in raw marker), control_reference_semantics (links vs values — emission follow-up), no_node_ops cost gate, pattern-inline reverted to opt-in (piece-identity contract). |
| W4 — collections Option A | ⬜ | — |
| W5 — transformer native ops | ⬜ | — |
| W6 — function lowering | ⬜ | — |
| W7 — suites + chat sim + measurements (continuous) | ⬜ | — |

Legend: ⬜ not started · 🟡 in progress · ✅ done · ⛔ blocked.

## Baselines to beat (v1-measured, from #4298)

- Legacy law: docs ≈ 5 + 3N, nodes ≈ 8 + 4N per collection pattern.
- v1 flag-on results (the bar): interpretable-op engagement 88.4%
  (integration corpus), nodes −26→−33%, docs −34%, rendered lists −60%
  docs / −40% nodes per element, lunch-poll wall −7–14%.
- v1 pathologies (must NOT reproduce): cfc-group-chat multi-user flag-on
  ~226× timeout; F4 I/O-coalesce conflict ratchet.

## Log

- (2026-07-02) Campaign start. Branch = main(0cf48b278) + v2 spec
  (7c47ece87). Baseline root `deno task test` kicked off; builder recon in
  flight; W0 docs this entry.
- (2026-07-02) Baseline pinned: root `deno task test` 210.5s, all green.
  Builder recon: pattern identity is content-addressed from serialized bytes
  → D-V2-ROG-SIDETABLE (WeakMap, never serialized); compiled patterns
  execute builder calls at module load → builder front-end covers them.
- (2026-07-02) W1 landed (`667ecf1bd`): rog.ts v2 + unit tests.
- (2026-07-02) W2 landed (`b01b75554`): builder-born ROG at pattern()
  finalization; str hoisted + native interpolate; tagged control; unknown
  refs fail-closed to effect boundaries. Runner package suite **738/0**
  with construction ALWAYS-ON (regression gate green).
- (2026-07-02) W3a landed (`88d139fba`): evalRog v2 (v1 semantics ported;
  indexed internals; ONE normalized control rule; recursive children).
  End-to-end green over builder-born ROGs.
- (2026-07-02) W3b landed (`b8ff8088e`): partition v2 (structural recursion,
  principled external-internal inputs, pure-nested-pattern inline;
  D-V2-F4-DEFER + D-V2-PURE-PATTERN-INLINE recorded).
- (2026-07-02) W3c landed (`6acd8702d`, measurement `8cb0c7597`): flag-on
  dispatch, single-segment increment. Synthetic `{type:"raw"}` node whose
  outputs binding maps op ids → the ops' ORIGINAL serialized aliases (one
  sendResult == the N legacy writes). Runner diff ~15 lines. Differential
  oracle green; first numbers: nodes −64%, docs −1, wall −75% (shape:
  6 lifts + 2 str + ifElse).
- (2026-07-02) **Flag-ON corpus triage (full runner suite, 711/27).**
  Failure classes, mapped to v1 precedents:
  1. **SES security regressions ×3** — leafImpls captured at build time run
     WITHOUT the trust gate legacy applies at resolution
     (`resolveJavaScriptFunction` liveTrusted). FIX FIRST (security): dispatch
     admits a leaf only if it passes a runner-supplied trust predicate
     (v1 interpreterLiveLeafTrustCheck idiom); else unresolved-leaf boundary
     → fallback.
  2. **Leaf caps gates missing** — "patterns returned by lifted functions",
     "named cell inside a lift", "sample()", Schemas ×2 (asCell handles):
     need v1's static scans as capture-time caps (instantiatesPattern /
     needsCellContext / async) + a builder frame (runtime+tx) pushed around
     evalRog so cell() inside a lift body works.
  3. **ifElse semantics ×3** — legacy builtin writes a branch REFERENCE
     (write-once on re-trigger); the control op resolves values. Includes an
     action-NAMING introspection test (possible test-artifact class).
  4. **Dynamic patterns ×5** — derive-returning-pattern (CT-1316) + dynamic
     instantiation: dynamic module → must stay legacy (gate probably missing
     a dynamic-module case at dispatch).
  5. **reload-sibling-overdirty + scheduler event receipts** — synthetic-node
     rehydration/identity semantics; investigate.
  6. **Stack traces ×2** — error-frame parity (the documented onError gap).
  Strategy (v1's proven move): add capture/dispatch gates so classes 1/2/4
  fall back fail-closed → drives flag-ON green while census keeps honest
  engagement; then re-admit classes with proper support.
- (2026-07-02) **Triage complete: flag-ON 27→15→4→1** (W3d `fb12b5f98`,
  W3e `87c28a75e`, W3f `886ee0a8b`, stdout fix `3e9388741`). Landed: trust
  gate; leaf caps (v1 schema-suppression DROPPED as unsound — a typed
  factory-application lift is a silent wrong value); scope: narrowest-read-
  scope threading behind an opt-in raw-module marker + per-run reset
  (pattern-scope 39/0); control_reference_semantics gate (legacy ifElse
  writes a resolved LINK with onlyIfDifferent through its own minted cell —
  faithful emission deferred; in multi-segment emission control ops can stay
  legacy BOUNDARY nodes, recovering those patterns without link-emission);
  no_node_ops cost gate; pattern-inline reverted to opt-in (a handler-built
  child pushed into a list must be an addressable PIECE — value-inlining
  broke it). Remaining 1: reload-sibling-overdirty (legacy-topology
  introspection + interpreter-node rehydration identity — real follow-up).
  Env-flag stdout pollution fixed (override log = caller-passed only, on
  stderr; cli dev green both flags). NEXT: multi-segment emission (segments
  + preserved boundary nodes — the engagement unlock for handler/control/
  effect patterns), then W4 collections.
