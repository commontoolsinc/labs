# Measuring the pattern index loop

How to measure whether the pattern index is doing its job, in a way that a run
next week can be compared against a run tonight.

The loop under measurement: a console session builds something, publishes it to
the index, and a later session finds and composes it without the source ever
entering model context. The question this protocol answers is narrow and worth
stating exactly — **does a session that was never told the index exists find a
published part and wire it in?** Everything below exists to keep that question
answerable.

## The rule the whole thing rests on

**A task must not mention the pattern index.**

Not "search the index for a counter", not "reuse an existing pattern if there is
one", not "check what's already published". A task worded that way measures
whether the model follows an instruction, which is not in doubt and is not
interesting. A run that was told to search and then searched has established
nothing about discovery.

The finding this instrument exists to produce is spontaneous reuse: a session
given an ordinary request, holding tools it was not pointed at, that reaches for
a published part because reaching for it was the cheapest way to answer. That
finding means something only because the session was never told.

The same rule reaches further than the word "index". A task must not name a
published pattern, describe one closely enough to be quoting it, or use the word
"reuse". Ask for the thing a person would ask for.

The rule is not only a methodological preference. It is also what makes a batch
identifiable afterwards. Seven console runs sit in one artifact root within a
ten-minute window; six of them are a discovery batch and the seventh is an
instructed-composition run, and the only thing that separates them is that the
seventh's text says "search the pattern index". No timestamp, session attribute,
or artifact field distinguishes them. So a task that mentions the index does not
merely weaken the finding — it makes the batch unrecoverable as a batch.

There is a second kind of run that is worth doing and must never be filed
alongside the first: telling a session explicitly to import a named pattern.
That measures whether composition _can_ happen — whether the mechanism works at
all — and it is how the "can, but won't" reading was arrived at. Run it when the
mechanism is in doubt. Record it as its own batch, labeled as instructed, and
never merge its numbers into a discovery batch's.

## What a comparable run is

Five things have to match for two batches to be compared. A batch report records
the four it can read, and names the fifth as not recorded, so a reader checks
rather than assumes.

1. **The tasks, worded identically.** The standing suite is
   [`scripts/pattern-index-suite.json`](../scripts/pattern-index-suite.json).
   Its `notes` field carries the same rule this document does. Adding a task
   leaves the earlier tasks comparable; rewording one does not, so add rather
   than reword.
2. **A fresh session per task, one task at a time.** A session that has already
   searched is not a session discovering. Running one at a time is also what
   makes an index change attributable to the task that caused it — two sessions
   publishing concurrently leave a diff nobody can split.
3. **The index state going in.** The report records what `listPatterns` returned
   before the first task and after the last, the difference between them, and
   how much of it was findable rather than merely recorded. A batch against a
   29-entry index of near-duplicates and a batch against a seeded, gardened
   corpus are different experiments with the same tasks — and the corpus does
   change between batches, by seeding, archiving and rescoring. A comparison
   across two batches whose index readings differ has to say so, or the
   difference reads as an effect of the harness alone.
4. **The console's CFC posture and its skills root.** Every turn scans the
   skills root before its first model call and records what it found in the
   run's own `skill-registry.json`, which the report reads — for the whole run
   family, not the parent alone. A `delegate_task` child is where authoring
   happens, so a parent that scanned a root while its children did not is the
   shape that matters, and `read_skill_resource` answers nothing in a run with
   no registry.
5. **The model.** `--model` or `CF_HARNESS_MODEL`.
6. **The fabric server the console talks to.** Read from its `/api/meta` and
   recorded whole; see [below](#the-server-the-runs-ran-against).

## Running a batch

Start the console with an index configured, from `packages/cf-harness`:

```sh
CF_HARNESS_CONSOLE_PORT=8103 \
CF_HARNESS_FABRIC_API_URL=http://localhost:8000 \
CF_HARNESS_FABRIC_IDENTITY="$HOME/.cf/my-key.pkcs8" \
CF_HARNESS_FABRIC_SPACE=pattern-index-demo \
CF_HARNESS_PATTERN_INDEX_URL=https://index.example \
deno task console
```

[The console README](../console/README.md) covers the rest of its prerequisites
— a local toolshed, a running Docker daemon, a connected model provider, and a
space named by name rather than by `did:key`.

Then, in another shell, run the suite:

```sh
CF_HARNESS_PATTERN_INDEX_URL=https://index.example \
deno task measure-batch scripts/pattern-index-suite.json \
  --console=http://127.0.0.1:8103 \
  --fabric-api-url=http://localhost:8000 \
  --out=.cf-harness-console/measurements/tonight
```

`--fabric-api-url` names the server whose `/api/meta` the report records; it
defaults to `CF_HARNESS_FABRIC_API_URL`, then to `http://localhost:8000`. Point
it at the same server the console was started against, or the report describes a
machine the runs never touched. Add `--expect-git-sha=<sha>` to refuse the batch
unless that server reports the commit you meant to measure, and `--base` to ask
ancestry against a branch other than `main`.

The runner loads the console page to pick up the token cookie every `/api` route
is gated on, reads the index, and then runs each task in its own session. It
waits on the console's own `turn_completed`, `turn_failed` or `turn_canceled`
event, read off the server-sent event stream, and on nothing else. There is no
timeout: a turn that hangs is a batch that hangs, which an operator can see and
release with a `POST /api/cancel`, rather than a bound that turns a slow run
into a failed one. It writes `report.md` and `report.json` under `--out`, and
exits non-zero if any task ended other than completed.

Measuring runs that are already on disk needs no console:

```sh
deno task measure-runs                                  # every family under the default root
deno task measure-runs 9f9bdfe6-20fe-4eac-9346-6ecfa102119e
deno task measure-runs --artifact-root=/elsewhere/runs --json
```

A run family is a parent run and the `delegate_task` children the harness named
`<run-id>.subagent.<n>`. Both commands report the family, never the parent
alone: a parent commonly delegates the authoring and then names the child's work
as its own.

## What the report holds

Per task: the exact text the session was given, the session and run identifiers,
how the turn ended, then one line per call the run made against the index and a
totals block.

The counts, and the distinctions worth knowing about:

- **Searches**, partitioned into hits, empty, refused, and not read. A search
  the index _refused_ — a 403 for an identity that is not allowlisted, say — is
  counted apart from a search that found nothing, because it says nothing about
  the corpus. Collapsing the two is how a broken deployment reads as an empty
  index. Eight of the 58 phase-2 searches were refusals — and all eight sit in a
  single pre-fix run family whose identity the index would not serve, so that is
  one broken run rather than a background refusal rate.
- **`run_pattern` calls**, split by whether they named a published pattern or
  carried source. This is the reuse signal: a run that names an id found
  something, a run that carries source wrote it.
- **`cf:pattern:` imports** in that source, split into source that **composes**
  an imported pattern and source that is a **bare re-export** of one. That split
  is not fussiness. The live index holds entries whose whole program is
  `import P from "cf:pattern:…"; export default P` — one of them ranked third
  overall — and a re-export composes nothing while looking identical to
  composition in an import count. The two are reported apart, never as one
  "compositions" figure. The classifier is a heuristic on the source text, and
  it errs towards calling unusual source composition rather than quietly
  discounting it, which is why both numbers are printed rather than one.
- **`run_pattern` outcomes**, counted by whatever status the tool reported.
- **Delegations**, by profile.
- **Slugs**, split into assigned, refused, and not read. Only an assigned slug
  is named: a slug the tool refused was requested and answers to nothing, so
  counting the request would put a name in the report that opens no piece.
- **Tool surfaces**, every tool the runs called and how each call ended, with a
  denial counted apart from a failure. A surface every one of whose calls was
  denied is marked `WITHHELD`, and one that ran and never succeeded is marked
  too. Without that line a reader infers that the model chose not to use a
  surface that was in fact unavailable to it — across the phase-2 corpus, `bash`
  was 38 calls and 38 denials, and `read_file` never once returned a file. These
  are derived here from each tool's own recorded result, not taken from any
  classified field of the run report.

Everything the reader could not read is counted as not read, never as zero: a
run directory with no transcript, a call whose result the run never wrote, a
tool result that carried no status. Those readings appear in the rendered report
as `NOT READ`, with the reason.

## What this measures, and what it does not

It **counts what a run did**. Every number above is a count of calls in a
transcript.

It **does not say whether what a run built works.** Nothing in this protocol
renders a piece. `run_pattern` reporting `ok` means the pattern compiled and its
result matched the schema it declared, and that is the whole of it: the phase-2
sortable table rendered every cell as `[object Object]`, reported `ok`,
published clean, and ranked first for its query. Whether a published pattern
works is CT-2107's subject. A batch report read as answering it is worse than no
batch report, because the numbers look like evidence.

Two consequences follow, and both are load-bearing:

- A rise in "ran by id" is a rise in **reuse**, not in **quality**. It rises
  just as readily when the index fills with broken parts that rank well.
- Confirming that a run built something that works means opening it. The report
  records each run's assigned slug so the piece can be opened; that check is a
  person's, and its result belongs in whatever records it, not in a count here.

It **does not say whether a run found what it asked for.** A search hit is a hit
against a pattern's _description_, and a description in this index is not
reliably a description of the program behind it. Read against the live corpus:
one entry advertising a grocery checklist is a 287-byte counter, one advertising
a reading list has no interface at all, and three "packing list apps" are
`computed(() => 2)`. So a hit counted here is a hit, not a match, and a rise in
hits is not by itself a rise in useful answers.

It **does not establish why** a run did what it did. A run that wrote its own
counter with a working counter sitting at the top of its search results is
evidence about incentive, not about mechanism, and the instructed-composition
batch above is what separates those two.

It **does not read a classified failure field.** Everything above is derived
from the raw results in the transcript. That is deliberate: a classifier ranks
causes by a priority ordering chosen for another purpose, and a measurement that
inherits one reports that ordering rather than what happened.

It **does not measure the index's own ranking.** The report records each listed
pattern's score, and score is computed from recorded events. With
`record_feedback` uncalled, a score is a count of "an agent started this and
nothing threw".

## The server the runs ran against

The console talks to a fabric server, and which one — and which commit it is
built from — decides what the runs were actually exercising. A server left
running from another worktree's branch is not running the code a measurement
reports on, and nothing in a run artifact says so.

So the report reads the server's `/api/meta` before the first task and records
what it says: the commit, the CFC block, and the experimental flags. It also
asks the local repository whether that commit is on `main`, and records
`ancestor`, `diverged`, or `unchecked` — a commit this clone does not hold is
`unchecked`, which is not the same reading as one known to be off the branch.

Two rules about that recording, both load-bearing.

**It records, it does not refuse.** Running against a deliberately mismatched
server is documented practice, so a `diverged` reading is a fact for the reader
rather than grounds to refuse a night's work. The one refusal is an expectation
the batch was given explicitly: `--expect-git-sha=<sha>` refuses when the server
reports a different commit.

**The server's CFC block is never differenced against the console's.** They
describe different runtimes. `cfcFlowLabels` is core-default off and the
`MAX_ENFORCEMENT_CFC_OPTIONS` bundle is applied by the `remoteClient` and
`browserWorker` presets — which is what cf-harness's fabric session is — while
the toolshed runs a production-server preset. A server built from `main` reports
`flowLabels: "off"` and that is correct. A check that read the difference as a
contradiction would refuse every correctly configured night. The report prints
the server's block as the server's, beside the console's as the console's, and
leaves the comparison to a reader who knows which runtime they are asking about.

## The failure this measurement exists to not commit

Three separate things went wrong in the same shape while this was being built,
and every one of them was **a confident wrong answer where an honest refusal
belonged**:

- An index that answered `403` to every query recorded as an index that held
  nothing. A whole run family searched, found "nothing", and wrote its own
  patterns. Nobody noticed.
- A classifier mapped every denied policy event to one cause at the highest
  priority, so a run whose `bash` was denied reported that as its terminal cause
  whatever actually ended it.
- A server's CFC block was read as contradicting the console's, when the two
  describe different runtimes under different presets. That one was caught
  before it shipped, and it would have refused every correct night.

Each was cheap to prevent and expensive to discover, and none of them looked
wrong from the inside — that is the whole difficulty. The rules that follow from
it are the ones this document keeps repeating: an unread reading is recorded as
unread and never as a zero; two readings that could differ are printed side by
side rather than differenced; a refusal is a refusal rather than a warning; and
a check refuses only on something it was told, never on something it inferred.

## Changing this

The scripts are [`scripts/measure-runs.ts`](../scripts/measure-runs.ts) — the
extractor, whose counting rules are pinned by `test/measure-runs.test.ts`
against hand-authored transcripts — and
[`scripts/run-measurement-batch.ts`](../scripts/run-measurement-batch.ts) — the
runner, pinned by `test/run-measurement-batch.test.ts` against a stand-in
console server.

Two rules for changing either. A new count is an addition; a changed count
breaks comparison with every report already written, so say so in the report's
notes when you do it. And nothing may collapse an unread reading into a zero —
the whole value of a report a colleague did not run is that it distinguishes
what happened from what nobody looked at.
