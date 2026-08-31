---
status: historical
created: 2026-08-29
archived: 2026-08-29
reason: "Record of the experiment that moved pattern-index composition off zero (CT-2066)."
---

# What moves the incentive to compose

An overnight experiment, 2026-08-28 into 2026-08-29, against the deployed
pattern index, fabric `:8060` at `7baa03f462`, model `gpt-5.6-terra`, space
`pattern-index-demo`. Every batch ran one task per fresh session, one session at
a time, with the index read before and after.

The subject was one finding that had survived two phases: **composition is
`can`, not `will`.** With a working, parameterized atom ranked first and its
`import` line attached to the search result, a fresh session rebuilds it.
Instructed explicitly to import it, the same session does it first time.

## The result

The experiment result below compares 26 `run_pattern` calls in the four-session
`V0-new` control with 30 calls in the four-session `V2` batch. Composition moved
from a measured zero to **three distinct tasks wiring five distinct atoms, all
three reaching `ok`**.

| | control (`V0-new`) | `V2` |
|---|---|---|
| searches | 6 | 22 |
| of those, issued by the **parent** | 0 | 12 |
| `run_pattern` from source | 26 | 26 |
| **composing calls** | **0** | **15** |
| distinct atoms composed | 0 | 5 |
| **distinct tasks composing** | **0** | **3** |
| outcomes | 21 error / 5 ok | 17 error / 13 ok |

Per task, in `V2`:

| task | composing calls | atoms wired | ran |
|---|---|---|---|
| `book-club-vote` | 0 | — | — |
| `restaurant-spend` | 5 | amount-ledger + option-picker | yes |
| `chores-sort` | 3 | sortable-table + check-list | yes |
| `favour-picker` | 7 | check-list + a whole team-picker application | yes |

The bar was set before the run and is not the call count: **two or more
distinct tasks importing distinct atoms.** One session composing one atom three
times is a session in a loop. Three sessions, five atoms, three programs that
ran clears it.

### What changed, and what did not

`V2` gave the console's **parent** session a system prompt telling it to search
the index before delegating and to name a `patternId` in the delegation when a
hit answers part of the task, and simultaneously **withheld** from the
`pattern-author` child the four bullets that tell it to compose. The words moved
rather than accumulated.

Unchanged: the child's three search-technique bullets, its three publishing
bullets, the tool surface, the publish path, the render gate, the index's data
model and ranking.

### Why this is causal and not just correlated

The parent issued **12 searches across four tasks, having issued none in the
control** — `vote poll selectable options`, `sort table column duration`,
`toggle item done checklist chores`. Verbs rather than nouns, which is what the
prompt asked for, followed by a delegation carrying what it found. The
intervention's mechanism is visible in the transcripts rather than inferred from
an outcome difference.

### What this does not establish

1. **A task-set confound, declared before the run.** The control ran task set A
   and `V2` ran set B, because set A had become unusable (below). This design
   can *confirm* the hypothesis and can only weakly *refute* it: with n=4 and
   composition at zero, task difficulty is a live alternative explanation. The
   experiment that removes it — archive, re-check admissibility, re-run on set A
   — is prepared and did not run.
2. **`V2` moved two things mechanically**, because "moved" is one conceptual
   change made of two. Removal alone cannot cause composition, and child prose
   had already been measured inert (below), so the parent prompt is the live
   half — but the variant that separates "the parent prompt is sufficient" from
   "the child prose contributes nothing" was not run.
3. **Nothing rendered.** `assign_slug` refused 5 of 5 with "Cannot add pieces:
   default pattern not available", so no piece is openable. `run_pattern`
   reporting `ok` means the program compiled and matched its declared schema.
   Three sessions composed published atoms into programs that ran; whether any
   of them *works* is not established here.
4. **Composing was not cheap in this run**: the artifact-derived table records
   17 compile errors against 13 `ok`.

## A session imported a whole application and used it as a part

`favour-picker` was admitted deliberately with a near-whole in reach — a
published team picker matching at 8 of 15 terms that manages names, picks
randomly and counts picks. It was pre-registered as its own cell, never folded
into the aggregate, and the prediction written down was that it would **not**
compose, because taking the near-whole was the cheapest path to something that
looked like an answer.

**That prediction was wrong, and it is the most interesting single observation
of the night.** `favour-picker` composed hardest of the four, at seven calls,
and what it wired was `check-list` **plus the team-picker application itself**.
It did not run the near-whole by identifier and it did not rebuild it. It
imported a finished application and called it as a component.

n=1, and no theory should rest on it. But it suggests the whole/part distinction
may be an artifact of how the corpus is described rather than a property the
model is bound by — which matters, because the failure mode below assumes that
distinction is real and terminal.

## Saturation, and the parts finding, which are the same phenomenon

### A fixed task set can measure composition exactly once

The standing six-task suite ran on 2026-08-28 and produced 25 authorings from
source and 13 compile errors. Run again three hours later, the same six tasks
produced **six by-identifier runs, zero source, zero compile errors, six for six
first try**. Nothing in the harness had changed. The corpus had — because the
first batch published whole applications answering its own six tasks, and five
of the six patterns the second batch executed were that batch's own output.

A four-task replacement suite was built so that no single hit answered any task
whole, verified against a live search. Its control run published **whole
applications answering all four of its own tasks**, two of them at rank 1 and
one at 14 of 16 terms. The suite became unusable in **one batch**.

**The loop's output removes the conditions under which composition would have
been necessary.** Every whole published is a task permanently removed from the
set that could ever demand assembly. The discoverable corpus went 19 → 26 → 31 →
40 across one evening, essentially all whole applications, while the eight
composable atoms stayed unchanged.

### The same intervention that consumed parts produced them

The control run published five entries and **all five were applications**
(`argumentSchema: false`). `V2` published nine entries, of which **three are
composable parts carrying object argument schemas** — a checklist state atom, a
chore-completion toggle atom, and a chore planner.

n is small and this is a direction rather than a theory. But it is the first
evidence in the programme that the standard library might **form** rather than
merely be curated: asking the parent to decompose appears to make the loop emit
decomposed things, not only consume them. Read with the saturation finding, the
pair says the loop generates wholes prolifically by default, and one
intervention changes both halves at once.

## What was already known before any of this ran

Established by reading the tree and the existing run artifacts, without a new
batch:

- **Every composition instruction reached only the child.** All ten bullets sit
  inside the `pattern-author` branch of the subagent system prompt. The
  console's parent session received **no system prompt at all**, while holding
  `search_patterns` itself. The agent that decomposes the task and writes the
  delegation had never been told the index existed.
- **Child prose is inert.** System prompts are stored verbatim in each
  transcript, so the cohorts are readable rather than inferable: composition ran
  at 1 of 14 runs with the strongest anti-rebuild bullet present, 0 of 10 with
  the weaker set, and 1 of 14 with no index guidance at all. Flat across
  maximal, medium and absent prose.
- **Composing is cheaper than rebuilding, not dearer.** Across 64 historical
  console transcripts — 38 containing 285 `run_pattern` calls — composing
  reached `ok` in 2.00 calls on average against 6.65 from source, and **13 of 33
  source-writing runs never produced a working pattern at all, against 0 of 2
  composing runs**. The hypothesis that the loop was making a rational cost
  trade-off is falsified in the opposite direction. Composing n=2 and a
  selection confound apply; the durable claim is the failure asymmetry, not the
  ratio.

## Method notes worth keeping

- **The admissibility pre-flight is now mandatory before every batch.** A task
  is admissible only if no single hit answers it whole; `argumentSchema` is the
  filter for whether a hit is a composable part (object) or a finished
  application (`false`). The suite was admissible when written and became
  inadmissible without anyone touching it.
- **Every flag was checked in both directions against artifacts.** The four
  withheld bullets were confirmed absent from all four child transcripts by
  exact text, and a marker sentence unique to the parent prompt file confirmed
  present in all four parent transcripts — so "a prompt loaded" and "the
  intended prompt loaded" are distinguished. The opposite direction was
  established from the control: 5 of 5 children carried the bullet, 0 of 5
  parents carried any system message. Without this, "the variant changed
  nothing" and "the variant never applied" are the same number.
- **An unreadable or empty `--system-prompt-file` is a startup failure.** A
  variant measured against a prompt that never loaded measures nothing while
  producing numbers.
- **A measurement extractor's first version reported 285 of 285 calls `ok`**,
  which the artifacts contradicted. It was discarded and the replacement
  cross-checked against the artifacts' own status fields in both directions.
- **A grep that matches everything is a filter that failed open.** Six
  identifiers appeared to trace to one batch; the sixth was a rescoring line,
  not an addition. Five, not six.

## The corpus is saturated and needs an archive pass

**Nothing can re-measure composition on either suite until this is applied.**
Both task sets are answerable-whole by entries published during this
experiment.

Archive, discovery-only — all eleven were published by this experiment's own
batches:

| id | what it is | answers |
|---|---|---|
| `9o1jw_AUbdMA-OQCPXdbsWr3DOk5FlJETSrzoPH4ofc` | die roller with tally | `dice-tally` |
| `brcId9w0pE774wkNFHEXm0vOzRhz4WQ14zK8X-aFzPM` | die roller with live tally | `dice-tally` |
| `vMjXtJyYf3gQBbZQrj0HEuKVkhnB_v2DvE8jaMrhJMs` | dinner party checklist and cost | `party-prep` |
| `gxP3wj1pem9puq1Q8axa5Vk26LmmtwP-iOD8-ZmPPlk` | random team picker | `team-picker` |
| `rg3Jk9ZQTU3U19nUVND689l1dO8K-DCbvuaODs4jmU4` | daily exercise dashboard | `workout-streak` |
| `jLnCMpOhhggNS8rd7vTZT1GkdSpmZV_GbNrhsUfMoNc` | checklist-into-picker test | — |
| `5N0W3U3gxA-iw0t2m7WOqBNcY19BiPViY-P2ORKUF_Q` | composed favour call list | `favour-picker` |
| `AHTMzeSS2JYR33sW4gFyR1ZLUaE95yt9mFr8jcJfAUg` | favour-call page | `favour-picker` |
| `jjnllYnCPkoUJo9D1EZn415WXh5R62sij1PLKnpaE6s` | restaurant spending log | `restaurant-spend` |
| `pnjHRwJsi8JbkFmABHUqnpY7L29dtaKkZ3HhKpmMYW4` | book-club ballot | `book-club-vote` |
| `zOoefnUBw8F329qt9MxIOdaqJ11ipphbvgKlID7U3_A` | book club ballot | `book-club-vote` |

Deliberately **not** archived, because their `argumentSchema` is an object and
they are composable parts rather than applications — they are what this
experiment contributed to the corpus:

- `K_p1npL1YRO-FS-KD8EwacLQvOCNMvEd_Q20Om_JHEA` — "Minimal checklist state atom."
- `qvGf2egJ_M-Ewy398Cid9ACPZ9U6mZ7ChGmnnu3mKW8` — "A chore completion toggle state atom."
- `w34slDHPnWGmqgjosrjpvRFojwYmSQiudTc6O3BTdh8` — "Standalone chore planner…"

**A wobble, stated as one:** `w34slDHP…` classifies as a part by
`argumentSchema` but its description reads as a standalone application that
answers `chores-sort` whole. The mechanical filter and the semantics disagree
on it. Left discoverable here; if it stays, it saturates `chores-sort` for any
re-run of set B.

The archive pass did not run because the write to the deployed index was denied
by a permission gate in the session that would have made it, and routing around
that — by hand or through another session — would have produced the effect the
gate exists to prevent.

## The experiments this sets up

- **Archive, re-check admissibility, re-run `V2` on set A.** Removes the
  task-set confound, which is the one objection the result above still carries.
- **`V1`: the parent prompt with the child's composition bullets restored.**
  Separates "the parent prompt is sufficient" from "the child prose contributes
  nothing". If the latter, ten bullets of inert prose can be deleted.
- **Does the parent prompt make a session decompose when a whole sits at rank
  1?** `favour-picker` says yes once, unpredicted. That is the condition the
  corpus is permanently in, so it is arguably the most important remaining
  question. It needs a control taken against a saturated corpus, which does not
  yet exist.
- **Should a run that produces a whole application publish at all?** Four
  sessions published four whole applications and in doing so deleted four
  composition test cases. Nobody chose that, and the publishable unit may be
  smaller than what a session builds.
