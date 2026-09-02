---
status: historical
created: 2026-08-28
archived: 2026-08-28
reason: "Record of the Stage B migration of the Estuary Topics board and its 125 topics: the ordering that was inverted, what the rehearsal proved, and the failures only the live run produced."
---

# Migrating the Topics board to the narrowed demand

The Estuary Topics board and all 125 of its topics moved to the Stage B
patterns on 2026-08-27/28. This records what the run established, including the
parts that contradict what was planned.

## The ordering inverted, and that is the reusable finding

`docs/development/space-clone-rehearsal.md` says children first, board last,
because the parent's result recomputation is what storms. That reasoning holds
whenever the parent's demand stays put — the children have to catch up to what
the parent already requires.

This break moved the BOARD's demand, which reverses it. Measured from the
deployed board's own stored revision rather than from a recompile of its
source: the old board demanded `createdByName` required with no default, and
eleven of its sixteen demanded members carried no default at all. A topic that
stopped publishing any of them would have emptied the whole array behind a
count that still read correctly. The narrowed board, by contrast, reads old and
new topics alike.

So the new board is itself the both-shapes board, and moving it first keeps the
setup readable at every step. That was proved twice over, because the run did
not proceed cleanly: the board served all 125 topics continuously through
intermediate states of 5, 12, 15, 22, 27 and 115 migrated children. The mixed
state was not a risk tolerated; it was the state the ordering was chosen to
make safe, and it held for hours.

The general rule: **the side that can read both shapes moves first.** Which
side that is depends on which demand changed, not on which is the parent.

## Reversal is one-way

After both sides move, the migration cannot be undone through the source log.
Measured on a clone, all three refused:

- `cf piece rollback` on the children — `myName: value does not match type
  string`, because each child's `myName` is a link into the parent's argument
  and the migrated parent no longer has that cell.
- `cf piece restore` on the board — `topics: 0: missing required property
  createdByName`, because the migrated children no longer publish it.
- A backwards `retarget` with `--dangerously-allow-incompatible-schema`
  stamped — the identical error to `restore`.

The override waives a compatibility PROOF. These refusals are argument
validation against real data: the new child does not publish the field the old
parent requires. No flag makes absent data present.

Recovery therefore means restoring CONTENT, not the prior source —
`scripts/topics-export.ts` and `scripts/topics-restore.ts
--allow-identity-mismatch`, exercised at scale beforehand: 20 of 20 topics
restored with bodies, authors and timestamps matching the export byte for byte.

## What the rehearsal could not predict

The clone rehearsed the migration end to end and passed. Three things still
went wrong live.

**Every run from a laptop died 4-6 minutes in.** `sync-load-failure ...
ConnectionError: memory transport closed`, on a DIFFERENT entity each time —
five distinct across runs. Independent of plan size: an eight-row plan failed
exactly as a 125-row plan did, applying nothing in six minutes. Independent of
row count and of which piece. It tracked only elapsed process time. Chunking
into fresh processes did not help, which refuted the leading hypothesis that a
resource was accumulating across rows. Evidence went to #4695, which had
carried the same error since July as a staging-only annoyance.

**Per-row cost rose and never recovered.** Across the run that finished:
19-24s per row in the first group, 29-32s in the second, 56-61s in the third,
each step following a transport error. Individual rows reached 165s and 203s.
The connection failure leaves the process degraded rather than dying cleanly,
and that degradation — not the error itself — is what makes long bulk
operations impractical.

**A partial apply reported success.** One run wrote 75 of 125 rows and exited
0 with no summary line. That is #6429 and its fix #6406; the guard did not
fire here, so an exit without `landed: N · applied: M · written: M` must be
read as "resume", never as "done". The state was recovered by surveying the
store, which is the habit the whole run rewarded: every log-derived number in
this migration was wrong at least once, and every store-derived number was
right.

## What finished it

Running from the Estuary host, against the production URL rather than
`localhost:8000` — which turned out to be a different service entirely, with
its own DID and git sha. Ninety-eight rows in one pass, ending with
`applied: 98 · written: 98`.

The `cf` binary mattered: `/opt/cf/releases/current/cf` is built from the
deployed revision, which predates both Stage B and a `ts-transformers` fix. A
binary from CI at a descendant of the Stage B merge was used instead, and the
identity it computed was checked against the identity the already-migrated
topics carried BEFORE applying anything. Had they differed, the board would
have split across two generations.

## Final state

125 topics on one pattern identity, the board on its own, no old generations
left. Durable content unchanged against the pre-migration baseline: 125 topics,
and comments up by exactly one — a live post made by a person while the
migration ran. `index`, the surface Stage B adds, materializes over all of
them. A write to the migrated board was verified afterwards.

One defect was found by that write and remains open: `addTopic`'s declared
result closes a circle through `$UI` into `$profile` into `$UI`, so the
handling commits but the result cannot be rendered as JSON.
