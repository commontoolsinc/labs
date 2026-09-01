---
status: historical
created: 2026-09-01
archived: 2026-09-01
reason: "Executed Round-4 measurement of the console parent prompt, the structured delegation channel, the child composition bullets, skill acquisition, and the demo completion contract."
---

# Round 4: the parent prompt, the structural channel, and what each buys

This record covers the 2026-09-01 measurement. It re-baselined the console
against a system that had changed underneath the 2026-08-31 numbers —
`patternRefs`, honest tool descriptions, the Sol default, the skills pipeline,
and the turn-completion contract had all landed — and decided three ships: the
console's default parent prompt, the child's composition bullets, and whether
the structural delegation channel pays.

Every cell ran `gpt-5.6-sol` against a fabric server at
`ce372de43f9b244fadb5186ca8be30100fe6f1a0`, read as an ancestor of
`origin/main`, under `enforce-explicit` CFC. The deployed index held 29
discoverable entries before and after every counted cell.

The pre-registration, the two parent prompts under test, and the append-only
analysis ledger every number below was drawn from are committed beside this
record at
`packages/cf-harness/.cf-harness-console/measurements/2026-09-02-round4/`. The
ledger carries the per-cell flag checks, the counts and their provenance, the
operator rulings as they were made, and the corrections — including one
browser verdict that was recorded as a failure before being retested.

The raw artifacts behind it are not committed: that tree is otherwise
git-ignored, so the per-cell batch reports and every run transcript remain on
the machine that produced them, under
`packages/cf-harness/.cf-harness-console*/` in the worktree
`/Users/ben/.bb/worktrees/env_m69fg39nps/labs` — one console directory per
condition, plus `.cf-harness-skill-cli` and `.cf-harness-skill-cli2` for the
command-line skill attempts.

## What each finding changes

### The console default should be the candidate prompt

Three parent conditions ran both committed suites. The candidate prompt — a
decision policy that distinguishes a whole answer from a part — wins on every
behavioral axis and on cost.

| Reuse suite, six tasks | no prompt | historic | candidate |
| --- | ---: | ---: | ---: |
| `run_pattern` | 27 | 16 | **6** |
| by id / from source | 6 / 21 | 3 / 13 | **6 / 0** |
| **whole applications wrapped** | 0 | **4** | **0** |
| compile errors | 16 | 6 | **0** |
| delegations | 5 | 8 | **0** |
| wall clock | 2113s | 880s | **149s** |

| Composition suite, four tasks | no prompt | historic | candidate |
| --- | ---: | ---: | ---: |
| parents that searched | 0 of 4 | 4 of 4 | 4 of 4 |
| tasks composing | 1 of 4 | 4 of 4 | 4 of 4 |
| composing calls | 2 | 18 | 26 |
| `run_pattern` | 39 | 47 | 27 |
| compile errors | 25 | 25 | 21 |
| plain errors | 7 | 10 | **0** |
| delegations | 5 | 12 | 5 |

The historic prompt's blanket instruction to import what you find is what
manufactured whole-application wrapping. On the reuse suite it wrapped four
finished applications in new source — a reading tracker, a notes dashboard, a
trip itinerary, an expense tracker — the same four entries the candidate
prompt ran by id. Replacing the blanket instruction with a decision policy
removed the wrapping without costing the composition lift, which stayed at
four of four tasks.

One qualification belongs beside that. The candidate prompt's compile-error
rate *per attempt* is higher: 21 of 27 attempts against the historic prompt's
25 of 47. It makes far fewer attempts and a larger fraction of them fail to
compile. Its total cost is lower on every measure, and nothing here shows it
authoring more compilable source.

### The structural channel removes one error class, not compile cost

The delegation boundary now carries selected search hits as structured
`patternRefs` rather than as retyped prose. What that buys is specific.

The strongest evidence is a control the round did not design. The historic
prompt attached refs to some delegations and not others, splitting its own
composition cell into two arms with prompt, suite, model and corpus held
fixed:

| Arm | children | `run_pattern` | ok | compile-error | error | of which argument-schema |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| received refs | 7 | 18 | 7 | 11 | **0** | **0** |
| received none | 5 | 29 | 5 | 14 | **10** | **8** |

Eight of the ten plain `error` outcomes in that cell are argument-schema
mismatches — a child wiring a value into an imported pattern's input whose
shape it was guessing. Every one occurred in a child that had not been given
the shapes. Children that received them made none, across 45 composing
attempts in two cells.

The channel is lossless where it is used. Across the two cells that used it,
every attached entry delivered its exact description, import hint, argument
shape and result shape into the child's received text. Against the
2026-08-31 census of the same boundary — 24 delegations, 22 naming a prior hit
in prose, one carrying an exact argument shape, **none** carrying a result
shape — the flip is complete: the shape that never once crossed in prose now
crosses on every entry, and no delegation in any Round-4 cell named a prior
hit in prose at all.

### The channel is discovered without being taught

The pre-registration predicted the historic prompt would compose "through
prose handoff" with "refs unused". **Both halves are falsified.** The historic
prompt never mentions `patternRefs`; its parents used the field in 7 of 12
composition delegations and 7 of 8 reuse delegations, having found it in the
`delegate_task` schema. Its prose handoff, which the 2026-08-31 audit measured
at 22 of 24 delegations retyping an id, had vanished entirely.

The three conditions form a series:

| Condition | parents that searched | delegations | carrying refs |
| --- | ---: | ---: | ---: |
| no prompt | 2 of 10 | 10 | **0** |
| historic | 10 of 10 | 20 | **14** |
| candidate | 10 of 10 | 5 | **5** |

Under no prompt the parent never searches, so a ref is structurally impossible
— refs rehydrate only from that parent's own prior search records. Under the
historic prompt the parent searches and finds the field unaided. So the
candidate prompt's unique contribution is not unlocking the channel. It is the
decision policy: same channel usage, opposite handling of whole answers.

### The child composition bullets are load-bearing. Keep them.

Block 2 withheld the four child bullets under the candidate prompt, leaving
everything else identical. The parent behaved identically — it searched, chose
parts, attached them with notes, and the harness delivered the block to every
child. What changed is what the child did with the material.

| Measure | bullets present | bullets withheld |
| --- | ---: | ---: |
| tasks composing | 4 of 4 | 3 of 4 |
| composing share of attempts | 96% (26/27) | **37% (13/35)** |
| compile errors per composing task | 5.25 | 8.00 |
| `run_pattern` per composing task | 6.75 | 11.67 |
| wall clock | 2383s | 3059s |

The clearest case is `team-picker`: its child received three refs — dice
roller, counter, check-list — with kind, quality, description, import hint and
both shapes for all three, then wrote seven patterns from source and composed
none of them. With the bullets present the same task composed on six of six
attempts.

The two surfaces divide cleanly, and the round establishes each half. The
generated refs block presents material and mandates nothing, by design. The
four bullets supply the instruction that a hit is a component to wire. Without
the parent's attachment, a child that composes guesses shapes and produces
argument-schema mismatches. Without the child's bullets, a child holding
correct shapes largely does not compose. **Neither substitutes for the other.**

The audit's hypothesis that the bullets are dead weight once the parent decides
is wrong: the parent deciding is necessary and not sufficient.

### The cost of a session is superlinear in failed attempts, not in thrash

The sessions are slow, and the reason is not that they fight themselves.
Consecutive `run_pattern` failures were classified by their compiler
diagnostics with identifiers and line numbers normalized away. Across the
three cells read for this, 71 failures produced 3 identical-class and 3
overlapping-class consecutive pairs against 48 that moved to a new diagnostic;
the longest same-class streak anywhere is 2. Children move through a long tail
of distinct type errors rather than looping.

`modelAttempts[].durationMs` measures time to the provider's response start on
a streaming call, not generation, and understates model time roughly tenfold.
Measured instead as the gaps between tool calls, children spend **96-98% of
wall clock in model turns** and 2-4% in tool execution.

Pairing every model turn with the number of failures that preceded it:

| prior failures | 0 | 1 | 2 | 3 | 4 | 5 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| mean turn cost | 13.9s | 48.3s | 46.5s | 47.1s | 67.3s | 76.3s |

A turn before the first failure costs 13.9 seconds; a turn after any failure
costs 55.5 seconds on average, and the cost keeps climbing as failures
accumulate. Each failed attempt appends a large diagnostic, often with source
excerpts, and every later turn re-reads all of them.

So the price of a task is superlinear in how many attempts it takes
(CT-2158). Anything that reduces attempts attacks the cost directly; anything
that makes each attempt smarter without reducing their number does not. The
cheapest cell of the round is the one where no failed attempt ever entered a
context: six reuse tasks answered by id in 149 seconds.

The pre-stated hypothesis for this section — that the observation-denial
posture starves children of reference surfaces and so produces repeated-error
loops — **is not supported**. Denied calls return in under a second and
cluster before the first `run_pattern` rather than between failures; children
ask for documentation once, are refused, and do not ask again. Whether that
refusal raises the *initial* error rate is a real question this round cannot
answer: it needs a cell where the reads succeed, and none exists.

### The turn-completion contract held

Five demo phrases ran through `POST /api/task`. For each completed turn, every
successful `assign_slug` recorded anywhere in the run's artifacts also appears
in the turn result derived from those artifacts, one piece per turn. **The
pre-registered falsifier — a completed turn whose piece exists in artifacts
but is absent from `result.pieces` — did not fire.**

This was checked by re-deriving each result from the same inputs
`console/turn-result.ts` reads, not by capturing the served HTTP response; no
response payloads were saved. The check is faithful to the function's inputs
and is not an observation of the endpoint.

## The pre-registered predictions, judged

| Prediction | Verdict |
| --- | --- |
| No prompt: composition ~0, replicating | **Held in direction, not as replication.** 2 composing calls across 1 of 4 tasks, against 0 in the 2026-08-31 control. Not zero. |
| No prompt: `patternRefs` unused or nearly | **Held**, but for a weaker reason than assumed: with no parent search, a ref is structurally impossible, so the ">2 uses would be a surprise" threshold was unreachable. |
| Historic: composes, replicating V2 | **Held.** 4 of 4 tasks, 18 composing calls against V2's 17. |
| Historic: through prose handoff | **Falsified.** No delegation named a prior hit in prose. |
| Historic: refs unused | **Falsified.** 7 of 12 composition and 7 of 8 reuse delegations carried refs. |
| Historic: compile burn 9-22 per composing cell | Marginally outside, at 25. |
| Candidate: composes at ≥ historic rate | **Held.** 4 of 4 against 4 of 4, with 26 composing calls against 18. |
| Candidate: ≥ half of composing delegations carry refs | **Held**, at 5 of 5. |
| Candidate: over-fire drops | **Held decisively.** Four whole-application wraps to none. |
| Candidate: compile burn per composing task drops ≥ 30% | **Falsified**, at 16.0%. |
| V1: no significant difference with bullets withheld | **Falsified**; the falsifier's own remedy applies and the bullets stay. |
| Block 3: pipeline exercised end to end | **Not met in any cell.** |
| Block 4: a piece in artifacts absent from `result.pieces` | **Did not fire.** |

The burn conjunct deserves its arithmetic in full, because the reading matters.
The pre-registration calibrates "compile burn" against "2026-08-31 V2 (9-22 per
composing cell)", and 9 and 22 are the compile-error counts of those cells, so
the metric is compile errors divided by composing tasks. Both Round-4 cells
composed on four of four tasks:

| Reading | historic per task | candidate per task | drop |
| --- | ---: | ---: | ---: |
| compile errors **(pre-registered)** | 6.25 | 5.25 | **16.0%** |
| all failed attempts | 8.75 | 5.25 | 40.0% |
| all attempts | 11.75 | 6.75 | 42.6% |

The gap between the first row and the others is the plain `error` class, which
the candidate prompt eliminated entirely. The honest statement is that the
structural channel removed a whole error class and did not materially reduce
compile errors; the pre-registered metric measured only the half it did not
move. Since the falsifier list names "burn not dropping", the candidate
prediction **as a conjunction is falsified**, with three of its four parts
held and the failure in the cost claim rather than the behavior claim.

## Skill acquisition: reachable and unexercised

Block 3 asked whether a task worded without any mention of skills would drive
the session to search the registry, acquire a skill, delegate with its handle,
and produce a pattern. Three cells:

| Cell | surface | `search_skills` offered | `acquire_skill` offered | searched | acquired |
| --- | --- | --- | --- | --- | --- |
| console | console | yes | **no** | no | could not |
| CLI, no `pattern-author` | CLI | yes | yes | **yes, once** | no |
| CLI, full authority | CLI | yes | yes | **no** | no |

`consoleChatPolicy` extends the console's allowed tools with `search_skills`
alone; `acquire_skill` is never offered to a console session, however the
registry is configured (CT-2160). The console cell's parent carried 13 tools
against 12 in every other console cell — one added tool, not two — and the
CLI's `policy-snapshot.json` records both tools present with
`allowedProfiles: ["default", "pattern-author"]`. So the machinery is
reachable, and in the cell where everything was available it went unused by
choice.

The one registry search this round produced is the telling case. It happened
only after `delegate_task(pattern-author)` was denied and a look at the local
skills tree was refused, and what it asked for was `Common Fabric pattern
author TypeScript JSX` — authoring help to replace a lost capability, not
content for the user's request. Restore that authority and the registry is
never touched. Registry search appeared as gap-recovery behavior, not as
task-solving behavior.

**The conclusion is about elicitation, not machinery.** A task that never
mentions skills — which is the wording rule the measurement protocol imposes,
and rightly — does not elicit acquisition from this model against this corpus.
Exercising the pipeline needs either a task whose gap the model reads as
skill-shaped, or explicit guidance naming the registry.

What therefore remains untested, and is recorded as untested rather than as
working: the whitelist accept and refuse-with-reason paths, the
`ExternalIngest` stamp on a created skill cell, `skillHandle` custody, and the
child-return scrub against injected skill text.

## Demo preparation: the gap list

Five phrases, each browser-verified by the operator against the shell dev
server. The pieces' recorded URLs 404 against the toolshed directly because
that toolshed runs without `SHELL_URL`; that is an operations detail of the
measurement rig, not a defect in any piece.

The cell built all five from scratch: 28 `run_pattern` calls, **zero
composing**, 23 compile errors, 5 `ok`.

1. **poll — passes clean.** A fresh load shows an empty name field with every
   Vote button disabled; typing a name only enables them and casts nothing;
   clicking Vote Tacos records exactly one vote, giving a total of two and a
   "tie: Pizza & Tacos" label, and the state persists across reload. One of
   the two must-pass phrases.
2. **rsvp — passes clean.** Name, radio and dietary note submit correctly,
   tallies update live, the entry lists with its note and a Remove control.
   The other must-pass phrase. **Both must-pass phrases pass.**
3. **emails — expected partial, and an honest stop.** The piece renders a
   Gmail-labelled inbox frame with an explicit "Unable to load your inbox.
   Check the Gmail connection" alert. It needs a connected Gmail source in the
   space. No fabricated placeholder data — the right failure shape.
4. **research — passes, above prediction.** The pre-registration expected this
   to stop for want of web search. Instead the parent delegated to a
   `web_search` subagent and the piece carries three real products with real
   source URLs, a working budget filter, a decision rule and an at-a-glance
   table. The predicted gap did not materialize.
5. **budget — partial, with a defect.** It renders six seeded transactions
   with a category breakdown and CSV import, and its reactivity is real: an
   added transaction updated the count and added a category chip immediately.
   But the new row's amount holds no committed value, so "Remaining" renders
   `$NaN.undefined` and persists after blur while "Total spent" excludes the
   row. An undefined amount should coerce to zero. The known gaps stand: no
   Plaid data, seeded sample instead, and CSV import as the only ingest.

One artifact detail belongs with the budget defect. Its parent did search,
did find hits, and did attach two refs — an amount-ledger part that sums
labeled amounts in integer cents, and a sortable-table part — with both shapes
delivered in full to the child. The child composed neither and hand-rolled the
money arithmetic that the attached part exists to do, and the defect is in
that rebuilt arithmetic. This is the Block-2 phenomenon appearing in Block 4:
material delivered, instruction present, and the child still authoring from
scratch.

## Priority-fix evidence gathered on the way

- **Observation denial is the standing posture of this machine, not a
  condition of any cell.** `bash` is denied throughout with "bash output did
  not include trusted CFC mediation metadata", and `read_file` fails with
  "filesystem status not observable under CFC policy". The CLI names the cause
  actionably where the console does not: "refusing to start a container under
  cfc enforcement mode 'enforce-explicit': the 'runsc-cfc' docker runtime is
  not registered with `--cfc-invocation-context-dir=<path>`, so this
  invocation's CFC input labels would be written and never read". A
  per-invocation registration mismatch, not a missing sidecar, and the
  actionable form of the observation-denial evidence CT-2122 collects.
- **Whether a ref's shapes reach the child depends on search rank**
  (CT-2159). The endpoint returns argument and result shapes only for its
  leading hits, and the harness rehydrates the most recent record it holds for
  an id. One observed delegation attached an entry last seen at rank 10 and
  its child received `Argument shape: Not available.` and `Result shape: Not
  available.`. The task composed it anyway, so it cost nothing here.
- **Two plain-`error` classes are worth separating** in any future accounting:
  argument-schema mismatches, which the structural channel eliminates, and
  runtime settle failures, whose message is withheld under CFC because a
  computation's thrown text can carry the data it read.

## Incidents, and invalid work retained

- **Concurrent consoles corrupted a shared store.** Three consoles launched
  against one `CF_HARNESS_CONSOLE_DIR` shared a session store and artifact
  root. One returned 500s on `chat_event.sequence` UNIQUE collisions and
  completed no task; another reached one task before being stopped; and the
  batch already running on that store had a task fail with
  `UNIQUE constraint failed: chat_event.sequence`. That whole attempt was
  ruled void and re-run on an isolated store (CT-2156). Two run directories in
  the shared root are its only durable trace and are counted nowhere.
- **The console cannot exercise skill acquisition** (CT-2160).
  `acquire_skill` is absent from `consoleChatPolicy`, so the pre-registered
  Block-3 pipeline was not runnable on the surface the pre-registration
  assumed.
- **One CLI attempt is void for parity.** Its invocation omitted
  `--allow-subagent-profile`, so `delegate_task(pattern-author)` was denied and
  the parent fell back to a generic subagent. It still produced a working
  piece, and its artifacts are the source of the registry-search observation
  above. It is retained and counted nowhere.
- **The CLI help omits `pattern-author`** from the
  `--allow-subagent-profile` enumeration while accepting it, which is what
  produced that void attempt.
- **One Block-2 cell ran without its own sacrificial probe.** The endpoint
  correctly refused an unsigned request, and substrate evidence was inherited
  from a batch completing minutes earlier on the same substrate. Nothing in
  its artifacts suggests a substrate fault, and it is counted with the
  deviation recorded.
- **The registry namespace collides.** A "Common Fabric" query returns three
  unrelated `fabric` skills, and this repository's own `lit-component` skill
  is published to that registry with 65 installs.
- **One browser verdict was contaminated by operator input and corrected.**
  The poll phrase was first recorded as failing, on an observation that typing
  a name instantly cast a vote. The operator had most likely clicked Vote
  himself as the headed browser window appeared. A retest from a fresh load
  showed the piece behaving correctly, and the verdict is the corrected one
  above. The screenshot taken at the time documents the contaminated
  observation rather than a piece behavior.

  The method fact is worth more than the corrected number. **Browser
  verification on a headed browser a human is also using is vulnerable to
  stray input, and a stray click is indistinguishable in the screenshot from
  the behavior under test.** The failure is silent and yields a confident
  wrong finding; this one was written into the measurement ledger as the
  round's headline product gap before it was caught. Retesting a failure from
  a fresh load is what caught it; driving verification through a browser
  instance no human shares is what would prevent it. The other four Block-4
  verdicts were not retested under that discipline and carry the same exposure
  at unknown probability, though only the poll showed a behavior a stray click
  could plausibly manufacture.

## What remains unestablished

`ok` still means a pattern compiled and matched its schema, not that its UI
works. Block 4 is the only part of this round with browser verification, and
it found a piece rendering `$NaN.undefined` for a committed total whose
`run_pattern` outcome was `ok`. Every composition and reuse number in this
record carries that limitation.

The reuse suite's six-for-six by-id result rests on descriptions written by the
runs that published those entries in earlier batches. The admissibility
cross-check confirms the parent picked an entry that claims to answer the task;
it cannot confirm the entry does.

No console commit is recorded in any artifact. Every report carries the fabric
server's `gitSha` and its ancestry, and nothing records the commit the console
itself was built from, so two batches could differ in the code under
measurement with no artifact saying so.

The index pre-flight no longer exercises retrieval: its query is the literal
string `pattern`, which answered zero results against a 105-entry corpus, and
an answer of no results is a pass by design.

No terra cells ran, no index or service changes were made, and the corpus
remained at 29 discoverable entries throughout — every publication in this
round was recorded-only, so nothing a run built became visible to a later
search.
