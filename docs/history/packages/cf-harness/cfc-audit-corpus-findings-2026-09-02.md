---
status: historical
created: 2026-09-02
archived: 2026-09-02
reason: "First run of the CFC audit checker over the accumulated cf-harness session corpus (CT-2178, phase 1)."
---

# What the CFC audit found in the session corpus

The spec-anchored CFC audit checker landed in `packages/cf-harness/audit` on
2026-09-02 with a fixture corpus of two runs. This is what it said the first
time it was pointed at real sessions: 239 runs of accumulated cf-harness
console artifacts, nine checks each, 2151 check results, about 0.9 seconds of
wall clock.

The headline is that no check found a CFC **violation**. Every non-passing
result in the corpus is one of two other things, and telling those two apart
from a violation is the whole content of this report:

- a **violation** — a run whose own evidence contradicts a clause. The corpus
  holds none.
- a **legibility gap** — a run that may well have behaved correctly, but did
  not record enough for a check to tell. AUD-2's 121 warns and AUD-8's blanket
  not-applicable are this.
- **artifact-set evolution** — a check that asks for an artifact the runs
  predate, so the answer was fixed before the run started. AUD-9's 239 failures
  are almost entirely this.

The one finding that is neither is AUD-6's four failures: four transcripts
abandoned mid-tool. That is a real defect in four artifact trees, and it is not
a CFC defect.

## What was measured, and with what

Checker at merge SHA `58dde5398`
("CFC audit: a spec-anchored checker over session artifacts", #6749), Deno
2.9.4, run from `packages/cf-harness`:

```bash
C=/Users/ben/.bb/worktrees/env_7qpzey268d/labs/packages/cf-harness/.cf-harness-console
deno task cfc-audit \
  /Users/ben/.bb/worktrees/env_j49cb9z7jg/labs/packages/cf-harness/.cf-harness-console/runs \
  /Users/ben/.bb/worktrees/env_m69fg39nps/labs/packages/cf-harness/.cf-harness-console/runs \
  "$C/runs" "$C/v0-runs" "$C/v0new-runs" "$C/voided-8000-runs" \
  --json > corpus.json
```

The audit reads. It opens no run for writing and creates nothing inside an
artifact tree, so the corpus is unchanged by having been measured.

**The population, stated plainly.** The three corpus roots are local bb
worktrees on one machine. These numbers reproduce only where those trees
exist; nothing here is a fixture anyone else can re-run. Two of the three trees
are measurement corpora — the terra-vs-sol comparison and the night-5 rounds —
so the population is authoring-loop runs, not a representative product
workload. A number below says what the authoring loop did, not what a user's
session does.

Two counts appear throughout. 239 runs is every run the discovery walk found,
including archived generations; 207 runs is the current generations alone
(`runs/` without `v0-runs`, `v0new-runs`, and `voided-8000-runs`). The two
agree on every conclusion, which is the point of reporting both.

## The 239-run table

| Check                           | pass | warn | fail | inconclusive | n/a |
| ------------------------------- | ---: | ---: | ---: | -----------: | --: |
| AUD-1 posture consistency       |  234 |    – |    – |            5 |   – |
| AUD-2 mode-behavior attestation |  113 |  121 |    – |            5 |   – |
| AUD-3 decision coverage         |  234 |    – |    – |            5 |   – |
| AUD-4 denial channel            |  106 |    – |    – |            – | 133 |
| AUD-5 handle discipline         |  180 |    – |    – |            – |  59 |
| AUD-6 transcript pairing        |  235 |    – |    4 |            – |   – |
| AUD-7 observe disclosure        |  239 |    – |    – |            – |   – |
| AUD-8 influence accumulation    |    – |    – |    – |            – | 239 |
| AUD-9 evidence retention        |    – |    – |  239 |            – |   – |

The 207-run subset says the same thing at the same proportions: AUD-1 204 pass
and 3 inconclusive; AUD-2 106 pass, 98 warn, 3 inconclusive; AUD-3 204 and 3;
AUD-4 99 pass and 108 not-applicable; AUD-5 150 and 57; AUD-6 204 pass and 3
fail; AUD-7 207 pass; AUD-8 207 not-applicable; AUD-9 207 fail.

The verdict vocabulary carries the distinction this report rests on.
`inconclusive` is the verdict for a check whose evidence was absent, and it is
never `pass`. `not-applicable` is narrower and stronger: the evidence was
present and said the check's subject did not arise. `warn` is evidence
consistent with the clause where the run's own posture weakens the assurance.

## AUD-9, 239 fail — artifact-set evolution

AUD-9 rests on AH-CFC-16: the artifact boundary must retain evidence
"sufficient to explain why a tool result was exposed or denied". It asks an
enforcing run for five things: its policy trace, its policy snapshot, that
snapshot's digest, an invocation context if it executed any side effect, and
any recorded attempt to read its space's cell labels.

Every run in the corpus is missing at least the last one:

- 121 runs missing both a CFC invocation context and a cell-labels read.
- 113 runs missing only the cell-labels read.
- 5 runs missing `policy-trace.json` and the snapshot digest as well.

No run in the corpus ever recorded a cell-labels read, because that artifact
postdates these trees. The check is asking runs for something they had no way
to write. That is what a 239/239 failure with no variance looks like, and
reading it as 239 defects would be reading the artifact set's own history as
misconduct.

It is still worth saying that under AH-CFC-16 the retention gap is real for
these runs regardless of cause. Whatever explains it, nobody can now go to one
of these 239 artifact trees and establish from it why a result was exposed or
denied. The clause is about what the boundary retains, and it did not retain
this.

The 121 runs missing an invocation context as well are AUD-2's warns under the
same predicate, seen from the retention side rather than the attestation
side.

## AUD-2, 121 warn — a legibility gap, and a receipt

These are runs claiming an enforcing mode that never exercised the claim.
Their completed side effects were `delegate_task`, `assign_slug`, and
`run_pattern` — none of which reach the substrate that carries CFC evidence —
so the run executed effects, recorded no invocation context, and nothing in it
tested the posture it declared. The check's own words: "reduced assurance:
this run claims `<mode>` and never exercised it".

Two things about how the check reaches that verdict matter for reading the
number.

First, it does not consult a maintained list of which tools reach the
substrate. It derives that from each run's own evidence: a tool the run
recorded a context for is a tool whose invocations carry CFC evidence, and a
later call to the same tool carrying none is a `fail`, not a `warn` — evidence
gone missing rather than a tool that never had any. The 121 warns are the other
shape: no context anywhere in the run, so no tool in it is known to transport,
and the check declines to convict on a list it would have had to maintain
itself.

Second, that makes the 121 independent corroboration, from recorded evidence,
of what CT-2175 says on other grounds: release gating has never fired. The
warns are the receipt. The other 113 runs passed — their substrate invocations
carried invocation contexts, or they executed no side effect at all — so the
machinery is not inert; it is that roughly half the corpus never reached it.

## AUD-6, 4 fail — abandoned transcripts

Four runs carry `unresolved_tool_calls` — a turn abandoned mid-tool, leaving a
tool call with no matching result:

- `7e8e69ca…subagent.1`
- `e7ac6ff2…`
- `ee0e17ea…`
- `e6c3dd0d…`

AUD-6 cites AH-CFC-16 and AH-LIFE-6 and reports the longest resumable prefix
alongside each defect, so each of these four is a transcript that can be
resumed up to a boundary rather than one that is lost. This is the corpus's
only class of finding that is a defect in the runs themselves. It is a
lifecycle defect, not a CFC one: nothing here says a label was ignored or an
authority was exceeded.

## The 15 inconclusive results — one missing file

All 15 share one cause: `run-report.json` absent, in 5 runs, across AUD-1,
AUD-2 and AUD-3. Each of those three checks names the run report as evidence it
needs, so each returns `inconclusive` rather than reading the mode off whatever
else happened to load.

That is the design working. `inconclusive` is deliberately never `pass`: a
check that fell back to a second artifact when the first was missing would be
attesting a claim by knowing less about it. The same 5 runs are the ones AUD-9
reports as missing `policy-trace.json` and the snapshot digest — one damaged
group of trees, showing up in four checks.

## AUD-8, 239 not-applicable — nothing to read

AUD-8 tests AH-CFC-7 and AH-CFC-8: labels on observations exposed to the model
must accumulate as influence, and opaque or denied observations must not. It
reads a `cfc` disposition block off each tool result and joins it to the run's
model-context observations.

No historic tool result carries such a block, so the rule had nothing to read
and returned `not-applicable` on every run in the corpus. Only the checker's
own fixture exercises it. This is a legibility gap, not a violation — the
runtime may have accumulated influence exactly as the clause requires, and the
artifacts do not say either way.

## AUD-4 and AUD-5 — what the not-applicables mean

These two are the corpus's other silences, and they are the strong kind:
evidence present, subject absent.

AUD-4 (denial channel, AH-CFC-6 and AH-CFC-11) is not-applicable on 133 runs
because those runs denied nothing. On the 106 runs that did deny something, it
passed: the denial was recorded as a policy event and reached the model through
the typed channel, carrying none of the withheld observation's payload.

AUD-5 (handle discipline, AH-CFC-18, AH-CFC-19, AH-CFC-12 and AH-CFC-13) is
not-applicable on 59 runs that minted no handle and whose transcripts carry
none. The 180 runs with handles passed: no table the validator refuses, no
token the model wrote before the harness disclosed it, and no parent token in a
child transcript that no delegation named.

AUD-7 (observe disclosure) passing 239/239 is the same kind of quiet result
from the other direction: no run in the corpus recorded a dial at `observe`, so
none of them is a reduced-assurance deviation under AH-CFC-15.

## What this bears on

Three pieces of open work the evidence speaks to. No recommendations beyond
these.

- **CT-2175 — release gating has never fired.** AUD-2's 121 warns are the
  receipt, derived from recorded evidence rather than from reading the code.
- **CT-2076/E3 — the artifact ↔ space-DB split.** It is why AUD-9 cannot pass:
  the evidence the clause asks the artifact boundary to retain partly lives on
  the other side of that split, and no amount of care in a run's own directory
  closes it.
- **CT-2178 phase 3 — the property suite.** It is intended to manufacture runs
  that reach the substrate, and the first label-driven refusals this corpus
  holds. That is what would turn AUD-2's warn from the corpus norm into an
  anomaly, and what would give phase 2's corpus-level refusal-liveness check
  something other than zero to count. It is also what would first give AUD-8,
  and AUD-4's 133 silent runs, something to read.
