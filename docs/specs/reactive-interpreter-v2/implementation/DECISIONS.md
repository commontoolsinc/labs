# Reactive Interpreter v2 — Decision Log

Append-only. Date + evidence. Divergences from the design docs land here
first, then the design doc is amended.

## D-V2-BRANCH — build on `claude/priceless-rubin-89ad5e` (2026-07-02)

The branch is `origin/main` + the v2 spec — i.e. it already *is* "a new
branch from main". #4298 is harvest-only (files ported and adapted, never
merged). Rationale: #4298 is +30k lines against a main that has moved, and
its architecture (runtime extraction) is what v2 rejects.

## D-V2-SEQ — builder-first, transformer-second (2026-07-02)

06-migration-plan's V0/V1 put "transformer emits the ROG artifact + ROG →
legacy expander" first. Refined: **the builder is the first (and unifying)
IR front-end.** Compiled patterns *execute builder calls* at construction
time (the transformer emits `__cfHelpers.lift(...)`/`ifElse(...)`/`h(...)`
calls), so making the builder record IR ops during `pattern()` construction
covers compiled AND hand-built patterns with:

- **zero recognition** (the builder has the live semantic call — `ifElse`
  knows its branches, `str` knows its template — v1's extract.ts existed
  only because it started from serialized JSON);
- **zero transformer change** at first (native expr/str ops are W5
  increments on a working pipeline);
- **no expander needed** until legacy-node retirement (the builder keeps
  building legacy nodes as today; the ROG rides alongside, inert flag-off).

Consequences: the pattern JSON gains a versioned optional `rog` field so
*loaded* patterns interpret without re-derivation; the field MUST be
identity-neutral (pattern hashing/content-addressing unchanged — old and new
serializations of the same pattern keep the same identity). 01-decisions
D-V2-ARTIFACT §1–2 remain the end-state; the expander moves to the
legacy-retirement stage.

Risk accepted: builder-recorded ROG must stay consistent with the legacy
nodes it parallels (one source of calls builds both, so divergence = a
builder bug, caught by the differential oracle).

## D-V2-HARVEST-BASE — port-and-adapt, never blind-copy (2026-07-02)

#4298 is based on a main a few days older (its HEAD `99c8b1eca`,
2026-06-30); every harvested file is compiled + tested against current main
before commit. Harvest order: rog.ts (W1), interpret.ts + partition.ts +
measurement harness (W3), collection-interpreter mechanics (W4), test
oracles per work order.

## D-V2-ROG-SIDETABLE — ROG lives in a WeakMap side-table, never in the pattern JSON (2026-07-02)

Recon (builder pipeline, cited to main): pattern identity is content-addressed
from serialized bytes, so ANY new serialized field breaks identity stability
for every existing pattern. Also: compiled patterns are constructed by
EXECUTING the factory once at module load (`pattern(fn)` pushes a frame, runs
fn, collects nodes — builder/pattern.ts:122-168), and `$patternRef`-loaded
patterns resolve through the artifact index back to that factory. So:

- The ROG is built at `pattern()` FINALIZATION from live objects (NodeRefs
  with live modules, live input/output cells) — direct Map lookups, zero
  shape recognition. `str` emits `interpolate` (the builder holds the static
  template), `ifElse`/`when`/`unless` emit tagged `control`, builtin refs
  classify by NAME into effect ops — v1's recognizers become emissions.
- Attached via WeakMap (pattern-metadata idiom): identity-neutral by
  construction, no serialization change at all.
- A pattern that arrives as PLAIN JSON with no live factory has no ROG →
  legacy instantiation (exactly D-V2-ARTIFACT's "old artifacts on the legacy
  loader"). Coverage census tracks how often this occurs.
- ROG construction is ALWAYS-ON (cheap, inert data); the flag gates dispatch
  only. An unsupported builder shape marks the ROG incomplete with a reason
  (fail-closed → legacy dispatch) rather than failing construction.

Amends 02-ir.md §3 (serialization) and D-V2-SEQ's "versioned optional `rog`
field" — superseded by the side-table.

## D-V2-INTERNALS-TABLE — internals are table-indexed, not string-keyed (2026-07-02)

v1 keyed internal cells by `JSON.stringify`ed partialCause strings. v2: each
Rog carries `internals: InternalDecl[]` ({partialCause, schema?}) and
`internal` ValueRefs point by INDEX. Nested Rogs have their own table (frames
fall out structurally; no FrameId needed).

## D-V2-F4-DEFER — no write-back cut edges in the first partition (2026-07-02)

The v2 partition ships WITHOUT F4 (boundary write-back) cut edges, despite
the IR carrying `effect.writeTargets`. Three reasons: (1) v1 reached CI-ON
green without them (F4 stayed an open finding); (2) naive edges create a
false cycle — a handler's input CONSTRUCT references the very cell the
handler writes (a binding, not a read-after-write), so every handler pattern
would fail-closed; (3) under pull scheduling the hazard is re-run churn /
conflict surface, not value correctness. Plan: measure lunch-poll conflicts
once dispatch lands (the user's watch-carefully directive), then add edges
that EXCLUDE each boundary's own binding constructs if the ratchet appears.

## D-V2-PURE-PATTERN-INLINE — pure nested patterns are segment-resident (2026-07-02)

A nested `pattern` op whose child BuiltRog is complete and recursively pure
is NOT a boundary: it stays inside its segment and evalRog inlines the child
(v1's W5a win, now by construction at partition time). Only effectful /
incomplete / plain-JSON children remain `pattern` boundaries.
