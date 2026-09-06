---
status: historical
created: 2026-09-06
archived: 2026-09-06
reason: "Record of the second clone rehearsal of S6 item 4, run after #6987 and #6990: what a forced deploy leaves behind, what the #6990 transition costs on a genuine pre-graft clone, and the removal case that decides whether a name addresses a member or a slot."
---

# Rehearsing the Topics backfill again, on the fixed system

The first rehearsal of S6 item 4 is
[`collection-naming-s6-backfill-rehearsal-2026-09-05.md`](collection-naming-s6-backfill-rehearsal-2026-09-05.md).
Two things make it insufficient on its own, and this run exists to close them.

Its `/top/<n>` observations were made through the positional links #6987 fixed:
`backfillNames` recorded the cell AT a list position rather than the member the
position held. Every read it took was of a board that had never had a removal,
so those reads cannot distinguish the two. And it says in as many words that
"No forced update ran anywhere in this rehearsal, so nothing here says what a
real transition leaves behind" — leaving the cost of
`--dangerously-allow-incompatible-schema` unmeasured on a populated board.

Repository at `a8f9d0874e`. "Pre-graft source" below means
`packages/patterns/topics/main.tsx` and `topic.tsx` at `5fd6cce7c7`, the parent
of the graft `2a116f1d73` (#6937). The two fixes under test are `377f4df404`
(#6987, a backfilled name records the member) and `393ff00302` (#6990, a topic
reads its board's mention index and never writes it). Estuary was not
contacted, read-only calls included; every store below is local.

Every command quoted was run and every fenced block is real output, trimmed
only where a JSON envelope is longer than the field carrying the finding.

The first rehearsal's convention about mechanisms is kept: where a passage says
WHY something happened, the reason is read from the named source file and cited
there, and no run attributed an observation to it. Two observations here are
deliberately left without a mechanism, and say so.

## The headline

The forced deploy is cheap and it destroys nothing. On a genuine pre-graft
clone, forcing the board and its three Topics past the schema refusals left
`removed 0`, every title and body intact, and one added key in each of four
argument documents: `names: {}` on the board and `boardNames: []` on each
Topic. Nothing authored was overwritten.

The removal case — the one no rehearsal had seen — passes, and a negative
control proves the test can fail. After a member is removed, every surviving
name still resolves to its own member. Under a board carrying the pre-#6987
walk, in the same store and the same session, name `1` follows the slot to
whoever shifted into it and name `4` stops resolving at all.

One new trap, and it is worse than the one the first rehearsal recorded. A
board-level `index --step` read reports each member's STALE `shortName`. Two
consecutive reads agreed with each other and both were wrong; only stepping
each member piece brought the value forward. "Read twice" is not enough.

## Setup

One store this time, because the forced deploy carried it all the way through
— the reason the first rehearsal needed a second, assembled store is gone.

**A genuine pre-graft clone.** A board deployed from the pre-graft `main.tsx`,
three Topics filed through *its* `addTopic` so they predate the namespace
rather than being unwired by hand, then snapshotted with `VACUUM INTO` and
cloned:

```
$ cf space clone did:key:z6Mkppj… --from …/snapshots/pre-graft-snapshot.sqlite --to …/clone
cloned did:key:z6MkppjJKBt8EtSdFZJwB367Kn3gSoXCzxKdNt8pt9sBNaRA
  snapshot   6.3 MB  P3VFyHPo74Xf4DQu_QgSOKyqRJIdmerZBiR2DZzXc8M
  counts     167 commits, 741 revisions, 563 entities
  content    fid1:UN5zBio-y7jXeoRp5WKB8r2Gie5zYGiqlx9WX1HiyuE
             465 entities fingerprinted, 123 generated cells excluded
```

Served with `HOST=127.0.0.1 MEMORY_DIR=… ./scripts/start-local-dev.sh
--port-offset 70`, and the banner checked in the toolshed log before anything
was written:

```
  ⚠️  SERVING A REHEARSAL CLONE — THIS IS NOT PRODUCTION

  This directory is a CLONE of space did:key:z6MkppjJKBt8EtSdFZJwB367Kn3gSoXCzxKdNt8pt9sBNaRA, not production.
```

Baseline `cf space verify` before anything:

```
baseline   intact
removed    0
changed    0
added      0
content    unchanged
commits    167 → 167
revisions  741 → 741

OK — nothing moved.
```

The three Topics are called A, B and C below; their pieces are
`fid1:MY1hl…`, `fid1:zB92…` and `fid1:YRns…`, and the board is
`fid1:2cz27…`.

## Finding 1 — the deploy is still refused, and the checker still answers a known question

Verified against a known answer first. Re-checking the board with the source it
already runs is accepted, so the checker is not refusing everything:

```
$ cf piece setsrc --check --cell "$BOARD" …/pregraft/main.tsx --root …/pregraft
…/pregraft/main.tsx can replace the source for piece fid1:2cz27KUxVbq9sO19J6fkG_G0H4CfUnhaopw4udwjEHM
```

The grafted board source over the same board:

```
$ cf piece setsrc --check --cell "$BOARD" packages/patterns/topics/main.tsx --root "$REPO"
packages/patterns/topics/main.tsx cannot replace the source for piece fid1:2cz27KUxVbq9sO19J6fkG_G0H4CfUnhaopw4udwjEHM:
piece source is incompatible with retained input: input link at topics.0 schema is not compatible: input link at topics.0.shortName: an unconstrained schema is no longer accepted
```

Verbatim the message the first rehearsal recorded, at a commit six days newer.
That rehearsal established with two probes that the refusal is general to any
new per-member demand property rather than particular to `shortName`; those
probes were not re-run here and nothing in this run contradicts them.

## Finding 2 — what the forced board deploy leaves behind

This is what the first rehearsal could not report. The clone was reset and the
server restarted first, so the numbers below bracket the forced deploy alone:

```
baseline   intact
removed    0
changed    0
added      0
content    unchanged
commits    167 → 167
revisions  741 → 741
```

The deploy carried the complete source package — six `--test` entries, the
whole of `packages/patterns/topics/*.test.tsx` — which the first rehearsal
listed among the things it did not cover:

```
$ cf piece setsrc --cell "$BOARD" packages/patterns/topics/main.tsx --root "$REPO" \
    --test …/topics.test.tsx --test …/naming.test.tsx --test …/multi-user.test.tsx \
    --test …/render-shape.test.tsx --test …/topics-rejections.test.tsx \
    --test …/view-identity.test.tsx \
    --dangerously-allow-incompatible-schema
wrote to space graft-rerun
Committed source update for piece fid1:2cz27KUxVbq9sO19J6fkG_G0H4CfUnhaopw4udwjEHM (Pattern Ref: cf:module/66CmHEvcyTfppRFstfeUuTFnFM3DJ0IPd6vM6vjaDac#default, Revision: 58166910-b33d-4b60-8606-2691451901ee)
```

Exit zero, 15.5 s wall. The verdict, strict and again with
`--expect-migration`, which printed the same block:

```
baseline   intact
removed    0
changed    7  (5 owned-cell, 1 piece, 1 free-cell)
added      111
content    CHANGED
commits    167 → 196
revisions  741 → 915
```

Churn over the deploy and the minute after it, `--bucket 60`:

```
2026-09-06 07:30:00	 29 commits	174 revisions
2026-09-06 07:31:00	  0 commits	0 revisions
```

**The authored-content check, which is the one `--expect-migration` cannot do.**
The per-entity fingerprint diff against the pristine snapshot names all seven:

```
free-cell	of:fid1:MscuyM1Fu6C0-R_lMStp2nxPWJA2dmO0xdqjrnGMYxI
owned-cell	computed:fid1:i4ZalHeHb337sViE2wiIW34dBbroXoPTovKvc5OqcHA
owned-cell	of:fid1:b0fYSlQ-xsKvh7wH-QHo0t3OObzDzO2PKd9t9cyCzwc
owned-cell	of:fid1:N3Vh4v1lXM44HYZs2AyfejeTsdOrlIGZU2RiMg2W8UU
owned-cell	of:fid1:r4omHfXbUOtoPW4MjZkLJdeD5DDaoQJQTVY4bYlrINY
owned-cell	of:fid1:XerVoLrsD0mNSKAo1aMA-Av1N2rFjajN1tlg86uw8BE
piece	of:fid1:2cz27KUxVbq9sO19J6fkG_G0H4CfUnhaopw4udwjEHM
```

`of:fid1:XerVo…` is the board's ARGUMENT cell, and what the deploy did to it is
one added key:

```
$ cf inspect diff "$DB" of:fid1:XerVo… --from 122
diff of:fid1:XerVoLrsD0mNSKAo1aMA-Av1N2rFjajN1tlg86uw8BE  (122 → latest)
  + names: {}
```

Nothing else in that document moved: the diff from its last pre-deploy revision
reports that key and nothing more. So the forced board deploy's whole effect on
the board's durable authored state is `names: {}`.

The lone changed `free-cell` is a rendered view node, and it is worth naming
because the procedure says to investigate one:

```
$ cf inspect value-at "$DB" of:fid1:Mscuy… --seq 22
{
  "children": [],
  "name": "cf-empty-state",
  "props": {
    "message": "No topics yet. Start the first one below."
  },
  "type": "vnode"
}
$ cf inspect value-at "$DB" of:fid1:Mscuy…
null
```

Reads afterwards, on the migrated board:

```
$ cf cell get --cell "$BOARD" topicCount --step
3
$ cf cell get --cell "$BOARD" index --step --select 'title,shortName,commentCount'
[
  { "commentCount": 0, "title": "Legacy topic A" },
  { "commentCount": 0, "title": "Legacy topic B" },
  { "commentCount": 0, "title": "Legacy topic C" }
]
$ cf cell get --cell "$TOPIC" body --input     # once per Topic
"body of A"
"body of B"
"body of C"
```

**The procedure document's kind tally does not read this store the way it
says.**
[`../../development/space-clone-rehearsal.md`](../../development/space-clone-rehearsal.md)
says argument cells "are not owned by a piece and land here [`free-cell`], so a
changed one is a clobber rather than a migration." Two halves of that fail
here. Every one of this clone's four argument cells is classified `owned-cell`,
so the tally hides them; and the single changed `free-cell` is a derived view
node that legitimately went to null, so the tally raises an alarm about it.
What found the truth was diffing each argument cell by name — resolved through
`cf inspect piece`, exactly as the document says to — rather than reading the
kinds. No run here established why the classification differs from the
document.

## Finding 3 — the #6990 transition cost, measured on a pre-graft clone

The topic leg, checked before it was forced. First the control the first
rehearsal recorded: the pre-graft `topic.tsx` — the same file the board's
`addTopic` created these Topics from — over one of them.

```
$ cf piece setsrc --check --cell "$TA" …/pregraft/topic.tsx --root …/pregraft
…/pregraft/topic.tsx cannot replace the source for piece fid1:MY1hlV9P4dSvnc4IsBHVfgcMycsUw6V9NAwaF0yaB_0:
piece source is incompatible with retained input: input link at mentionable schema is not compatible: input link at mentionable[].piece: newly required argument field has no default
```

That refusal is still here. It attaches to a CANDIDATE that declares
`mentionable` writable, which the pre-graft source does
(`mentionable?: Writable<TopicMentionable[] | Default<[]>>`, `topic.tsx` at
`5fd6cce7c7`). The current source declares
`mentionable?: ReadonlyCell<TopicMentionable[] | Default<[]>>`
(`packages/patterns/topics/topic.tsx`), and over the same Topic it reports
something else:

```
$ cf piece setsrc --check --cell "$TA" packages/patterns/topics/topic.tsx --root "$REPO"
packages/patterns/topics/topic.tsx cannot replace the source for piece fid1:MY1hlV9P4dSvnc4IsBHVfgcMycsUw6V9NAwaF0yaB_0:
Pattern schemas are not backward compatible:
- argument.mentionable: asCell changed
```

So #6990's replacement cost, measured once by its author on a fresh store, is
what a genuine pre-graft clone reports too. The older blocker is not gone from
the world; it is gone from the path a migration takes, and it is still what a
Topic left on pre-graft source is held to.

**One forced update per Topic, and what each costs.** Counts are `cf space
verify` immediately before and immediately after each single command:

| Topic | commits | revisions | added | changed | wall |
| --- | --- | --- | --- | --- | --- |
| A | 203 → 214 | 944 → 1042 | +10 | +2 | 1.19 s |
| B | 214 → 225 | 1042 → 1136 | +6 | +2 | 1.32 s |
| C | 225 → 236 | 1136 → 1230 | +6 | +2 | 1.24 s |

Eleven commits and about ninety-five revisions each, `removed 0` throughout.
The first added ten entities and the other two added six; no run here
attributed the difference. What each wrote into its Topic's argument document
is one key:

```
diff of:fid1:5AolZAculFDcxqYkHZTO6UMxPmSAo6RoSzoxA6-2c04  (32 → latest)
  + boardNames: [0]

diff of:fid1:iAMIggyBsc1OmpE2D48UOz_Dj4vVXMEXGT1XhgGRCm8  (77 → latest)
  + boardNames: [0]

diff of:fid1:l4f2HUA0VXPjf1g2J_fCPGLxFLmdaoxW5cKPNK6gAnc  (122 → latest)
  + boardNames: [0]
```

That is `boardNames` arriving as a durably written empty array, not as a
defaulted absence. It corroborates with a mechanism the audit rule
`skills/topics/SKILL.md` already states — read the VALUE, never the keys — and
it sharpens it: after step 2 the key is present in the stored document, so a
key-presence check answers yes for every migrated Topic whether or not it has
been bound.

Titles and bodies after all four forced updates:

```
fid1:MY1hl…  title="Legacy topic A"  body="body of A"
fid1:zB92…   title="Legacy topic B"  body="body of B"
fid1:YRns…   title="Legacy topic C"  body="body of C"
```

## Finding 4 — the gap and the link-bind, on the forced clone

The gap reproduces on a board that was genuinely migrated rather than
assembled. Before any bind:

```
$ cf cell get --cell "$TA" shortName --step
Cannot read piece result at "shortName": stored data is present, but its schema could not resolve all required values. The piece was stepped, but the required value still did not materialize.
```

`backfillNames`, once, through the board:

```
{
  "invocation": "rerun-backfill-1",
  "status": "settled",
  "receipt": "/of:fid1:YlNxGks5oda36jKfX538VHppGfkRPG8U2uYxksuSFxk",
  "result": { "assigned": [ "1", "2", "3" ] }
}
```

and the map it wrote, read out of the board's argument document rather than
through the pattern — this is the durable evidence of #6987, and it is what the
first rehearsal had no way to see:

```
[
  {"name":"1","member":"of:fid1:MY1hlV9P4dSvnc4IsBHVfgcMycsUw6V9NAwaF0yaB_0"},
  {"name":"2","member":"of:fid1:zB92OJBKdC4t8cu8WKBtX-pXI--dzTe0F4W4FAnd-38"},
  {"name":"3","member":"of:fid1:YRns-lbzx9QKDUN8LJKyGAwnNmc1V82H6A0Zo2Nvonk"}
]
```

Each entry names a Topic PIECE. The board's `topics` array at the same moment
holds `of:fid1:rSBG…`, `of:fid1:Z-kah…`, `of:fid1:UW7I…` — different documents
— so no entry is an address into the list.

The binds, one per Topic, with a control left unbound between the first and the
rest:

```
$ cf piece link "$BOARD/namesTable" "$TA/boardNames"
Linked fid1:2cz27KUxVbq9sO19J6fkG_G0H4CfUnhaopw4udwjEHM/namesTable to fid1:MY1hlV9P4dSvnc4IsBHVfgcMycsUw6V9NAwaF0yaB_0/boardNames
$ cf cell get --cell "$TA" shortName --step
"1"
$ cf cell get --cell "$TB" shortName --step
Cannot read piece result at "shortName": stored data is present, but its schema could not resolve all required values. The piece was stepped, but the required value still did not materialize.
```

After all three: `A: "1"`, `B: "2"`, `C: "3"`. Each bind cost six commits and
six revisions, and 0.92 s, 0.81 s and 0.89 s of wall time — measured by `cf
space verify` bracketing the single command. The first rehearsal reported one
commit and one revision per bind, measured differently (`cf inspect churn
--bucket 5` over a bracketing window on a freshly deployed piece); the two
numbers are not comparable and neither was re-measured the other's way.

What the bind writes is the replacement of that empty array with a link:

```
$ cf inspect value-at "$DB" of:fid1:5AolZ… --json | jq -c '.value.boardNames'
{"$link":{"id":"of:fid1:2cz27KUxVbq9sO19J6fkG_G0H4CfUnhaopw4udwjEHM","path":["namesTable"]}}
```

A second `backfillNames` returns `{"assigned": []}` and leaves the map
identical. It is not free: the call itself moved the store by one commit and
one revision (450 from 449). No run here attributed that commit, and nothing
about the names map changed.

Member addressing, after `cf piece set-slug top "$BOARD/names"`:

| address | result |
| --- | --- |
| `cf cell get /top/1 title` | `"Legacy topic A"` |
| `cf cell get /top/2 title` | `"Legacy topic B"` |
| `cf cell get /top/3 title` | `"Legacy topic C"` |
| `cf cell get /@graft-rerun/top/2 title` | `"Legacy topic B"` |
| `cf cell get //graft-rerun/top/2 title` | `Target must include a piece handle, e.g. "/of:fid1:abc123/path".` |
| `cf cell get //did:key:z6Mkppj…/top/2 title` | same refusal |
| `cf cell get /top/4 title` | `no member 4 in top` |
| `cf cell get /top title` | `no member title in top` |

Identical to the first rehearsal's table, including the `//<space>/…` spelling
still not being accepted for either a space name or a DID.

## Finding 5 — the removal case, and a control that can fail

**No deployed verb removes a member.** Neither `packages/patterns/topics/main.tsx`
nor the exemplar `packages/patterns/collection-naming/board.tsx` publishes one;
the removals in `board.test.tsx` are `items.removeByValue(items.key(n))` inside
test actions. Three routes were tried on the Topics board and all three were
refused, which is why this finding runs on a purpose-built instrument instead:

```
$ cf cell set --cell "$BOARD" topics --input   # shortened array, links to the member cells
Error: input link at topics.0 schema is not compatible: source has no durable schema contract

$ cf cell set --cell "$BOARD" topics --input   # shortened array, links to the Topic pieces
Error: input link at topics.0 schema is not compatible: input link at topics.0.$NAME: a schema alternative accepted previously is not accepted by the candidate

$ cf piece link "$TC" "$BOARD/topics/0"
Target path "topics/0" does not exist on piece fid1:2cz27KUxVbq9sO19J6fkG_G0H4CfUnhaopw4udwjEHM

Use --allow-non-existing to link anyway.
```

The last suggestion was not taken; #6965 is what it costs.

**The instrument.** Two boards were deployed into the same clone. Each is a
reduced copy of the collection-naming exemplar — its `addItem`, `backfillNames`
and index over `packages/patterns/collection-naming/item.tsx`, without the
mention universe or the body — plus one verb the exemplar has no equivalent of,
`removeItem`, which drops the member at a position. The two differ in exactly
one function: the first calls `backfillNames` from
`packages/patterns/collection-naming/naming.ts`, and the second calls a locally
vendored copy of the pre-#6987 walk — `members.key(index)` where the current one
has `members.key(index).resolveAsCell()`. The second is the negative control,
and it exists so that a passing result on the first means something. Neither
file is in the tree; both lived in the throwaway worktree the rehearsal ran
from.

Four items were filed on each, the names map was cleared so the backfill had to
write every entry, and `backfillNames` was run once. The two maps, read out of
the boards' argument documents:

```
fixed:    [{"name":"1","member":"of:fid1:jnV6yGi…"},{"name":"2","member":"of:fid1:a3-Smcc…"},
           {"name":"3","member":"of:fid1:KDGN9St…"},{"name":"4","member":"of:fid1:Gflqq-v…"}]

control:  {"1":{"$link":{"path":["items","0"],…}},"2":{"$link":{"path":["items","1"],…}},
           "3":{"$link":{"path":["items","2"],…}},"4":{"$link":{"path":["items","3"],…}}}
```

The fixed board's entries name item PIECES; the control's name list positions.
That is the defect, on disk, in one line.

Both boards then had the member at position 0 removed, through the same verb,
in the same store, minutes apart. Reading each board's namespace through its
own slug — `rb` for the fixed board, `sb` for the control:

| address | fixed board (`/rb/<n>`) | control (`/sb/<n>`, pre-#6987 walk) |
| --- | --- | --- |
| `/…/1` | `"Item one"` | `"Slot item two"` |
| `/…/2` | `"Item two"` | `"Slot item three"` |
| `/…/3` | `"Item three"` | `"Slot item four"` |
| `/…/4` | `"Item four"` | `"sb/4" does not name a piece.` |

On the fixed board every surviving name still resolves to its own member, and
the departed member is still reachable by the name it was given. On the control
every name has moved one member up the list and the last name resolves to
nothing at all. That is the property #6987 fixed, exercised against a served
store rather than in a pattern unit test, with a control beside it that fails.

Each member's own `shortName`, read from the member rather than the board, says
the same thing:

```
fixed:    name 1 -> title="Item one"   shortName="1"
          name 2 -> title="Item two"   shortName="2"
          name 3 -> title="Item three" shortName="3"
          name 4 -> title="Item four"  shortName="4"

control:  one    shortName=null
          two    shortName="1"
          three  shortName="2"
          four   shortName="3"
```

## Finding 6 — a board's index read can be stale, and reading it twice does not help

On the control board, immediately after the removal, `index --step` was read
twice. Both reads returned the same three rows and both were wrong:

```
[
  { "shortName": "2", "title": "Slot item two" },
  { "shortName": "3", "title": "Slot item three" },
  { "shortName": "4", "title": "Slot item four" }
]
```

Each member was then stepped individually — the reads quoted at the end of
Finding 5 — and the same board read, unchanged, third time:

```
[
  { "shortName": "1", "title": "Slot item two" },
  { "shortName": "2", "title": "Slot item three" },
  { "shortName": "3", "title": "Slot item four" }
]
```

The only commands between the second board read and the third were those
per-member reads. So a `--step` read of the board does not step its members,
and a member's `shortName` on the board's index can be behind what the member
itself would report. The first rehearsal's rule — read
twice before concluding a bind failed — does not cover this: two identical
reads were both stale, and what moved the value was stepping the member. The
fixed board's index was read three times across the same sequence and returned
`2, 3, 4` every time.

No run here attributed the staleness to a mechanism.

The operational consequence is worth stating plainly, because it is what makes
this defect class expensive: **the badge does not reveal the defect.** On the
control board the index showed correct-looking names for two full reads while
`/…/1` was already resolving to the wrong member. Only the address, and the
member's own read, tell the truth.

## Finding 7 — `setsrc --check` writes only when the candidate is new

The first rehearsal established that `setsrc --check` writes to the store
(#6964) and measured one refused check at 18 entities and two commits without
attributing them. Two measurements here narrow that.

On the clone, the pair of checks in Finding 1 — one accepted over the piece's
own already-stored source, one refused over a source the store had never seen —
moved the baseline together:

```
baseline   intact
removed    0
changed    0
added      18
content    CHANGED
commits    167 → 169
revisions  741 → 759
```

Attribution came from a separate experiment on a different piece in the same
store, one command at a time, counting with `cf space verify` between:

- `--check` of the piece's own current source: `commits 167 → 448`,
  `added 578` — unchanged, zero writes.
- `--check` of a different source that had already been deployed elsewhere in
  the space: unchanged again, zero writes.
- `--check` of a source that differed from the first by one string literal, so
  its compiled module set was new: `commits 448 → 449`, `added 578 → 586`.

So what a check costs is the compiled module set it has to store, and a check
whose candidate is already in the space's content store costs nothing. The pair
measurement on the clone is consistent with the refused check having paid all
of it. That consistency is an inference from the second experiment, not a
separate measurement of the board.

The practical form: a clone is spent by a check of a source it has not seen
before, not by every check.

## Finding 8 — the invocation-session requirement is not in the quoted procedure

`skills/topics/SKILL.md` quotes the backfill as

```bash
cf piece call --cell "$TOPICS_BOARD" --invocation '<id>' backfillNames \
  '{"agentName":"Sol"}'
```

Run as written with no session in the environment, this build answers:

```
--invocation names an id to replay, and an id is replayable only within the session it was chosen in. Mint a session with `cf invocation-session new` and set `CF_INVOCATION_SESSION`, or pass it as `--invocation-session <id>`.
```

The message is self-explanatory and the fix is one command, so this is a gap in
a quoted procedure rather than a defect. Two smaller shapes cost time the same
way: `--json` and `--quiet` are parsed inside the callable's own section when
they follow the callable name, so `--quiet` has to precede it, and a positional
JSON argument beside a trailing flag is rejected as `Unexpected argument`.

## Final state of the clone

After the board deploy, three Topic deploys, two backfills, three binds, one
slug, and the instrument boards:

```
baseline   intact
removed    0
changed    18  (11 owned-cell, 4 piece, 2 module, 1 free-cell)
added      633
content    CHANGED
commits    167 → 467
revisions  741 → 1933
```

Churn settles: the last commit is at `07:44` and the window observed through
`07:45` reports that minute at zero. The peak minute is 56 commits, which is
not a plateau.

## What this rehearsal did not cover

- **Whether the Estuary deployment's own vintage refuses the same way.** It
  runs an older commit than the source here and the retained-link schemas it
  holds were written by that commit. `cf piece setsrc --check` against the
  deployment is the one-command answer and it belongs to whoever is authorized
  to touch Estuary. Unchanged from the first rehearsal.
- **A removal on the Topics board itself.** No deployed verb performs one, and
  three attempts to produce one by hand were refused (Finding 5). The property
  was established on an instrument board built for it, with a control; whether
  the Topics board's own member shape changes anything is untested.
- **The Topic source package.** The board was deployed with all six authored
  tests attached; the three Topic updates were not, because a board-composed
  child carries no test package of its own. What a `--test`-carrying Topic
  deploy would cost is unmeasured.
- **Scale.** Three Topics, not 125. The per-Topic costs above are what a board
  the size of the Estuary one would multiply, and the bulk-CLI shape
  [`../topics-board-migration-2026-08-28.md`](../topics-board-migration-2026-08-28.md)
  found unreliable from a laptop is unchanged by anything here.
- **Anything about the deployment rather than the store**: shell bundle, CDN,
  and concurrent human traffic are all absent from a clone.
- **The two consecutive clean passes** the procedure requires before going
  live. This run made one pass, plus one earlier pass that was reset.
