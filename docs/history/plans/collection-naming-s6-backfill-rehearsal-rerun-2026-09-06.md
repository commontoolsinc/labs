---
status: historical
created: 2026-09-06
archived: 2026-09-06
reason: "Record of the second clone rehearsal of S6 item 4, run after #6987 and #6990: what a forced deploy left behind on a pre-graft clone, what the #6990 transition cost three deployed Topics, and the removal case run on a purpose-built instrument with a control that fails."
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

Every command quoted was run and every fenced block is real output. Two kinds
of trim are used and are named at the point of use: a JSON envelope longer than
the field carrying the finding, and a repeated line elided from a loop's output
with the elision stated. Where a number appears in prose or a table, the output
it was read from is quoted beside it.

The first rehearsal's convention about mechanisms is kept: where a passage says
WHY something happened, the reason is read from the named source file and cited
there, and no run attributed an observation to it. Where this record has an
observation and no mechanism, it says so at that observation.

One further rule, added after two rounds of review found conclusions standing
wider than the output beside them: a sentence here reports what a quoted block
shows, and where it does not, it names what is not isolated. Several sentences
earlier drafts carried have been deleted rather than qualified.

## The headline

On the pre-graft clone the Setup describes, forcing the board and its three
Topics past the schema refusals reported `removed 0` in every `cf space verify`
this run took, 29 commits for the board and 11 per Topic, and one added key in
each of four argument documents:
`names: {}` on the board and `boardNames: []` on each Topic. The board's
`topicCount` and index were read before the deploy and after it and returned
the same three rows and the same three titles; the three bodies were read
after. Those reads are what any authored-content claim here rests on — the
fingerprint tally cannot make one, and Finding 2 says why.

The removal case passes on a board built to exercise it, and a negative control
carrying the pre-#6987 walk fails in the same store: on the fixed board every
surviving name still resolves to its own member, and on the control name `1`
follows the slot to whoever shifted into it while name `4` stops resolving at
all. The removal could not be produced on the Topics board itself, so the
instrument and its control are what carry this, and Finding 5 quotes the whole
of what separates them.

A trap the first rehearsal's list does not carry. On the control board an
`index --step` read reported `shortName` values that the members themselves no
longer reported: two consecutive board reads agreed with each other and
disagreed with the members, and the third — after each member had been stepped
by its own read — agreed with them. Reading the board twice is not what
resolved it.

## Setup

One store this time. The first rehearsal built a second, assembled one
"because the deploy that would reach it was refused on the first store"; here
the deploy was forced and the first store carried the whole run.

**The pre-graft clone.** A board deployed from the pre-graft `main.tsx`, three
Topics filed through *its* `addTopic` rather than unwired by hand — which is
what "pre-graft" means everywhere below — then snapshotted with `VACUUM INTO`
and cloned:

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
was written. Two lines of a six-line banner:

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

The board is `fid1:2cz27…`, from `cf piece new`. The three Topics are called A,
B and C below, after the titles their pieces read back:

```
$ cf cell get --cell "$TOPIC" title --input     # once per piece
fid1:MY1hlV9P4dSvnc4IsBHVfgcMycsUw6V9NAwaF0yaB_0 -> "Legacy topic A"
fid1:YRns-lbzx9QKDUN8LJKyGAwnNmc1V82H6A0Zo2Nvonk -> "Legacy topic C"
fid1:zB92OJBKdC4t8cu8WKBtX-pXI--dzTe0F4W4FAnd-38 -> "Legacy topic B"
```

The three piece ids came from `cf inspect entities`, whose `pattern:` line for
each is `/topic.tsx`; filing order is A, B, C and the id order above is not.

## Finding 1 — the deploy is still refused, and the checker still accepts a known-good source

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

Verbatim the message the first rehearsal recorded, at a different repository
commit — that record states `63de1a1e8c` and this one runs at `a8f9d0874e`; no
run here measured the distance between them. That rehearsal established with
two probes that the refusal is general to any new per-member demand property
rather than particular to `shortName`; those probes were not re-run here and
nothing in this run contradicts them.

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

The board's own reads at that point, so there is a before to compare the after
against — this is the pre-graft source running, and `shortName` is not in its
index rows:

```
$ cf cell get --cell "$BOARD" topicCount --step
3
$ cf cell get --cell "$BOARD" index --step
[
  { "commentCount": 0, "createdAt": 1788679532000,
    "createdBy": { "kind": "agent", "name": "Rerun" },
    "lastActivityAt": 1788679532000, "title": "Legacy topic A" },
  { "commentCount": 0, "createdAt": 1788679534000,
    "createdBy": { "kind": "agent", "name": "Rerun" },
    "lastActivityAt": 1788679534000, "title": "Legacy topic B" },
  { "commentCount": 0, "createdAt": 1788679537000,
    "createdBy": { "kind": "agent", "name": "Rerun" },
    "lastActivityAt": 1788679537000, "title": "Legacy topic C" }
]
```

Each row is shown on three lines here; the command printed one field per line.

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

with the loop's own instrumentation around that single command reporting

```
setsrc exit=0
wall seconds: 15.546458000
```

The verdict, strict and again with `--expect-migration`, which printed the same
block:

```
baseline   intact
removed    0
changed    7  (5 owned-cell, 1 piece, 1 free-cell)
added      111
content    CHANGED
commits    167 → 196
revisions  741 → 915
```

Two buckets out of a longer `--bucket 60` run — the deploy's minute and the one
after it. The whole window is quoted under "Final state of the clone":

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

`of:fid1:XerVo…` is the board's ARGUMENT cell, resolved from the `input:` line
of `cf inspect piece`. Its revision history picks the seq to diff from:

```
$ cf inspect history "$DB" of:fid1:XerVo…
seq=10	commit=10	set	z6MkgQ…8nyU/10b442c1	local=9	2026-09-06 07:24:41
seq=32	commit=32	patch	z6MkgQ…8nyU/d7c71407	local=1	2026-09-06 07:25:32
seq=77	commit=77	patch	z6MkgQ…8nyU/8edf7a2d	local=2	2026-09-06 07:25:35
seq=122	commit=122	patch	z6MkgQ…8nyU/307c10ed	local=2	2026-09-06 07:25:37
seq=171	commit=171	patch	z6MkgQ…8nyU/34eacdb9	local=4	2026-09-06 07:30:54
```

By the timestamps in that block, `122` at 07:25:37 is the newest write before
the deploy and `171` at 07:30:54 the only one after it; the verify quoted above
puts the store at `commits 167 → 167` immediately before the deploy ran. So
`--from 122` spans the deploy:

```
$ cf inspect diff "$DB" of:fid1:XerVo… --from 122
diff of:fid1:XerVoLrsD0mNSKAo1aMA-Av1N2rFjajN1tlg86uw8BE  (122 → latest)
  + names: {}
```

One added key and no other line. What that bounds is this document: across the
deploy, the board's argument gained `names: {}` and nothing else in it moved.
It says nothing about the other six changed entities, which the list above
names and the paragraphs below take separately.

The lone changed `free-cell`, which the procedure document says to investigate,
holds a rendered view node at the seq its history gives for the clone's
baseline and `null` at its latest:

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
here. The board's argument cell is in the list above as `owned-cell`, not as a
`free-cell`, so an operator reading the tally for a changed `free-cell` does
not see it; and the one changed `free-cell` is not an argument cell at all but
the view node quoted above, so reading the tally that way points at it. Whether
that view node going to `null` is right, and whether the entity still matters,
is not something any run here settles. The other three argument cells are
classified the same way once they move, which the annotated list under "Final
state of the clone" below shows.
What separated the two cases here was diffing each argument cell by name —
resolved through `cf inspect piece`, exactly as the document says to — rather
than reading the kind tally. No run here established why the classification
differs from the document.

## Finding 3 — what the #6990 transition cost these three Topics

The topic leg, checked before it was forced. First the control the first
rehearsal recorded: the pre-graft `topic.tsx` — the same file the board's
`addTopic` created these Topics from — over one of them.

```
$ cf piece setsrc --check --cell "$TA" …/pregraft/topic.tsx --root …/pregraft
…/pregraft/topic.tsx cannot replace the source for piece fid1:MY1hlV9P4dSvnc4IsBHVfgcMycsUw6V9NAwaF0yaB_0:
piece source is incompatible with retained input: input link at mentionable schema is not compatible: input link at mentionable[].piece: newly required argument field has no default
```

That refusal is still here, for this candidate over this Topic. The candidate
is the pre-graft source, which declares
`mentionable?: Writable<TopicMentionable[] | Default<[]>>` (`topic.tsx` at
`5fd6cce7c7`); whether the refusal follows from that declaration, or from
something else the two sources also differ in, is not separated by any run
here — one candidate was checked, not a series varying one property. The
current source declares
`mentionable?: ReadonlyCell<TopicMentionable[] | Default<[]>>`
(`packages/patterns/topics/topic.tsx`), and over the same Topic it reports
something else:

```
$ cf piece setsrc --check --cell "$TA" packages/patterns/topics/topic.tsx --root "$REPO"
packages/patterns/topics/topic.tsx cannot replace the source for piece fid1:MY1hlV9P4dSvnc4IsBHVfgcMycsUw6V9NAwaF0yaB_0:
Pattern schemas are not backward compatible:
- argument.mentionable: asCell changed
```

Two blocks, two messages, one Topic: the older refusal answers the pre-graft
candidate and the `asCell changed` refusal answers the current one. So the
older blocker is not absent from this store — it is what a Topic left on
pre-graft source is still held to — and it is not what stands in the way of
moving that Topic forward.

**One forced update per Topic, and what each costs.** The three were forced by
one loop that ran `cf space verify` immediately before and immediately after
each single command and printed its counts. Its output, with the three
`Committed source update …` lines elided:

```
before-any-topic: removed 0 changed 9  (5 owned-cell, 2 module, 1 piece, 1 free-cell) added 132 commits 167 → 203 revisions 741 → 944
--- TA exit=0 wall=1.192797000s
after-TA: removed 0 changed 11  (6 owned-cell, 2 piece, 2 module, 1 free-cell) added 142 commits 167 → 214 revisions 741 → 1042
--- TB exit=0 wall=1.318465000s
after-TB: removed 0 changed 13  (7 owned-cell, 3 piece, 2 module, 1 free-cell) added 148 commits 167 → 225 revisions 741 → 1136
--- TC exit=0 wall=1.238639000s
after-TC: removed 0 changed 15  (8 owned-cell, 4 piece, 2 module, 1 free-cell) added 154 commits 167 → 236 revisions 741 → 1230
```

which reads as:

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

`[0]` is how this renderer writes a zero-length array; the same notation
labels three-element lists as `[3]` in the `cf inspect entities` output quoted
under "Final state of the clone", and writes an object's keys as
`{topics, names}`. Read that way, the forced update wrote the `boardNames` key
into each of these three argument documents with an empty array in it, rather
than leaving the key absent to be defaulted.

That is the same direction as the audit rule `skills/topics/SKILL.md` already
states — read the VALUE, never the keys — for these three Topics. Whether every
Topic a forced update touches acquires the key this way is not established
here; three did.

Titles and bodies after all four forced updates:

```
fid1:MY1hl…  title="Legacy topic A"  body="body of A"
fid1:zB92…   title="Legacy topic B"  body="body of B"
fid1:YRns…   title="Legacy topic C"  body="body of C"
```

## Finding 4 — the gap and the link-bind, on the forced clone

The gap reproduces on the board this rehearsal migrated, rather than on one
assembled to the post-deploy shape. Before any bind:

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
through the pattern, each entry projected to the id its link carries:

```
$ cf inspect value-at "$DB" of:fid1:XerVo… --json \
    | jq -c '.value.names | to_entries | map({name:.key, member:.value["$link"].id})'
[
  {"name":"1","member":"of:fid1:MY1hlV9P4dSvnc4IsBHVfgcMycsUw6V9NAwaF0yaB_0"},
  {"name":"2","member":"of:fid1:zB92OJBKdC4t8cu8WKBtX-pXI--dzTe0F4W4FAnd-38"},
  {"name":"3","member":"of:fid1:YRns-lbzx9QKDUN8LJKyGAwnNmc1V82H6A0Zo2Nvonk"}
]
```

Those three ids are the Topic pieces named at the top of this record. The same
read without the projection, so the entries' whole form is visible:

```
$ cf inspect value-at "$DB" of:fid1:XerVo…
…
  "names": {
    "1": {
      "$link": {
        "id": "of:fid1:MY1hlV9P4dSvnc4IsBHVfgcMycsUw6V9NAwaF0yaB_0",
        "schema": {
          "$ref": "cid:fid1:I9RSbRt--3BpBFbBMdeXzjVslRErkGmYCQNawswrrKg"
        }
      }
    },
    "2": {
      "$link": {
        "id": "of:fid1:zB92OJBKdC4t8cu8WKBtX-pXI--dzTe0F4W4FAnd-38",
        "schema": {
          "$ref": "cid:fid1:I9RSbRt--3BpBFbBMdeXzjVslRErkGmYCQNawswrrKg"
        }
      }
    },
    "3": {
      "$link": {
        "id": "of:fid1:YRns-lbzx9QKDUN8LJKyGAwnNmc1V82H6A0Zo2Nvonk",
        "schema": {
          "$ref": "cid:fid1:I9RSbRt--3BpBFbBMdeXzjVslRErkGmYCQNawswrrKg"
        }
      }
    }
  }
}
```

The `…` above stands for the `topics` array printed ahead of `names` in the
same document, which the next block reads on its own. Inside `names` nothing is
elided: each entry is an `id` and a `schema` `$ref`, and no entry carries a
`path`.

The board's `topics` array holds three different documents:

```
$ cf cell get --cell "$BOARD" topics --input --schema '{"type":"array","items":{"$link":true}}'
[
  {
    "$link": "/of:fid1:rSBGbIfQ-Oz0j_5589jMzS3gQ7CswRH1ok2dJlo4vM8"
  },
  {
    "$link": "/of:fid1:Z-kahKGwF5q3VGcExpHdgtfZ7x-HcmTWCPBLvy7X1Lw"
  },
  {
    "$link": "/of:fid1:UW7IAX7wV32aHaRb66yiU3mTzMsSccweFWRbVa95ERk"
  }
]
```

So the three names point at documents that are not the three the list holds,
and each name's entry addresses its document by `id`. Finding 5's control
quotes the other form, an entry addressing a position by `path`.

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

After all three binds, each Topic read from itself:

```
A: "1"
B: "2"
C: "3"
```

The same bracketing loop around the binds, with the three `Linked …` lines
elided:

```
before bind: commits 167 → 254 revisions 741 → 1285
bind TA wall=.917068000s
after bind TA: commits 167 → 260 revisions 741 → 1291
before TB: commits 167 → 263 revisions 741 → 1294
bind TB wall=.813192000s
after TB: commits 167 → 269 revisions 741 → 1300
before TC: commits 167 → 269 revisions 741 → 1300
bind TC wall=.891357000s
after TC: commits 167 → 275 revisions 741 → 1306
```

Six commits and six revisions per bind, and 0.92 s, 0.81 s and 0.89 s of wall
time. Three commits fall between `after bind TA` and `before TB`, outside every
bind's brackets; the only commands run in that gap were the two `shortName`
reads quoted above, and nothing here attributes the commits to them. The first
rehearsal reported one commit and one revision per bind, measured differently
(`cf inspect churn --bucket 5` over a bracketing window on a freshly deployed
piece); the two numbers are not comparable and neither was re-measured the
other's way.

What the bind writes is the replacement of that empty array with a link:

```
$ cf inspect value-at "$DB" of:fid1:5AolZ… --json | jq -c '.value.boardNames'
{"$link":{"id":"of:fid1:2cz27KUxVbq9sO19J6fkG_G0H4CfUnhaopw4udwjEHM","path":["namesTable"]}}
```

A second `backfillNames`, same board, same verb:

```
  "result": {
    "assigned": []
  }
}
```

and the names map read the same way as before, afterwards:

```
[{"name":"1","member":"of:fid1:MY1hlV9P4dSvnc4IsBHVfgcMycsUw6V9NAwaF0yaB_0"},{"name":"2","member":"of:fid1:zB92OJBKdC4t8cu8WKBtX-pXI--dzTe0F4W4FAnd-38"},{"name":"3","member":"of:fid1:YRns-lbzx9QKDUN8LJKyGAwnNmc1V82H6A0Zo2Nvonk"}]
```

— the same three pairs the first backfill wrote. It is not free, bracketed the
same way:

```
before second backfill: commits 167 → 449 revisions 741 → 1873
after second backfill: commits 167 → 450 revisions 741 → 1874
```

One commit and one revision for a call that assigned nothing. No run here
attributed that commit.

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

**Neither board pattern publishes a verb that removes a member.** Read at
`a8f9d0874e`: `packages/patterns/topics/main.tsx` and the exemplar
`packages/patterns/collection-naming/board.tsx` declare none, and the removals
in `board.test.tsx` are `items.removeByValue(items.key(n))` inside test
actions. Three routes were then tried against the Topics board and all three
were refused, which is why this finding runs on a purpose-built instrument
instead:

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
`removeItem`, which drops the member at a position. The second is the negative
control, and it exists so that a passing result on the first means something.

Neither file is in the tree; both lived in the throwaway worktree the rehearsal
ran from, so the whole of what separates them is quoted here rather than
asserted. This is `diff -u board-with-remove.tsx board-slot-names.tsx`, entire:

```diff
@@ -1,13 +1,15 @@
 /**
- * A rehearsal instrument: the collection-naming exemplar board with one extra
- * verb, `removeItem`, which drops the member at a position so the list shifts
- * under the namespace. Nothing deployed has such a verb, and the removal case
- * is what this rehearsal has to reach at runtime rather than in a unit test.
+ * The negative control for the removal test: the same board as
+ * `board-with-remove.tsx`, except that its backfill stores the cell AT a list
+ * position instead of the member the position holds. That is the defect
+ * #6987 fixed, vendored here so the rehearsal can show its instrument
+ * distinguishes the two.
  */
 
 import {
   action,
   Default,
+  equals,
   NAME,
   pattern,
   Stream,
@@ -19,13 +21,34 @@
 import Item from "../packages/patterns/collection-naming/item.tsx";
 import {
   assignName,
-  backfillNames,
   type NamesMap,
+  type NamesMapCell,
   namesTable,
   type NamesTableRow,
+  nextNameAmong,
 } from "../packages/patterns/collection-naming/naming.ts";
 
-/** One row of the board's index. */
+/** The pre-#6987 walk: it names the POSITION, not the member in it. */
+function backfillNamesBySlot(
+  members: { get(): readonly unknown[]; key(index: number): object },
+  names: NamesMapCell,
+): string[] {
+  const map = names.get() ?? {};
+  const named = Object.values(map) as (object | undefined)[];
+  const count = members.get().length;
+  const written: string[] = [];
+  let next = nextNameAmong(Object.keys(map));
+  for (let index = 0; index < count; index++) {
+    const member = members.key(index);
+    if (named.some((other) => equals(member, other))) continue;
+    names.key(next).set(member);
+    written.push(next);
+    named.push(member);
+    next = String(Number(next) + 1);
+  }
+  return written;
+}
+
 export interface ItemIndexRow {
   title: string | Default<"">;
   createdAt: number;
@@ -58,15 +81,11 @@
   assigned: string[];
 }
 
-/** What `removeItem` takes: the position to drop. */
 export interface RemoveItemEvent {
-  /** Zero-based position in filing order. */
   position: number;
 }
 
-/** What `removeItem` returns. */
 export interface RemoveItemResult {
-  /** How many members the board holds afterwards. */
   remaining: number;
 }
 
@@ -116,7 +135,7 @@
       if (!(agentName ?? "").trim()) {
         reject("backfillNames", "agentName must be non-blank");
       }
-      return { assigned: backfillNames(items, names) };
+      return { assigned: backfillNamesBySlot(items, names) };
     },
   );
 
@@ -130,11 +149,11 @@
   });
 
   return {
-    [NAME]: `Items (${itemCount})`,
+    [NAME]: `Slot-named items (${itemCount})`,
     [UI]: (
       <cf-screen>
         <cf-vstack gap="2" padding="4">
-          <cf-heading level={3}>Items</cf-heading>
+          <cf-heading level={3}>Slot-named items</cf-heading>
           {items.map((item) => (
             <cf-card>
               <cf-hstack gap="3" align="center">
```

Read as a list of differences that is complete because the diff is: the control
drops the `backfillNames` import and adds `equals`, `NamesMapCell` and
`nextNameAmong`; it carries `backfillNamesBySlot`, which is the pre-#6987 walk
with `members.key(index)` where the current one has
`members.key(index).resolveAsCell()` and its own `incrementName` inlined as
`String(Number(next) + 1)`, since that helper is not exported; its `backfill`
action calls that function instead of the imported one; and it renames itself
in two display strings, `[NAME]` and the `cf-heading` text. Everything else —
the input and output types, `addItem`, `assignName`, `namesTable`,
`removeItem`, the index, the item pattern each composes — is character for
character the same. Three doc comments the first carries were not copied into
the second, which the diff also shows.

So this is not a one-difference claim. It is one behavioral difference plus two
display strings, and the vendored walk is a reconstruction of the pre-#6987
code rather than its bytes — `incrementName` is module-private in `naming.ts`,
so the copy spells that step itself.

**The display strings are not independently ruled out.** No run here varies the
walk while holding the strings fixed, or the reverse, so nothing separates
them. What the outputs below show is that two boards differing in both produce
different names maps, and that the difference in those maps is the one the
walk's code predicts. A reader who wants the strings excluded needs a run this
rehearsal did not make.

Four items were filed on each and the names map was cleared, so the backfill
had to write every entry. Each board's `backfillNames` returned:

```
fixed:    "result": { "assigned": [ "1", "2", "3", "4" ] }
control:  "result": { "assigned": [ "1", "2", "3", "4" ] }
```

The two maps came out of `cf inspect value-at "$DB" <argument> --json` on each
board, but through different `jq` projections — the fixed board's mapped to
name/member pairs, the control's raw — so the two blocks are not like for like
and the commands are shown with them. The control's is quoted whole, because
what matters about it is what it does not contain:

```
fixed, jq -c '.value.names | to_entries | map({name:.key, member:.value["$link"].id})':
[{"name":"1","member":"of:fid1:jnV6yGi…"},{"name":"2","member":"of:fid1:a3-Smcc…"},
 {"name":"3","member":"of:fid1:KDGN9St…"},{"name":"4","member":"of:fid1:Gflqq-v…"}]

control, jq -c '.value.names':
{"1":{"$link":{"path":["items","0"],"schema":{"$ref":"cid:fid1:_CJQcLZ-G5068agt9qCICu6jheJDyPzwYvhQxH6zgSk"}}},"2":{"$link":{"path":["items","1"],"schema":{"$ref":"cid:fid1:_CJQcLZ-G5068agt9qCICu6jheJDyPzwYvhQxH6zgSk"}}},"3":{"$link":{"path":["items","2"],"schema":{"$ref":"cid:fid1:_CJQcLZ-G5068agt9qCICu6jheJDyPzwYvhQxH6zgSk"}}},"4":{"$link":{"path":["items","3"],"schema":{"$ref":"cid:fid1:_CJQcLZ-G5068agt9qCICu6jheJDyPzwYvhQxH6zgSk"}}}}
```

Every control entry is a `path` and a `schema` `$ref` and nothing else — no
`id`, which is the field Finding 4's un-elided block shows the Topics board's
entries carrying. The member ids the fixed board's projection returns are
abbreviated in this record only; `of:fid1:jnV6yGi…` came back from
`cf inspect piece` as a piece running
`/packages/patterns/collection-naming/item.tsx`. The fixed board's raw map was
not read, so its entries are known to carry an `id` and are not shown to lack a
`path`; the Topics board's, in Finding 4, is the un-elided post-fix form.

Both boards then had the member at position 0 removed, through the same verb,
in the same store:

```
fixed:    "result": { "remaining": 3 }
control:  "result": { "remaining": 3 }
```

and on the fixed board the list before and after, so the shift is on the record
rather than assumed:

```
$ cf inspect value-at "$DB" <argument> --json | jq -c '.value.items | map(.["$link"].id)'
before:  ["of:fid1:uW-K-GK…","of:fid1:rb9dF2e…","of:fid1:1D04aDr…","of:fid1:g05jVnN…"]
after:   ["of:fid1:rb9dF2e…","of:fid1:1D04aDr…","of:fid1:g05jVnN…"]
```

The same before-and-after was not captured for the control; what stands for it
there is `remaining: 3` and the three-row index quoted in Finding 6. Reading
each board's namespace through its own slug — `rb` for the fixed board, `sb`
for the control:

| address | fixed board (`/rb/<n>`) | control (`/sb/<n>`, pre-#6987 walk) |
| --- | --- | --- |
| `/…/1` | `"Item one"` | `"Slot item two"` |
| `/…/2` | `"Item two"` | `"Slot item three"` |
| `/…/3` | `"Item three"` | `"Slot item four"` |
| `/…/4` | `"Item four"` | `"sb/4" does not name a piece.` |

On the fixed board every surviving name still resolves to its own member, and
the departed member is still reachable by the name it was given. On the control
every name has moved one member up the list and the last name resolves to
nothing at all. The maps above are where the walk's difference is visible on
disk; this table is where it is visible through an address. Neither isolates
the display strings.

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

## Finding 6 — two board index reads that disagreed with the members

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
per-member reads. So on this board a `--step` read of the board did not bring
its members' `shortName` values forward, and two such reads in a row agreed
with each other while disagreeing with what each member reported when stepped.
No run here shows this on another board or verb. The first rehearsal's rule —
read twice before concluding a bind failed — does not resolve this case:
repeating the board read is what did not move it.

The fixed board's index was read three times across the same sequence — once
after its removal, once beside the control's second read, once beside the
control's third — and returned the same three rows each time. All three:

```
first, right after the removal:
[
  { "shortName": "2", "title": "Item two" },
  { "shortName": "3", "title": "Item three" },
  { "shortName": "4", "title": "Item four" }
]

second:
[
  { "shortName": "2", "title": "Item two" },
  { "shortName": "3", "title": "Item three" },
  { "shortName": "4", "title": "Item four" }
]

third, in the same command as the control's third:
[
  { "shortName": "2", "title": "Item two" },
  { "shortName": "3", "title": "Item three" },
  { "shortName": "4", "title": "Item four" }
]
```

Three reads is what "did not move" means here; nothing was read between the
first and the removal.

No run here attributed the staleness to a mechanism.

What that costs an operator, bounded to what the blocks show: on the control
board the index carried `2, 3, 4` for two consecutive reads — the numbering the
board had before the removal — while `/sb/1` was already answering with the
wrong member. The third index read, after the members were stepped, agreed with
the members. On these reads the address disagreed before the badge did.

## Finding 7 — three checks, and which of them wrote

The first rehearsal established that `setsrc --check` writes to the store
(#6964) and measured one refused check at 18 entities and two commits without
attributing them. Two measurements here narrow that. Note before reading them
that "18 entities and two commits" appears twice in this section for two
different measurements — that record's single refused check, and this run's
pair of checks — and no run here connects the two figures.

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
store, one command at a time, counting with `cf space verify` between. First,
the piece's own current source and then a different source that had already
been deployed elsewhere in the space, with the two `… can replace the source
for piece …` lines elided:

```
before: added 578 commits 167 → 448 revisions 741 → 1865
after own-source check: added 578 commits 167 → 448 revisions 741 → 1865
after new-source check: added 578 commits 167 → 448 revisions 741 → 1865
```

Neither wrote anything, which is why the second is labelled with the source
being new to the PIECE rather than to the store. Then a source that differed
from the first by one string literal, so its compiled module set was new to the
store:

```
before: added 578 commits 167 → 448 revisions 741 → 1865
after check of a never-stored source: added 586 commits 167 → 449 revisions 741 → 1873
```

Three checks against one piece, then: the two whose candidates the store
already held moved nothing, and the one whose candidate was new to the store
cost one commit and eight entities. The pair measurement on the board is
consistent with the refused check there having paid all of that pair's two
commits and 18 entities, but no run separated the two checks on the board, so
that is an inference from these three checks rather than a measurement of the
board.

What these runs support, and no more: on this store a `--check` wrote when its
candidate's compiled module set was new to the space and did not write when it
was not. Whether that holds for candidates or spaces unlike these is untested.

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

The message names its own fix. What this records is that a command a live
document quotes does not run as quoted against this build; no run here
establishes which of the two should change. Two smaller shapes cost time the
same way. A flag after the callable name is parsed inside the callable's
own section, so `--quiet` there collides with the input:

```
$ cf piece call --cell "$BOARD" --invocation … backfillNames --json '{"agentName":"Rerun"}' --quiet
--json cannot be combined with generated flags
```

and a positional JSON value beside a trailing `--json` is not read as the
input:

```
$ cf piece call --cell "$BOARD" --invocation … addTopic '{"title":"Legacy topic A",…}' --json
Unexpected argument {"title":"Legacy topic A","body":"body of A","agentName":"Rerun"}
```

Both are answered by putting `--quiet` before the callable name and passing the
input as `--json '<value>'` after it, which is the form the `cf piece call`
commands quoted in this record use.

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

The eighteen, by kind and id. The parenthetical labels are not part of the
output: they were substituted in from the ids `cf inspect piece` had already
resolved for the board and the three Topics.

```
free-cell	of:fid1:MscuyM1Fu6C0-R_lMStp2nxPWJA2dmO0xdqjrnGMYxI
module	of:fid1:B1qoTCLCReRnzGjMrffTbyjfncQS5noIzXU17dEi3jY
module	of:fid1:jR-EjijuUI72pIM1u_pICPObJ7l6FY267vQsQ5HOaEs
owned-cell	computed:fid1:Djt2mteUsPM7xYqzyAbcQZEwUhUFRtNcUu_dL2GyxUs
owned-cell	computed:fid1:i4ZalHeHb337sViE2wiIW34dBbroXoPTovKvc5OqcHA
owned-cell	of:fid1:-Cl3XnGLsdTrHsdAQ-9R6m4foFt431o10d9fhW_y084
owned-cell	of:fid1:5AolZAculFDcxqYkHZTO6UMxPmSAo6RoSzoxA6-2c04 (TOPIC A ARGUMENT)
owned-cell	of:fid1:b0fYSlQ-xsKvh7wH-QHo0t3OObzDzO2PKd9t9cyCzwc
owned-cell	of:fid1:iAMIggyBsc1OmpE2D48UOz_Dj4vVXMEXGT1XhgGRCm8 (TOPIC B ARGUMENT)
owned-cell	of:fid1:l4f2HUA0VXPjf1g2J_fCPGLxFLmdaoxW5cKPNK6gAnc (TOPIC C ARGUMENT)
owned-cell	of:fid1:LaFtomRzChrcyFJg156LkWLHrOAFm7cADdbMT1Uj-O8
owned-cell	of:fid1:N3Vh4v1lXM44HYZs2AyfejeTsdOrlIGZU2RiMg2W8UU
owned-cell	of:fid1:r4omHfXbUOtoPW4MjZkLJdeD5DDaoQJQTVY4bYlrINY
owned-cell	of:fid1:XerVoLrsD0mNSKAo1aMA-Av1N2rFjajN1tlg86uw8BE (BOARD ARGUMENT)
piece	of:fid1:2cz27KUxVbq9sO19J6fkG_G0H4CfUnhaopw4udwjEHM (BOARD PIECE)
piece	of:fid1:MY1hlV9P4dSvnc4IsBHVfgcMycsUw6V9NAwaF0yaB_0 (TOPIC A PIECE)
piece	of:fid1:YRns-lbzx9QKDUN8LJKyGAwnNmc1V82H6A0Zo2Nvonk (TOPIC C PIECE)
piece	of:fid1:zB92OJBKdC4t8cu8WKBtX-pXI--dzTe0F4W4FAnd-38 (TOPIC B PIECE)
```

All four argument cells are `owned-cell`, which is the classification claim
Finding 2 makes. The seven unlabelled `owned-cell` rows were looked up in
`cf inspect entities`; this is that command's kind and label columns for those
seven rows, extracted by matching each id — not a verbatim run of it:

```
of:fid1:-Cl3Xn…   owned-cell [3]
of:fid1:b0fYSl…   owned-cell [3]
of:fid1:LaFtom…   owned-cell [3]
of:fid1:N3Vh4v…   owned-cell [3]
of:fid1:r4omHf…   owned-cell [3]
computed:fid1:Djt2mt…   owned-cell "Space Home (3)"
computed:fid1:i4ZalH…   owned-cell false
```

Five three-element lists, a name and a boolean. **That is a label column, not
contents**: an authored three-element list would print `[3]` too, and nothing
here reads what these seven hold or which piece owns them. So this block
identifies which entities changed and rules none of them in or out as authored
content. What the authored-content claim rests on is the direct reads —
`topicCount`, the index, and the three bodies in Finding 2, and the four
argument diffs in Findings 2 and 3 — not this list.

The instrument boards and their items are absent from the list because the
comparison that produced it selects only entities the pristine manifest already
carried; anything created after the clone is counted in `added`.

Churn over the whole run, `--bucket 60`, with `--until` set past the last
write so the trailing quiet minute is inside the window. The per-entity
"hottest in the busiest bucket" lines the command prints after the footer are
dropped; nothing below reads them:

```
2026-09-06 07:29:00	 0 commits	0 revisions
2026-09-06 07:30:00	29 commits	174 revisions
2026-09-06 07:31:00	 0 commits	0 revisions
2026-09-06 07:32:00	34 commits	306 revisions
2026-09-06 07:33:00	14 commits	31 revisions
2026-09-06 07:34:00	10 commits	33 revisions
2026-09-06 07:35:00	26 commits	38 revisions
2026-09-06 07:36:00	 0 commits	0 revisions
2026-09-06 07:37:00	 0 commits	0 revisions
2026-09-06 07:38:00	 0 commits	0 revisions
2026-09-06 07:39:00	56 commits	199 revisions ←peak
2026-09-06 07:40:00	19 commits	63 revisions
2026-09-06 07:41:00	55 commits	180 revisions
2026-09-06 07:42:00	24 commits	80 revisions
2026-09-06 07:43:00	 7 commits	7 revisions
2026-09-06 07:44:00	26 commits	81 revisions
2026-09-06 07:45:00	 0 commits	0 revisions

300 commits / 1192 revisions over 17 × 60s
peak 2026-09-06 07:39:00: 56.0 commits/min
last commit 2026-09-06 07:44:00, observed through 2026-09-06 07:45:00
```

That is the settle: `last commit 2026-09-06 07:44:00, observed through
2026-09-06 07:45:00`, and that minute reported at zero. The busiest minute is
56 commits at 07:39, the minute before it is zero and the minute after it 19,
and three whole minutes in the middle of the window are zero — a curve of
spikes with quiet between them rather than a sustained plateau.

Which minute belongs to which command is not recorded. The churn output carries
timestamps and counts and no operation identifiers, and the deploy, bind and
check blocks above carry durations and no timestamps, so nothing here joins
them. An earlier draft attributed bands to particular steps; it was guessing
and the sentences are gone.

## Stated limitations

Three claims this record makes are narrower than the sentences around them may
read. They are left standing with the gap named rather than deleted, because
each carries something.

- **The instrument's two display strings are not isolated** (Finding 5). The
  fixed and control boards differ in the walk and in two `[NAME]`-and-heading
  strings. No run varies one while holding the other, so the removal result is
  attributed to the walk on the strength of the maps differing exactly as the
  walk's code predicts, and on nothing else. A run that renamed the fixed board
  to match the control would settle it and was not made.
- **The fixed instrument board's raw names map was never read** (Finding 5).
  Only the id-keeping projection was, so its entries are shown to carry an `id`
  and are not shown to lack a `path`. The Topics board's map, quoted un-elided
  in Finding 4, is the post-fix form this record can speak for.
- **No run separated the two `--check` calls on the board** (Finding 7). Their
  combined cost is measured; the split between them is inferred from three
  checks against a different piece.

And one about the shape of the whole exercise: the removal case ran on an
instrument, not on Topics, because Topics has no verb for it. Everything
Finding 5 establishes is about a board built for the purpose, composing the
same `item.tsx` and calling the same `naming.ts`. Whether the Topics board's
own member shape behaves the same under a removal is untested and, at this
commit, untestable without new code.

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
- **Scale.** Three Topics, against the roughly 125 the first rehearsal counted
  for the Estuary board. The per-Topic costs above are what a board
  the size of the Estuary one would multiply, and the bulk-CLI shape
  [`../topics-board-migration-2026-08-28.md`](../topics-board-migration-2026-08-28.md)
  found unreliable from a laptop is unchanged by anything here.
- **Anything about the deployment rather than the store**: shell bundle, CDN,
  and concurrent human traffic are all absent from a clone.
- **The two consecutive clean passes** the procedure requires before going
  live. This run made one pass, plus one earlier pass that was reset.
