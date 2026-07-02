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
