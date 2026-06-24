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
- INC1b (DONE — partition correctness pass): the prior passes engaged the interpreter on most handler-bearing patterns, turning the suite red WITH partitions (66/147 failing). Drove back to GREEN by fixing partition/emission bugs, NOT by widening fallback. Result: **integration 147/0 under the flag, engagement 105/144** (vs 5/144 baseline, 31/144 trust-gate-off), flag-off runner 658/0. Bugs fixed:
  1. **topoOrder ignored `internal`-alias deps** (`interpret.ts`). The ROG topo sort only followed `opOut` refs; two leaves both reading the same upstream op via a NAMED internal alias (e.g. `str` interpolating `${branchKind}` and `${branchVariant}`, each a computed materialized under an internal cell) were ordered by declared appearance only. A consumer placed before its sibling producer resolved the producer to `undefined` (`counter-conditional-ifelse`: `disabled (undefined)`). Fix: thread `internalToOp` into `topoOrder`, resolve `internal`→producer when that producer is in the op set (seeded externals stay out of the order). Recovered 26 scenarios (66→40 failing).
  2. **producer-less internal cells were never seeded** (`interpret.ts` + `runner.ts`). A segment reading a `cell(…)` written ONLY by a handler boundary (handler writes via `$ctx`, EMPTY `outputs`, so the F4 output-name gate never sees it) or a bare `derivedInternalCells` default got `undefined` — and a downstream lift reading `undefined` is run-gated out, yielding `undefined` not the lift's default (`counterNoOpEvents.updateCount`: undefined vs 0). Fix: `EvalContext.seedByName` (op-id seed can't key a producer-less cell) + dispatch wires each such cell as a `$in[name]` alias carrying its schema (so an untouched `cell(0)` surfaces its default) seeded by name. Recovered ~27 scenarios (40→20 failing), but introduced a follow-on bug (#3).
  3. **`$generated` partialCause aliased by the normalized string key** (`runner.ts`). `outputInternalName` normalizes a `{$generated:N}` partialCause to the string `"$generated:N"` (used as the ROG `internal` name / map key). The fix-#2 alias used that string as the alias `partialCause`, which the binding layer rejects with `Unknown derived internal cell with partial cause "$generated:0"` (`nested-counters`, `list-manager`, `counter-dynamic-step`, …). Fix: keep the ORIGINAL `partialCause` payload (string OR `{$generated:N}` object) in `internalCellAliasByName` and alias by that, never the normalized key. Drove the suite to 147/0.
- No shapes had to be gated/retreated — every failure was a real partition-wiring bug with an in-scope fix. The three fixes only ADD correct seeding/ordering; they never return null/bumpAndThrow, so engagement is monotonic (cannot fall vs the start of the phase).
- INC2 (planned): collections as boundaries (per-element pure render interprets; map stays a boundary) — the headline engagement + footprint unlock. (Remaining non-engaged 39 ≈ `ineligible_opkind` 14 [collections] + `launched_child` 14 + `unrecognized_alias` 26 + `unresolved_leaf` 16.)
- INC3 (planned): deferred partition cases — fan-out (R-SEAM-1), bnd->bnd labeled read-through (CFC), F4 handler write-back cut edges; unrecognized_alias; launched_child where interpretable.
- DONE when: integration green + engaged ≈ all-but-rare-array-ops, flag-off 658/0.
