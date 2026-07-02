# Reactive Interpreter v2 — Progress

One row per work order; log entries newest-last. Every landed row carries
measured numbers (OFF vs ON, same commit) once W3 exists.

## Status

| WO | Status | Measured outcome |
| --- | --- | --- |
| W0 — plan + decisions | ✅ done (`804f881b7`) | — |
| W1 — IR v2 core | ✅ done (`667ecf1bd`) | rog.ts + unit tests; internals table-indexed; normalized control tags |
| W2 — builder-born ROG | ✅ done (`b01b75554`) | Zero-recognition front-end at pattern() finalization (WeakMap side-table); str→interpolate native; unknown refs fail-closed to effect boundaries; full runner suite 738/0 with construction ALWAYS-ON (baseline parity) |
| W3 — flag-on dispatch + measurement harness | 🟡 in progress | W3a evaluator landed (`88d139fba`): v1 semantics ported to IR v2, end-to-end green over builder-born ROGs (control falsy-operands, str coercion, error isolation, probe, nested inline). Next: partition port + dispatch seam + census/measure harness |
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
  D-V2-F4-DEFER + D-V2-PURE-PATTERN-INLINE recorded). NEXT: the dispatch
  seam (flag-on at instantiatePattern consuming BuiltRog + partition),
  measurement harness port (doc#/node#/wall census), then root test +
  integration both flags + the cfc-group-chat multi-user sim.
