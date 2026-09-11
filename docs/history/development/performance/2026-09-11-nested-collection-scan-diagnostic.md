---
status: historical
created: 2026-09-11
archived: 2026-09-11
reason: "E3 diagnostic acceptance and authored-pattern warning-volume inspection."
---

# Nested collection scan warning acceptance

The `collection:nested-scan` candidate was evaluated on the authored-pattern
corpus at base `b112dfdce5594bf47b7f84f5a9c2cf87a7934b96`. Its final rule reports
an inline reactive array callback scanning a collection whose root binding is
captured from outside that callback. It does not rewrite execution or fail
compilation.

## Corpus and results

The collector used by `deno task cfcheck` selected 413 pattern entries. Their
resolved module graphs contained 1,731 modules. Batched type checking,
transformation, and SES verification completed with zero errors. The compiler
pipeline's diagnostic stream was captured before the batch API discarded
warning-severity diagnostics; the normal batch result alone cannot establish
warning volume.

There were seven warning occurrences at five distinct source sites. Imported
module graphs account for the duplicate occurrences of the two factory-output
sites. Deduplication for this report removed each program's internal `fid1`
prefix and grouped by source path and position.

| Source | Observed shape | Interpretation |
| --- | --- | --- |
| `factory-outputs/lot-watch/main.tsx` | Shared people list rendered inside sighting rows | Guarded UI; actual demand determines how many lists run. |
| `factory-outputs/parking-coordinator/main.tsx` | Shared edit-vehicle rows rendered inside people rows | Guarded edit UI; a structural hint, not proof of multiplicative update work. |
| `gideon-tests/test-pattern-composition-index-based.tsx` | Every item inspected inside each category | Direct category-by-item scan example. |
| `gideon-tests/test-pattern-composition-shared-cells.tsx` | Every item inspected inside each category | Direct category-by-item scan example. |
| `nested-map-ifelse-test.tsx` | Every item inspected inside each category | Direct category-by-item scan example. |

Paths in the table are relative to `packages/patterns`. Every distinct finding
was inspected in source. The guarded UI findings are retained as non-fatal
measurement prompts. No timing or per-update complexity claim follows from the
warning alone, and the three category examples are fixtures rather than a
representative sample of production performance problems.

An initial candidate also reported a callback-local derived relationship list
in `contacts/contact-book.tsx`. That receiver did not satisfy the intended
captured-root contract. The final rule excludes callback-local declarations,
and a derived-child-list regression pins that exclusion.

## Validation and limits

The full transformer suite passed 1,171 tests and 975 steps with the final
production rule. Focused cases cover captured scans, outside const aliases,
parenthesized callbacks, child arrays, plain local arrays, sequential work,
shared work outside the callback, and callback-local derivations. A subsequent
focused case verifies that an indexed lookup's returned members do not warn.

A real `cf check <pattern> --no-run` invocation emitted the warning for
`groups.map(group => entries.filter(entry => entry.key === group.key))` and
completed successfully. Its output is displayed in the local implementation
dashboard. No live poll was accessed.

The check covers the existing inline callback array families: `map`, `filter`,
`flatMap`, `count`, `minBy`, and `maxBy`. It does not follow arbitrary helpers,
complex receivers, other loop forms, or callback-local derivations. Those
exclusions keep this first diagnostic conservative and leave false negatives;
absence of a warning is not a cost guarantee. Escalation to an error would need
separate evidence about relevance and false positives.
