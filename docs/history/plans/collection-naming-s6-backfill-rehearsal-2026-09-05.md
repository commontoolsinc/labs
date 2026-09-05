---
status: historical
created: 2026-09-05
archived: 2026-09-05
reason: "Record of the clone rehearsal of S6 item 4 — the Topics member-namespace backfill and its operator link-bind: the gap reproduced, the link-bind closed it, and the deploy that has to precede both was refused by a check the plan's gates do not perform."
---

# Rehearsing the Topics member-namespace backfill

S6 item 4 of [`../../plans/collection-naming-topics.md`](../../plans/collection-naming-topics.md)
is the production backfill that names the Topics filed before the board had a
namespace, plus the one-time operator link-bind that lets each of them read the
name. This is what a clone rehearsal on 2026-09-05 measured. Estuary was not
contacted, read-only calls included.

Repository at `63de1a1e8c`. The graft is `2a116f1d73` (#6937); "pre-graft
source" below means `topics/main.tsx` and `topics/topic.tsx` at `5fd6cce7c7`,
its parent.

Every command quoted below was run. Message text is verbatim; JSON envelopes
are trimmed to the fields that carry the finding, and long single-line messages
are shown on one line inside their fence.

## The headline

The gap is real and the link-bind closes it. What the rehearsal did not expect
to find is that the deploy which has to happen first is refused on both legs,
and that the reason is general rather than particular to `shortName`. Plan item
4 claimed the graft "needs no schema flag"; that claim was wrong, and the gates
it rested on do not examine the thing that refuses.

## Setup

Two local stores, because the first could not be carried past the refusal.

**Store 1 — a genuine pre-graft clone.** A board deployed from the pre-graft
`main.tsx`, three Topics filed through *its* `addTopic` (so they predate the
namespace rather than being unwired by hand), snapshotted with `VACUUM INTO`
and cloned:

```
$ cf space clone did:key:z6MkvL9cg… --from …/pre-graft-snapshot.sqlite --to …/clone
cloned did:key:z6MkvL9cgMNDMvoScKXn7WWThANXpnLvtGpRKnoyymXmTCaM
  snapshot   6.4 MB  2fRzzNiLzKJ4SoPqwkDxnBfCZcYMoHdX9fes3-TcXWU
  counts     170 commits, 758 revisions, 578 entities
  content    fid1:jQ_m7NFJfywAns9M_T3Yf0PdTOR5bCOL1stWD4eYLWs
             480 entities fingerprinted, 123 generated cells excluded
```

Served with `HOST=127.0.0.1 MEMORY_DIR=… ./scripts/start-local-dev.sh
--port-offset 70`; the `SERVING A REHEARSAL CLONE` banner was checked in the
toolshed log. Baseline `cf space verify` before anything: `baseline intact ·
removed 0 · changed 0 · added 0 · content unchanged · commits 170 → 170`.

**Store 2 — the post-deploy state, assembled directly.** The grafted board from
current `main.tsx`, holding Topics that `addTopic` never wired: pieces deployed
straight from `topic.tsx` with `cf piece new` and put on the board with
`cf piece link <topic> <board>/topics/<n> --allow-non-existing`. This is the
state a completed board-and-children deploy leaves behind, reached without the
deploy the first store refused.

## Finding 1 — the deploy is refused on both legs

`setsrc --check` over the pre-graft clone, board leg:

```
piece source is incompatible with retained input: input link at topics.0 schema is not compatible: input link at topics.0.shortName: an unconstrained schema is no longer accepted
```

and topic leg:

```
piece source is incompatible with retained input: input link at mentionable schema is not compatible: input link at mentionable[].shortName: an unconstrained schema is no longer accepted
```

The checker was verified against a known answer first: re-checking the board
with the source it already runs is accepted, so the checker is not refusing
everything.

**The refusal is not about `shortName`.** Two probes, each the pre-graft
`main.tsx` with one property added to `TopicDemand` and nothing else changed:

| probe | added to `TopicDemand` | result |
| --- | --- | --- |
| A | `probeField?: string` | `input link at topics.0.probeField: an unconstrained schema is no longer accepted` |
| B | `probeField?: unknown` | identical message |

So **any** new property on a per-member demand is refused over a board holding
members that do not publish it. The schema recorded on the retained link to
each member is unconstrained at that path, and narrowing an unconstrained
schema is what `packages/piece/src/schema-compatibility.ts` refuses. A third
probe with a defaulted `probeField: string | Default<"">` did not compile and
was abandoned; the `Default<>` spelling's own incompatibility is recorded in
#6937's message and was not re-measured here.

**Why the gates said otherwise.** #6937 concluded "`pattern-compat` is clean
against every recorded baseline, so this needs no accepted break and no schema
flag to deploy." `deno task pattern-compat` judges a pattern's declared
contract against the contracts it has declared before; `deno task
pattern-vintage` replays the pattern's own stored documents under today's
source. Neither examines the schema recorded on a link into a *sibling* piece,
which is the check that fires here. Both being green is compatible with the
deploy being refused, and was.

The forced deploy was **not** rehearsed.
`--dangerously-allow-incompatible-schema` is held behind explicit team
authorization by `skills/topics/SKILL.md`, and the
rehearsal stopped at the refusal rather than waive a proof it had no
authorization to waive. What the flag leaves behind on a populated board is
therefore still unmeasured.

## Finding 2 — the topic leg has an older blocker, independent of the graft

Filed as #6968.

Moving the board first clears the topic leg's `mentionable[].shortName`
refusal: with the grafted board in place, `setsrc --check` of the grafted
`topic.tsx` over a pre-graft Topic reports something else instead.

```
piece source is incompatible with retained input: input link at mentionable schema is not compatible: input link at mentionable[].piece: newly required argument field has no default
```

That one predates the graft. `cf piece getsrc` of a board-created Topic returns
`topic.tsx` and nothing else, and `diff` against the pre-graft file says
IDENTICAL — yet `setsrc --check` of that byte-identical source over its own
piece is refused with the same message. It reproduced in both stores, including
on a control piece deployed clean and never otherwise touched.

**What a Topic loses by never taking this step, measured.** Less than the
blocker's position in the order suggests. A Topic still running pre-graft source
on a grafted board is named by `backfillNames` like any other member, answers to
`cf cell get /top/4 title` with `"Legacy topic C (pre-graft source)"`, and reads
back as an ordinary `index` row carrying its title and no `shortName` without
emptying the array around it. What it does not have is `shortName` itself — no
badge, no number on its index row, and `cf cell get --cell <topic> shortName`
reports the property does not exist rather than failing to materialize. So the
Topic-side source update buys the number's VISIBILITY on the member and nothing
else; allocation, the map, and `/top/<n>` addressing are all the board's and all
work without it. A board that stops before it is a coherent end state.

The mechanism: `mentionable` is declared `Writable` on the Topic
(`packages/patterns/topics/topic.tsx`), and `provePreservedContracts` in
`packages/piece/src/ops/piece-controller.ts` proves both directions when the
destination handle can write. The board's row publishes `piece`; the Topic's
`TopicMentionable` projection does not name it; the write-back direction fails.
Declaring `mentionable` read-only, as `boardCrossrefs` and `boardNames` already
are, would drop that leg of the proof — not attempted here, and it needs
checking that nothing writes through the binding first.

## Finding 3 — the gap reproduces

The instrument was verified against a known answer before any empty read was
trusted: a Topic filed through the grafted `addTopic` in the same board read
`"shortName": "1"` in its own result and in the board's `index` row. An empty
read from the same commands therefore means the system, not the reader.

`backfillNames`, once, through the board:

```
{
  "invocation": "backfill-1",
  "status": "settled",
  "receipt": "/of:fid1:jN3t1AzX5Uq_R2Tj-j2zlchglDmyIak4PTytJ9YBGNw",
  "result": { "assigned": [ "2", "3" ] }
}
```

The board's map and table hold the names:

```
$ cf cell get --cell "$BOARD" names --step
{ "1": {}, "2": {}, "3": {} }
$ cf cell get --cell "$BOARD" namesTable --step --select name
[ { "name": "1" }, { "name": "2" }, { "name": "3" } ]
```

The Topics do not. Their `index` rows carry no `shortName` beside the control
row that does, and their own read fails to materialize:

```
$ cf cell get --cell "$TOPIC" shortName --step
Cannot read piece result at "shortName": stored data is present, but its schema could not resolve all required values. The piece was stepped, but the required value still did not materialize.
```

## Finding 4 — the link-bind closes it

One Topic was bound and a second left alone as a control inside the same board:

```
$ cf piece link "$BOARD/namesTable" "$TOPIC/boardNames"
Linked fid1:PsEKqxGfhAaFgHbDMukzSr7_8qF3wISOsKPL0BSsoXs/namesTable to fid1:0SpKr2JWj939XCwSEX4H6uyXA8fzx5HILsNBCPLiiFQ/boardNames
```

Afterwards the bound Topic reads `"2"` from its own `shortName` and from its
board `index` row, and `cf cell get /top/2 title` returns its title. The
unbound one kept reporting the materialization message above until it was bound
later, at which point it read `"3"`.

Member addressing was exercised after binding the board's map as a slug with
`cf piece set-slug top "$BOARD/names"`:

| address | result |
| --- | --- |
| `cf cell get /top/2 title` | `"Legacy topic A"` |
| `cf cell get /@graft-rehearsal/top/2 title` | `"Legacy topic A"` |
| `cf cell get //graft-rehearsal/top/2 title` | `Target must include a piece handle, e.g. "/of:fid1:abc123/path".` |
| `cf cell get //did:key:z6MkiHoo…/top/2 title` | same refusal |
| `cf cell get /top/999 title` | `no member 999 in top` |
| `cf cell get /top title` | `no member title in top` |

The `//<space>/…` spelling from the cell reference grammar is not accepted by
this build for either a space name or a DID.

## Finding 5 — cost, idempotence, ordering, partial failure

- **Idempotent on both halves.** A second `backfillNames` returns
  `{"assigned": []}` and writes no key. A second `cf piece link` with the same
  two endpoints prints `Linked …` and commits nothing:
  `cf inspect churn --bucket 5` over the bracketing window reported
  `no timed commits in window`. `wrote to space` on stdout is not evidence of a
  commit.
- **One commit and one revision per Topic** for a bind that changes something,
  measured the same way on a freshly deployed piece (`1 commits / 1 revisions`).
  Wall time 1.1 s and 8.6 s on the two binds that were timed. The cost that
  matters at board scale is one CLI process per Topic: ~125 sequential
  invocations for the Estuary board, which is the shape
  [`../topics-board-migration-2026-08-28.md`](../topics-board-migration-2026-08-28.md)
  found dying 4-6 minutes in from a laptop.
- **Binding before the backfill works.** A Topic bound before it had a name read
  the materialization failure immediately after `backfillNames` returned
  `["4","5"]`, and read `"5"` on the next identical command with no write
  between them. The first read after a backfill can report no name for a
  correctly wired Topic: **read twice before concluding a bind failed.**
- **`/top/<n>` resolves without the bind.** Address resolution follows the
  board's map, so a backfilled but unbound Topic answered
  `cf cell get /top/3 title` with its title while its own `shortName` was still
  absent. The bind is what makes the name *visible on the member*, not what
  makes it addressable.
- **Partial failure is benign and resumable.** A board with some Topics bound
  and some not served all of them, named rows beside unnamed ones; the repair
  is to bind the rest, and nothing has to be undone. The audit is on the
  durable argument, not the derived value:
  `cf cell get --cell "$TOPIC" boardNames --input --select name` returns the
  whole names table for a bound Topic and `[]` for an unbound one. The `keys`
  of the input document say nothing, because a Topic deployed with the current
  source materializes `boardNames` at its `Default<[]>` either way.
- **`addTopic` keeps wiring its own children afterwards.** A Topic filed after
  the operator step returned `"name": "6"`, carried the table, and read
  `"6"`. The step is one-time.
- **A Topic on the grafted board that publishes no `shortName` does not empty
  the array.** A pre-graft-source Topic sitting among grafted ones read back as
  an ordinary `index` row with a title and no `shortName`, with all four rows
  present — the claim the property's optional spelling exists for, confirmed on
  a live board.
- **Binding a piece the board does not hold** succeeds and produces no name:
  the table addresses rows by member identity and holds no row for a
  non-member.

## Finding 6 — two tool behaviors that mislead

Filed as #6964 and #6965.

**`setsrc --check` writes to the store.** Isolated on the clone after a
`cf space reset`, one step at a time. Serving it and stopping again, with
nothing run against it, leaves it pristine — `removed 0 · changed 0 · added 0 ·
content unchanged · commits 170 → 170` — so the server is not what writes. Then
exactly one `setsrc --check`, the refused board leg above, which by its own
report replaced no source:

```
baseline   intact
removed    0
changed    0
added      18
content    CHANGED
commits    170 → 172
revisions  758 → 776
```

Nothing authored moved, and the 18 additions are the derived entities that come
of starting the piece to compare its schemas. But the clone is no longer
pristine, and `verify` now prints "After a schema migration this is the EXPECTED
result" over a clone that had no migration. A flag named `--check`, documented
as reporting "without updating the piece", is a trap for exactly the operator
who is being careful.

**`--allow-non-existing` on `piece link` is a silent success that poisons the
piece.** Binding a Topic whose pattern has no `boardNames` input — one whose
source has not been migrated yet — is refused, and that refusal is the guard
keeping the bind behind its source migration:

```
Target path "boardNames" does not exist on piece fid1:6hFfedgkyexpLrT0aHBqQIOj-UeETNB9IwKBevb4ke8

Use --allow-non-existing to link anyway.
```

Taking that suggestion prints `Linked …` and changes nothing the pattern can
see: the Topic's input map does not gain the key — neither
`cf cell get --cell <topic> --input` nor `cf piece inspect`'s Source (Inputs)
lists it — and no name appears. The link was written into the *argument
document* instead, which the pattern's input map does not reach. Two reads do
reach it, and both mislead: the argument document's path directly
(`/of:fid1:XEqNlJJHF_…/boardNames`) and, more dangerously,
`cf cell get --cell <topic> boardNames --input`, which is the audit query for
"is this Topic bound?" and answers yes.

The damage is on the next migration of that Topic. Measured within one piece,
same command before and after a single forced bind, with nothing else changed:

```
# before
piece source is incompatible with retained input: input link at mentionable schema is not compatible: input link at mentionable[].piece: newly required argument field has no default

# after
updated arguments do not match the candidate schema: boardNames: value does not match type array
piece source is incompatible with retained input: input link at mentionable schema is not compatible: input link at mentionable[].piece: newly required argument field has no default
```

## What this rehearsal did not cover

- The forced deploy under `--dangerously-allow-incompatible-schema`, and
  therefore anything about what a forced board or Topic update leaves behind.
- Whether the Estuary deployment's own vintage refuses the same way. It runs an
  older commit than either source here, and the retained-link schemas it holds
  were written by that commit. `cf piece setsrc --check` against the deployment
  is the one-command answer, and it belongs to whoever is authorized to touch
  Estuary.
- The full source package. The clone's pieces were deployed without attached
  tests, and the `--check` runs carried none, so nothing here measures the
  packaging or type-checking of the six `topics/*.test.tsx` entries a real
  `setsrc` would attach.
- Anything about the deployment rather than the store: shell bundle, CDN, and
  concurrent human traffic are all absent from a clone.

## Where the procedure went

The operator procedure — the order, the two commands, the audit query, the
measurements above in short form, and the two traps — is the "Naming the Topics
that predate the namespace" section of `skills/topics/SKILL.md`.
