---
status: historical
created: 2026-09-02
archived: 2026-09-02
reason: "Investigation of the 25x slowdown the connectors debug-view suite took under cfcFlowLabels: persist, traced to the CFC write gate resolving every read's stored label for every write target and discarding the result."
---

# Where a persisted-flow-label prepare was spending its time, September 2026

## Result

The probe was one test,
`packages/connectors/agents/host/test/debug_view_pattern_test.ts`, "debug
pattern bounds raw-data links to one session page". It publishes 65 agent
sessions into a space, deploys the debug-view piece over them, and reads the
rendered result back. Measured on an Apple M5 Max, Deno 2.9.4, with the CFC
dials at the strict posture — `cfcEnforcementMode: enforce-strict`,
`cfcWriteFloor: enforce`, `cfcTriggerReadGating: true`,
`cfcPolicyEvaluation: enforce`, `cfcLabelMetadataProtection: enforce`,
`cfcDeclaredMonotonicity: observe` — and the flow dial moved between arms:

| `cfcFlowLabels` | Probe test | Whole six-test file |
| --- | ---: | ---: |
| `off` | 12 s | 40 s |
| `persist`, before | 5 m 38 s | 13 m |
| `persist`, after | 40 s | 1 m 52 s |

The `persist` before/after pair is the same machine and the same session. The
13-minute figure for the whole file before the change is the one reported with
the task rather than one measured here; every other figure was measured
directly.

## Where the time went

A V8 sampling profile of the whole test process, taken over the 6-minute
`persist` run at a 2 ms sampling period, attributed the run as follows. Self
time first:

| Self | Frame |
| ---: | --- |
| 30.4% | `deepEqual` |
| 21.4% | `checkSpecificProps` (inside `deepEqual`) |
| 10.7% | `mergeLabelValues` |
| 6.2% | garbage collector |
| 3.1% | `isObjectOrArray` (inside `deepEqual`) |

and the enclosing chain, by inclusive time:

| Inclusive | Frame |
| ---: | --- |
| 80.2% | `prepareBoundaryCommit` |
| 77.8% | `verifyInputRequirements` |
| 72.3% | `effectiveReadLabel` |
| 69.6% | `mergeLabelValues` |
| 57.0% | `uniqueCfcAtoms` |
| 55.7% | `deepEqual` |

Counters, collected on a second run of the same test with the same dials:

| Quantity | Count |
| --- | ---: |
| `prepareBoundaryCommit` calls | 1,928 |
| write targets across those calls | 4,416 |
| `verifyInputRequirements` calls | 4,416 |
| gate-visible reads summed over those calls | 4,157,262 |
| `effectiveReadLabel` calls | 6,195,377 |
| label-map entries walked by those calls | 199,514,676 |
| `uniqueCfcAtoms` calls | 52,893,430 |
| `deepEqual` comparisons inside those calls | 3,282,380,693 |

The largest label map reached 1,664 entries; the largest atom list handed to
one `uniqueCfcAtoms` call held 3,402 atoms.

## The cause

`verifyInputRequirements` builds the transaction's gate-visible read set at
the top of every call — one entry per read the transaction made, each carrying
the stored label resolved at the address it read. It is called once per write
target, so the set was rebuilt for each target of each prepare. Only a schema
entry declaring `requiredIntegrity` or `maxConfidentiality` ever consults it.

An instrumented run answered how often that happened on this workload: the set
was built 4,356 times and consulted **zero** times. No schema entry any of
these writes went through declares either requirement. The whole 4.16 million
label resolutions were computed and thrown away.

## What deferring the whole assembly broke

Making the entire assembly lazy was the first attempt, and it was wrong twice
over. The assembly does two things per read, and only one of them is an input
to the gate. `effectiveReadLabel` resolves the label, which nothing but a
protected entry consumes. `storedMetadataFor` reads the document's `["cfc"]`
envelope, and refusing an envelope this build cannot interpret is owed by any
transaction that consumed such a document, protected write target or not.

**The version refusal.** `storedMetadataFor` throws
`UnknownCfcMetadataVersionError` on a version outside the known set, which
the commit path turns into a refusal. Deferring it let a transaction that read
such a document commit. Reproduced as a pair: read a source seeded with
`version: 3`, write to a different document whose schema declares no
requirement, commit. Before, `CFC commit preparation crashed: stored CFC
metadata version 3 is not one this build interprets`. After that first
attempt, `ok`.

**The shape refusal.** `storedMetadataFor` casts its result to `CfcMetadata`
after checking only that the value is an object and that its version is
known. A `["cfc"]` value carrying a known version and no walkable label map —
no `labelMap`, no `entries`, or an entry with no `path` — therefore reaches
the label walk as a fake envelope, and the walk fails with a `TypeError`
("Cannot read properties of undefined (reading 'entries')"). That accidental
crash was doing fail-closed work. Deferring the walk removed it on the same
inputs, and the same transaction committed. This one is worse than the first,
because the gate's read set is also assembled whenever the
`cfcPrefixProvenanceStats` dial is on: with the counters off the transaction
committed and with them on it was refused, breaking the contract that
measurement changes no decision — which
`packages/runner/test/cfc-prefix-provenance-stats.test.ts` states and pins,
but only over a protected write, where the set is assembled either way.

Validating the shape turned up a third case, neither a regression nor
reachable from the gate: an entry carrying a path and no `label`, or clauses
that are not a list, committed both before and after this change. Nothing
walks it on the enforcing path — the label join reads `entry.label?` — while
`collectConsumedLabel` reads `entry.label.confidentiality` unguarded and is
reached only when an egress or a flow join asks. So the same envelope
committed quietly on one path and crashed on another. The validator covers it
because it is the same unchecked cast, one level down.

Neither defect was caught by the 172-file CFC suite.
`cfc-envelope-version-guard.test.ts` put the read and the write on the same
document, where `loadStoredCfcEnvelope` catches an unreadable envelope
independently, so the read-source arm was uncovered for both. It is covered
now, and the shape half is refused by a designed error rather than by a
`TypeError` from a cast that had gone unchecked.

The shipped fix keeps the envelope resolution eager, refuses both kinds of
uninterpretable envelope where the envelope is read, and defers only the
label walk. Resolving the envelope eagerly costs 15 seconds of the probe run;
resolving it once per document per call rather than once per read returns 11
of those.

| Arrangement | Probe test |
| --- | ---: |
| before | 5 m 38 s |
| defer the whole assembly (loses both refusals) | 36 s |
| defer the label walk, envelope per read | 51 s |
| defer the label walk, envelope per document | 40 s |
| plus the shape refusal (shipped) | 40 s |

The 2,567 label-map writes the run persists are byte-identical before and
after, compared in canonical form with the run's random identity and entity
tokens normalized by first appearance.

## Three findings the fix does not close

**The redundant-entry collapse barely fires on this path.** `6306561ee3`
(#6721) drops a `derived` or `structure` entry whose clauses the declared
component already carries. Over the probe run it ran 4,416 times on 204,019
entries and dropped 1,456 of them — 0.7%. In 2,934 of those calls the entry
set held no `declared` entry at all, so the collapse returned early. The label
maps this workload accumulates are therefore not the shape that commit
addresses, and the growth to 1,664 entries on one document stands.

**`uniqueCfcAtoms` is quadratic, and the callers above it accumulate.** The
structural deduplication compares each candidate against every atom already
kept, so one call costs the square of its input. Above it, both
`effectiveReadLabel`'s recursive join and `labelForEntriesAtPath`'s
per-component join merge one entry at a time into an accumulator, and each
merge re-deduplicates the whole accumulator — so joining N entries costs N
times the square of the result rather than the square once. That is what the
3.28 billion comparisons were. The gate no longer reaches this on an
unprotected target, but a transaction with many labeled reads and a protected
write target still does, and so does the flow-join derivation, which is
transaction-global and resolves the same labels once per prepare. Two changes
would close it: collect the parts and deduplicate once, and key the
deduplication rather than scanning it.

**The envelope refusals ride on an incidental read.** A transaction that
consumed a document with an uninterpretable envelope is refused because the
write gate happened to read that envelope while assembling a set it may never
use. Nothing states the obligation where it belongs, which is why deferring an
assembly removed it and why no test caught that. The obligation is
per-document and per-transaction; the gate re-establishes it per write target,
and `collectConsumedLabel` and `deriveFlowJoin` each re-establish it again on
their own paths.

## Method notes

The profile was taken in-process. Deno's `node:inspector` `Session` supports
`Profiler.start` / `Profiler.stop`, so a test file that starts the profiler at
module scope, imports the test module under measurement, and registers a final
test that stops it and writes the `.cpuprofile` captures a whole `deno test`
run with no external harness. Line numbers in the resulting profile are
positions in the transpiled source and do not match the TypeScript file;
function names do.
