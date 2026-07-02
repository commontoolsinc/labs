# Convergence investigation — evidence appendix (PR #4457)

Curated evidence behind the repro package in PR #4457 (reader blackout B1/B2,
writer integration gap B3, and their escalation into the multiplayer
convergence collapse). Everything here is a direct measurement; the working
log with full chronology lives outside the repo. Dates: 2026-06-30 → 07-02.

The defects, one line each (details in the PR body):

- **B1** — a live `PerUser` cell pushed into shared state stores a
  scope-generic `"user"` link (owner DID lost); readers resolve it into their
  own empty partition.
- **B2** — `required` + absent-under-reader link resolution voids the whole
  element and array read (`traverse.ts` chain `3667 → 3724 → 3218 → 3554 →
  3178`).
- **B3** — a writer that lost a concurrent-append race permanently keeps a
  stale array holding only its own appends.

---

## 1. In-process bisection (the decisive experiments)

Multi-runtime harness (Deno workers + in-process memory server), fixture
variants isolating one ingredient each. 2 writers × 20 posts, deep pipelines
(`send({idle:false})`), non-writing observer, `settle(20)`:

| fixture | Cell-link elements | shared derived readers | outcome (result-path views) |
| --- | --- | --- | --- |
| `convergence-chat` | ✓ | ✓ | `alice={a:20,b:20} bob={} observer={}` (50/56 conflicts) |
| `convergence-chat-noderived` | ✓ | — | same blackout, **ZERO commit conflicts** |
| (nolink, not landed) | — | ✓ | all converge (4–5 conflicts, all resolved) |
| `convergence-chat-plain` | — | — | observer converges; **losing writer stale** (B3) |

Link-carrying elements are necessary and sufficient for the blackout;
conflicts are irrelevant to it.

**Minimal case** — ONE settled post, one writer, zero contention:

```
alice: [alice-0]        bob: []        observer: []
```

while raw storage reads (`rawRead`, bypassing the schema/result path) show
**all three replicas hold the identical array AND the linked message doc with
full content**. Not replication — the schema-aware read.

**Read-depth probe** (observer, blackout state):

```
read(["messages"])              → undefined
read(["messages", 0])           → undefined
read(["messages", 0, "author"]) → "alice"      ← sub-path reads work
read(["messages", 0, "body"])   → "alice-0"
```

**Stored element link** (raw, in the message doc — note the generic scope and
the embedded `required`):

```json
{"authorProfile": {"/": {"link@1": {
  "id": "of:fid1:GWtqjxJ3dZHoxfxRnFvE4KnWdoHA5oOk-KPTFzSYiNQ",
  "path": ["profile"],
  "schema": {"$defs": {"StormMessage": {"required": ["authorProfile","author","body","n"], …}}, …},
  "scope": "user",
  "space": "did:key:z6Mkg…"
}}}}
```

**Controls:** same flow with the linked cell `PerSpace` → converges (B1
sidestepped); with the field `authorProfile?:` optional → converges, field
absent for readers (B2 sidestepped — and B1's identity loss visible directly).

**B3 reproducibility** (`storm-driver.ts 20 2 pipeline 0 convergence-chat-plain`,
5 runs):

```
run1  alice={alice:20,bob:20}  bob={bob:20}            observer={alice:20,bob:20}
run2  alice={alice:20,bob:20}  bob={bob:20}            observer={alice:20,bob:20}
run3  alice={alice:20}         bob={alice:20,bob:20}   observer={alice:20,bob:20}
run4  alice={alice:20,bob:20}  bob={bob:20}            observer={alice:20,bob:20}
run5  alice={alice:20,bob:20}  bob={bob:20}            observer={alice:20,bob:20}
```

Observer always converges (delivery is fine); exactly one racing writer is
stale, holding only its own appends, through `settle(20)` + pulling reads. The
loser's raw array is stale too (its replica holds the other writer's message
*docs* but not the array revisions) — distinct mechanism from B1/B2.

---

## 2. Browser-scale measurements (how it presents in production shape)

Playwright harness: N isolated Chromium contexts, distinct CLI identities,
each runtime worker behind a WS shim adding fixed latency both directions.
Sustained concurrent posting to one shared group-chat piece
(messages-only variant of `profile-group-chat`, real `wish("#profile")`
cross-space profile links). 3 users / 600 ms / 40 s @ 250 ms intervals
(411 posts) unless noted.

### 2.1 Durable-record autopsy (offline `cf inspect`, landed commits only)

Identical signature across ALL five experiment spaces — including two runs the
frame-quiescence metric had called "converged":

| space (scenario) | posted | landed | winner | loser A | loser B | lost |
| --- | --- | --- | --- | --- | --- | --- |
| gcbase1 (20 s, "converged") | 207 | 56 | 54 | 1 | 1 | **73%** |
| gcincr1 (20 s, "converged") | 207 | 56 | 53 | 2 | 1 | **73%** |
| gcbase2 (40 s) | 411 | 123 | 120 | 2 | 1 | **70%** |
| gcincr2 (40 s) | 411 | 124 | 121 | 2 | 1 | **70%** |
| gcmo1 (40 s) | 411 | 123 | 120 | 2 | 1 | **70%** |

Space-wide commit timeline (gcmo1): the winner lands an unbroken run of ~120
commits at its own posting rate while both losers land **zero commits
space-wide** for the whole storm — even their uncontended per-user draft
writes starve, because the send action's tx bundles draft-clear with the
conflicted message append. After the winner drains, the losers land 2/2/1
commits in ~3 s, then the space records **nothing ever again** — with ~135
queued sends each — while WS traffic continues for ~170 s.

### 2.2 Frame-content capture (what the wire was doing)

2-user rerun with per-frame classification (also eliminates the shared-CPU
confound). Storm phase: the loser sent **~59 commit attempts per 5 s and
received ~59 rejections per 5 s for 40 straight seconds** (retrying at ~3× its
posting rate — protocol starvation, not client stall); the winner: ~51
commits/5 s, zero rejections. After posting stopped, the loser's attempts
dropped to zero within 10 s (queue silently abandoned; a fresh probe send
later landed fine).

**The persistent "floor" traffic was the WINNER, wedged.** Every ~4.5 s it
re-derived and sent a fresh batch (~7 commits, localSeqs strictly advancing —
227 distinct, zero verbatim resends), each batch containing a byte-identical
**108,160-byte** commit: a one-boolean patch on a shared derived cell carrying
~110 KB of confirmed reads, including the other user's message doc read **at
seq 0** (absent). Server, every time:

```
stale confirmed read: of:fid1:SI9gzUNew…V6IyOK4c at seq 0 conflicted with seq 445, retryAfterSeq 446
pending dependency not resolved: 419   ← every later commit, head-of-line blocked
```

`V6IyOK4c` is the other user's message doc (`{author:"User 1", body:"u1-16", …}`,
durably landed at seq 445). The winner's replica never materialized it (B2's
absent-under-reader condition — here via the real cross-space profile links),
so every re-derivation re-recorded the seq-0 read. Its own last ~17 sends and
a later probe send died behind the poisoned commit as pending-dependency. The
other client entered the same wedge after its probe (different seq-0 entity)
— systematic.

### 2.3 What users see (DOM census at end of run)

Both tabs: **120 messages, all the winner's.** The loser's tab showed *none*
of its own 137 (optimistic state rolled back) and not even its 2 durably
landed ones. The winner's tab never showed the loser's landed messages. On
rapids this presents as either "never settles/flicker" or "quiet but missing
messages," depending only on where the leftover wedge traffic sits relative
to any quiescence heuristic.

### 2.4 Escalation summary

```
B1/B2 (reader blackout, needs ONE post)
  └─ derived cells over the list record the void as seq-0 reads
       └─ their commits are permanently stale once the docs land  → WEDGE
            └─ head-of-line blocking (own tail + probes die as pending-dependency)
                 └─ under sustained multi-writer load: winner-takes-all
                    starvation + silent queue abandonment  → ~70% loss
```

---

## 3. Falsified along the way (method note)

Each of these fit part of the data and died on a direct measurement — kept
here so the surviving conclusions inherit the scrutiny:

1. **Read-path durable write-back loop** — cross-space reads write nothing back.
2. **Tier-1 set path-blindness as the conflict source** — memory-v2 `set`
   carries the whole doc; appends are already path-aware `op:"append"`
   patches on the wire (verified in frame captures).
3. **Conflict-read granularity as THE cause** — an experimental
   exclude-whole-doc-reads-from-conflict fix made drain *worse*
   (174 s vs 156 s baseline, more frames): removing false conflicts let more
   wasteful work through. Read granularity is real but secondary.
4. **O(N²) derivation work as THE cause** — the aggregate work is real
   (deterministically measured: per-append scan grows linearly, 2× input →
   3.96× work) but removing the aggregate entirely (messages-only variant)
   did not restore convergence.
5. **Serial CAS-retry drain (1 commit/RTT arithmetic)** — the durable record
   showed the drain *stops entirely*; the floor was the wedge, and the
   arithmetic fit was a frames-vs-cycles coincidence.

The general lesson: frame-rate quiescence is not convergence ("converged"
runs had lost 73% of writes), and client-side interpretations kept flipping
until the durable record (`cf inspect`) and the frame *contents* were checked.

---

## 4. Apparatus (all reusable)

- **In-process:** `multi-runtime-harness` (+ new `wsDelayMs` per-session WS
  shim, `send({idle:false})`, `rawRead`); `storm-driver.ts`
  (`K / writers / idleMode / wsDelay / fixture`).
- **Browser:** Playwright harness with distinct CLI-key identities and an
  injected worker WebSocket shim (latency + frame classification + ring
  buffer + DOM census + post-storm probe sends).
- **Offline:** `cf inspect` (`conflicts` / `history` / `timeline` /
  `value-at`) against the server's space SQLite files. Caveat: rejected
  commits are not persisted — landed-commit timelines and per-principal
  breakdowns were the decisive views.
