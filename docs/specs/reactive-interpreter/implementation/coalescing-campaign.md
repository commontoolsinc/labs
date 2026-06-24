# Coalescing campaign — drive real engagement to green

GOAL (Berni, 2026-06-24, AFK autonomous): the integration suite GREEN **with the
interpreter actually engaged on most patterns** (coalescing = interpret pure
regions, keep handlers/collections/effects as boundary nodes). Fallback only for
genuinely rare array-ish ops — nothing core (handlers, maps, computeds, lifts,
ifElse/when, derived) must fall back. Measure REAL engagement (`interpreted_ok` on
the realistic integration suite), never green-via-fallback (see
[[proxy-metric-decoupling]]).

## Measurement
`cd packages/generated-patterns && CF_EXPERIMENTAL_INTERPRETER=1 RI_CENSUS_DUMP=1 LOG_LEVEL=error deno test -A --parallel ./integration/patterns/*.test.ts`
then aggregate per-scenario `interpreted_ok>0` and `fallback_by_reason`.
Hard invariant every increment: flag-off `packages/runner` `deno task test` == 658/0.

## Baseline (after spike 357f25d06, harness trust = untrusted)
- engaged: 5 / 144. fallbacks: unresolved_leaf 123 (trust gate ~26 + structural scan ~85 + schema-context), unrecognized_alias 26, launched_child 14, ineligible_opkind 10.
- DIAGNOSIS: trust gate is a HARNESS ARTIFACT — disabling it → engaged 31/144. Production patterns carry verified identities → trusted → engage. Structural leaf scan is the next throttle. Collections excluded by the spike (effect-only gate) = the dominant real-world construct + biggest footprint win.

## Increments (update each pass)
- INC1 (in progress): trust-faithful harness + structural-scan precision → unblock non-collection patterns; drive resulting red to green.
- INC2 (planned): collections as boundaries (per-element pure render interprets; map stays a boundary) — the headline engagement + footprint unlock.
- INC3 (planned): deferred partition cases — fan-out (R-SEAM-1), bnd->bnd labeled read-through (CFC), F4 handler write-back cut edges; unrecognized_alias; launched_child where interpretable.
- DONE when: integration green + engaged ≈ all-but-rare-array-ops, flag-off 658/0.
