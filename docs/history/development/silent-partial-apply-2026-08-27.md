---
status: historical
created: 2026-08-27
archived: 2026-08-27
reason: "Record of the one observed silent partial apply, and of a parent/child migration that neither rollback nor restore could reverse."
---

# A retarget that wrote 75 rows and reported success

The first use of the bulk piece operations by someone who did not build them,
against a clone of the real Topics space, on 2026-08-27. Two findings, one of
which nothing in the test suite could have produced. Both are recorded here
because the run has not been reproduced since; the evidence below is all there
is of it.

## The silent partial apply

`cf piece retarget --plan <plan> --apply` over a 125-row plan — a board's
children, the holder row carrying no operation. The dry run classified all 125
as outstanding and refused nothing. The apply then:

- wrote **75 of 125** rows,
- printed **no summary line at all**, and
- exited **0**.

Nothing said it had stopped. The operator found it by surveying afterwards and
counting identities: 75 on the new one, 50 on the old. A wrapper checking the
exit code would have reported the migration complete, which is what makes this
worth a record rather than a bug number.

Re-running the same plan finished the job and classified correctly —
`landed: 75 · applied: 50 · written: 50` — so resume and classification were
never in question. The first run's silence was the whole defect.

### What the log showed

Its shape is the evidence. `Experimental flag overrides:` is written
synchronously inside the `Runtime` constructor, once per session opened, and
in an 81-line log it falls at lines 2, 3, 29, 55 and 81 — 26 apart, which is
one banner and 25 applied rows. The default group size is 25.

```text
banner (line 3)  → 25 rows   group 1
banner (line 29) → 25 rows   group 2
banner (line 55) → 25 rows   group 3
banner (line 81) → nothing   group 4 opened, and the file ends
```

So the fourth session was constructed and then produced nothing. Per-row times
had been climbing into that boundary as the parent recomputed over more
migrated children: 1.8–2.3s through the first group, a 21.8s first row while
the board warmed, `p50 2.96s` and `max 4.12s` across the 75.

### Why it exited 0

`cf` is invoked as a floating `main(Deno.args)` rather than under a top-level
await, so Deno's "Top-level await promise never resolved" detector does not
cover it. A process whose main promise is pending, with nothing left on the
event loop, drains and exits **silently at code 0**. Four lines reproduce it:

```ts
async function main() {
  console.log("row 1 applied");
  await new Promise(() => {}); // never settles
  console.log("summary: never printed");
}
if (import.meta.main) main(); // floating, not awaited
```

The summary line and the nonzero-exit-on-incomplete both already existed and
were tested. Neither ran, because the report never came back: the defect was
unreachability, not wrongness.

### What was and was not established

The stall is between the fourth session's banner and its first row — the rest
of `loadPieces` after the `Runtime` constructor, or the group's first pin read.
One measurement narrows it further: an open WebSocket, a pending `fetch` and a
running subprocess each keep a Deno process alive, so a process that *exited*
had none of them outstanding. That rules out a stuck health fetch, a stuck
version-check subprocess, and an in-flight pull.

**The await itself was not found.** It is in runtime or storage rather than in
the bulk operations, and it was left open rather than guessed at.

### Why no test caught it

The engine's unit tests use a session factory whose close **defers disposal**,
because the emulated storage manager loses the space when a runtime is
disposed — so they observe group boundaries but never a real teardown and
never a second real session open. The CI drill does open five real sessions
over 113 members, at `--group-size 5` and again at the default, and passes. So
the trigger is not one boundary; it is load- or state-dependent, and this run
remains the only observation of it.

## The reversal that had no path

The same rehearsal then tried to undo the migration, with the board already
moved. Both directions refused.

Children first, through the derived rollback plan:

```text
failed fid1:1D7eZ… topics 5077ms - updated arguments do not match the
  candidate schema: myName: value does not match type string;
  the piece is still on its recorded reference
unattempted: 124 pieces named
```

Board first, restoring it to its pre-migration revision:

```text
updated arguments do not match the candidate schema:
  topics: 0: missing required property createdByName
```

Each side's schema referenced the other side's retired surface, and both had
moved: the child's `myName` is a link into the board's own argument document,
and the board demands `createdByName` of every child. The stop behavior was
correct throughout — the failing row named, its reason given, the piece
confirmed still on its recorded reference, and all 124 remaining pieces named
rather than counted.

Neither `rollback` nor `restore` carries
`--dangerously-allow-incompatible-schema`; only `setsrc` and a stamped
retarget row do. That asymmetry is deliberate — the override belongs per row,
where the plan records which rows ran with the gate open, rather than per run
where 125 decisions collapse into one — and it means the way back from a
forced forward move is a retarget onto the prior source with the override
stamped. That requires the prior source on disk: `getsrc` cannot retrieve a
retained revision, so it comes from the repository by mapping pattern identity
to commit.

**Not established here:** whether this deadlock generalizes beyond one board
whose children link into its argument, whether the backwards retarget succeeds
on it, or whether a content export and restore is a working recourse. None of
the three was tested.
