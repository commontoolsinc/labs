---
status: historical
created: 2026-09-11
archived: 2026-09-11
reason: "Repository-only reactive lunch-row migration acceptance record."
---

# Reactive lunch-poll row acceptance

The C4 candidate used main `a8b081978ab98a5f1df853360d88a8232f913525`
with lunch-poll `main.tsx` blob `ac706b7fc746556e3c5d5297455a2966172910c0`. Its dependencies
were scoped list children (#7313) and bounded headless render demand (#7315).
The change removed the outer computed wrapper around the ranked option rows,
leaving direct reactive option and voter maps. Tally construction and ordering
were unchanged.

All data was synthetic. No deployed poll was read or updated.

## Acceptance

All eight lunch-poll pattern tests passed, totaling 93 assertions. The full
patterns package passed, including its browser tests, and the authoritative
pattern checker accepted all 413 patterns.

The existing A4 scale fixtures passed both assertions and their unchanged
render budgets at all three sizes:

| Votes | Voters | Options | First-render total / per-run limit | Update-render total / per-run limit |
| --- | --- | --- | --- | --- |
| 74 | 8 | 14 | 36,000 / 14,000 | 30,000 / 14,000 |
| 296 | 24 | 14 | 76,000 / 31,000 | 67,000 / 31,000 |
| 1,184 | 87 | 14 | 236,000 / 96,000 | 214,000 / 96,000 |

These are acceptance limits, not measured counts. The final 1,184-vote run took
245,335 ms in the headless harness with idempotency verification enabled. The
existing CLI action timeout was configured to 600,000 ms for these scale runs;
no read budget was raised. A preceding 60,000 ms action limit interrupted the
largest workload and produced no valid budget measurement.

A diagnostic candidate run placed the initial bounded pull, original-root
validation, and reconciler mount return within 11 ms; the expensive phase was
subsequent settlement. This is not a browser latency measurement or evidence
of constant-cost vote updates. `tallyOptions` still constructs ranked inline
objects, and row-identity reuse across every tally update is not guaranteed.

The two-browser voting test passed in 14 seconds on a matched local toolshed
and shell built from this candidate. It verified concurrent votes from Alice
and Bob, both names' swatches on both browsers, and an independent second-option
vote. An earlier candidate recording of the same scenario is available in the
local implementation dashboard. It is a functional demo, not a timing benchmark.

## Reproduction

Run the eight `packages/patterns/lunch-poll/*.test.tsx` files with `deno task cf
test`. Run each A4 fixture with the measurement action limit:

```sh
deno task cf test packages/patterns/integration/fixtures/lunch-poll-read-scale/main.test.tsx --timeout 600000
deno task cf test packages/patterns/integration/fixtures/lunch-poll-read-scale/296-votes.test.tsx --timeout 600000
deno task cf test packages/patterns/integration/fixtures/lunch-poll-read-scale/1184-votes.test.tsx --timeout 600000
```

Use a fresh synthetic store and matching client/server revisions for browser
acceptance. The recorded local pair used port offset 93 (toolshed 8093, shell
5266):

```sh
EXPERIMENTAL_SERVER_EXECUTION=false MEMORY_DIR=file:///tmp/reactive-lunch-acceptance-memory ./scripts/start-local-dev.sh --port-offset 93
HEADLESS=true API_URL=http://localhost:8093/ FRONTEND_URL=http://localhost:5266/ EXPERIMENTAL_SERVER_EXECUTION=false deno test -A packages/patterns/integration/lunch-poll-vote.test.ts
```

A run against toolshed revision `8f271a72ac` quarantined result documents for
missing schema references before rendering the poll. That server predates the
content-addressed result-schema metadata change in #7299. The matched pair
passed; this record makes no mixed-version compatibility claim.
