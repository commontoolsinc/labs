# The changes projection

Companion to [`README.md`](./README.md) (the attention-system spec), split
out because it is **independently approvable**: a small, general, read-only
memory-v2 query primitive that the attention system consumes but does not
own. The memory owner can evaluate this file without adopting any attention
theory; the attention spec's phase 0 depends on it and nothing else here.
Section references (§n) refer to the main spec.

## Status

Proposed; net-new runtime surface (main spec §10.1). This is a **security
surface**, not just a feature: it exposes entity versions to pattern-space,
reversing a deliberate prior decision (`Cell` exposes no version), and it
adds an enumeration read ("which of these entities changed"). It needs
framework-author sign-off on the CFC story below, not just implementation
review.

## The primitive

One read-only, one-shot, session-independent query:

```text
changes(roots, branch, sinceSeq?, attribution?)
  → { toSeq, entries: [{id, seq, deleted?, author?}] }
```

(The receiver/verb name is a placeholder — this belongs to the memory-v2
query layer, named in that spec's §5 style, not to a `graph` object that
doesn't exist.)

Three modes, one shape:

1. **Single root, no basis** → a **non-reactive head read**: the entity's
   current head `seq`. One-shot query, not a watch — re-renders never
   re-fire, which is the property the seen-store's write discipline
   requires (main spec §4.5, §5).
2. **Root set + basis** → the **changed-since enumeration**: entries whose
   head has advanced past `sinceSeq`, plus a `toSeq` high-water mark that
   becomes the next basis. This is "while you were away" in one call.
3. **`attribution: true`** → each entry joins the commit log's persisted
   `sessionId`: **session-grain, server-asserted "by whom"**, upgrading in
   place to `invocationRef`-backed proof when the signed-write pass lands.
   A join, not a cryptography project.

## Why this is small

Every load-bearing piece is shipped, not specced:

- `seq` already crosses the wire in every query result (`FactEntry.seq`,
  memory-v2 §5.7.1).
- Changed-since-a-basis is precisely the session catch-up computation
  (memory-v2 §5.4.2; `SessionSync.fromSeq/toSeq`, §4.2.3) — this primitive
  re-exposes it one-shot and session-independent, payload-free.
- Attribution joins `CommitLogEntry.sessionId` (memory-v2 §3.7.2), already
  persisted; `invocationRef`/`authorizationRef` are reserved there for the
  later signed-write pass.
- Implementation: one composite `(branch, seq)` index on the `head` table
  (only `idx_head_branch` exists today), plus the wire verb.

It is the entity-grain, payload-free member of the projection family
memory-v2 §07 sketches. It is deliberately **not** built on §07's
annotations plane — annotations are range-anchored collaborative-field
machinery, self-declared future work, and the one annotation prototype's
review (PR #4132) documents why storage-side reverse indexes invisible to
the reactive graph are the wrong shape.

## CFC / read-authority story

**An entity may appear in a changes result iff the caller may read the
entity itself on that branch** — strictly less information than a
materialized read reveals. The genuinely new exposure is *enumeration*
("that something changed" across a set), which is the same information a
standing watch already reveals; v1 enforces space-level ACLs (matching
memory-v2 §5.6's current posture), and when label-based redaction lands,
changes entries redact wherever the materialized read would. Version reads
are gated by the same read authority as the entity — observing a head seq
reveals *that* activity occurred, so it must not be cheaper to obtain than
the entity itself. Branch scope: v1 serves the default branch only,
matching the main spec's same-space version-comparability rule (child-
branch head inheritance is the known hard part — PR #4132's blocker).

## Consumers beyond attention

The generality test, so this earns its place as a platform primitive rather
than an attention hook: offline catch-up UIs ("what changed while this
device was closed" without holding a session watch open); activity/audit
views ("what happened in this space this week, by whom" — the
state-inspector hand-rolls offline versions of these reads today);
incremental derived indexes (a basis cursor turns recompute-the-world into
process-the-delta); retention/GC watermarks (reap below `toSeq`).

## What the attention system builds on it

- `unseen(entity)` = `changes([entity], sinceSeq: seenVersion.seq)`
  non-empty → change dots (main spec §5).
- "While you were away" = one `changes(watchSet, basis, attribution: true)`
  call, grouped by attribution then space (main spec §5).
- The steward's fold uses head reads to stamp `subjectVersion` and evaluate
  currency at fold time (main spec §6).
