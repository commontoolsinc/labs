---
status: historical
created: 2026-07-15
archived: 2026-07-15
reason: "R3/R4 unservable-action diagnosis and C0 claim-coverage enumeration for server-primary execution; motivates the Phase 2.6 work orders (implementation-plan §4.6)."
---

# Server-primary execution: R3/R4 diagnosis and C0 coverage enumeration

Measured at branch head `1ffafbde1` (stacked PRs #4692/#4713) after the
owner ruling that register entries R3 (`untrusted-implementation`) and R4
(`incomplete-static-surface`) are defect classes with target zero. One
instrumented flag-on default-app integration run (placement guard on,
`PORT_OFFSET` pinned), with temporary verdict logging wrapped around
`classifyStaticActionServability` in
`packages/runner/src/scheduler/servability.ts`, plus two static analyses of
the provenance and certificate pipelines. Diagnosis was executed by three
Opus 4.8 max-effort agents (one measurement in an isolated worktree, two
read-only mappers) with findings cross-verified against source.

## Headline

**37 verdicts, 18 distinct offenders, 7 pieces, exactly two mechanisms.**
28 verdicts / 13 distinct were R3; 9 verdicts / 5 distinct were R4;
`unknown-effect-surface` never fired. The earlier ~44 + ~14 per-run figures
were the same composition at a higher capture rate (this run created one
note; negative-caching landed since), not a different population.

## R3: raw builtins, nothing else

Every R3 offender was a `map` (7 distinct), `wish` (4), or `ifElse` (2)
node with fingerprint shape `action:…:raw:{map|wish|ifElse}:…`.

- Fingerprints are `impl:${implementationHash}` else
  `action:${telemetryId}:${actionId}` (`scheduler/run.ts:875-895`).
  `implementationHash` is stamped only from `getVerifiedProvenance`
  (`runner.ts:3372-3385`), and provenance is recorded only by
  `Engine.recordModuleProvenance` for SES-verified module exports and
  `__cfReg`-hoisted builder artifacts.
- Authored pattern code is therefore fully covered — the transformer hoists
  every lift/computed/handler/pattern and emits `__cfReg`; **zero
  `cf:module/` implementations were rejected**.
- Raw builtins are host functions registered by canonical registry ref
  (`builtins/index.ts`), never SES-evaluated. Only
  `SERVER_EXECUTABLE_BUILTIN_IDS` (five `fetch*`, `generateText`,
  `generateObject`) get the static `impl:cf:builtin/<id>:server-v1` stamp;
  every other builtin falls to the no-op `applyImplementationHash`
  (`runner.ts:5096-5104`).
- `ifElse` is structural: the expression-site transformer lowers JSX
  ternaries and `&&`/`||` to `ifElse`/`when`/`unless`, so conditional
  rendering guarantees R3 — the measured patterns contain zero literal
  `ifElse(` calls.
- Latent same-class members that did not appear in this run: `filter`,
  `flatMap`, `llm`, `sqliteQuery`, `sqliteDatabase`, `streamData`,
  `navigateTo`, `compileAndRun`, `llmDialog`, `inspectConfLabel`; and
  host-trusted values (`trustHostValue` records no provenance by design —
  the deferred synthetic-identity registrar of
  `docs/specs/content-addressed-action-identity.md` §5).

## R4: missing certificates on trusted implementations

All five offenders carry `impl:cf:module/…` fingerprints and fail only the
summary-presence bit. The certificate (`completeSchedulerScopeSummary`) is
emitted at exactly two transformer sites, both on the `computed()` path;
the gate (`lift-applied-strategy.ts:156-172`) rejects
recursive/wildcard/passthrough/opaque params, and `toCapability` defaults
to opaque for whole-value use.

| Offender | Authored shape | Root cause |
| --- | --- | --- |
| note.tsx `__cfLift_12`/`__cfLift_13` | `allNotesPiece ? "block" : "none"` (truthiness on an opaque piece ref) | RC-1: opaque whole-value read; read-only |
| note.tsx `__cfLift_5` | `_parentNotebook ?? new Writable(null)` | RC-1: `??` passthrough; read-only |
| backlinks-index `computeMentionable` | direct module-scope `lift()`; recursive helper, dynamic reads, **no cell writes** | RC-2 (builder form has no certificate path at all) + recursion |
| backlinks-index `computeIndex` | direct `lift()`; writes `allPieces[*].backlinks`, `allPieces[*].mentioned[*].backlinks` | RC-2 + RC-3a: genuinely data-dependent write surface |

Control contrast that pins RC-1: the structurally identical
`__cfLift_11` (`menuOpen.get() ? …`) **is** certified — the only
difference is `.get()` on a readable cell versus bare truthiness on an
opaque reference. A latent sixth (`__cfLift_19`,
`notebook[NAME] ?? "Untitled"`) is the same class.

Post-C0 reframing: the firewall bounds only **writes** to the static
envelope (`servability.ts:315-329`); reads are admitted dynamically
per-address (`:302-314`). The certificate gate is therefore stricter than
the firewall requires for read-only computations — the basis of the W2.12
relaxation. A runtime-assembled `writes: []` summary is fail-closed sound
(any write is rejected as `dynamic-write-outside-static-surface`), which
covers the recursive read-only case; only `computeIndex`'s dynamic write
surface has no honest certificate and needs redesign (W2.16).

## C0 claim coverage (feed-start evidence per resolved OQ4)

Placement guard passed; the note-create window ran authoritative-server
(mode `authoritative-server`, 0 shadow transactions in-window).

- Control: 14 claims issued, 0 reissued, 0 claimed-action conflicts,
  27 accepted attempts, 27 settlements published (15 committed / 12 no-op /
  **0 unserved / 0 failed**), 0 lease-fence or firewall rejects.
- `invalidation-settlement`: avg 418 ms, p95 456 ms (n=4) — versus the
  20.5 s averages before Phase 2.5.
- The unclaimed surface is exactly the 18 static rejections above: they are
  rejected at candidate classification, before claims exist, which is why
  `settlementsUnserved` and `actionFirewallRejects` stay zero.
- Context floors (`scheduler_context_floor`, all spaces): 70 space /
  31 session / **0 user** rows; `scheduler_action_snapshot` stores no
  verdicts (known observations only, `unknown_reason` NULL for all rows).

## Method notes

- `/api/health/stats` has no per-reason unservability breakdown and no
  per-action identity; instrumentation was required to name offenders.
- The client-execution router early-returns for claimless actions before
  ever calling the classifier
  (`client-execution/action-transaction-router.ts:48`), so the complete
  R3/R4 population is only observable on the executor/server path — future
  acceptance runs must observe the executor-side classifier.
- Fixes are specified as implementation-plan §4.6 (Phase 2.6, W2.11–W2.16);
  the register rows R3/R4 in `context-lattice-execution.md` §8 point there.
