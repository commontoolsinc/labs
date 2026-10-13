---
status: historical
created: 2026-10-12
archived: 2026-10-12
reason: "What a macrotask yield between the settle loop's actions did to the receive silence of a thirty-row fabrichat room's reload on a local toolshed, October 2026, and the synchronous units that hold the silence that is left."
---

# The settle's receive silence after a yield between actions, 2026-10-12

The scheduler's settle loop ran a pass's actions and their commits on one
microtask chain, so a client read nothing the server sent while a pass ran.
On a thirty-row fabrichat room that was one receive silence of about half a
minute per load. This records what changed when the loop began yielding one
macrotask turn between actions once a 16 ms slice of continuous work is
spent (`CooperativeYield`, `packages/runner/src/scheduler/settle.ts`), and
what the silence that remains is made of.

## Setup

- The code: `main` at `a8afcc148d` as the baseline arm, and that commit
  with the yield as the other arm.
- The server: a toolshed and shell from the checkout
  (`scripts/restart-local-dev.sh --port-offset 37`), `MEMORY_DIR` on a
  store created for this measurement, `serverExecution` off.
- The room: seeded through the `fabrichat-spaces` manager fixture. The
  starter creates a group room; each of twelve members gets a profile in a
  space of their own, selected as their home profile; the members post
  thirty messages round-robin with the send gesture. Four of the thirty
  sends did not converge under the machine's load, so the room holds 26
  messages.
- The client: `cf piece render` of the room as the starter, in a Deno
  process run through `skills/perf-investigation/scripts/profile-cf.ts`
  under `CF_MEMORY_FRAME_LOG`. A receive silence is a stretch of the frame
  log in which the client sent at least one frame and read none.
- The machine: 16 cores at a one-minute load of 180 to 250 from other
  sessions. Every duration below is inflated by that, by a factor that
  moved between runs: the same baseline reload took 487 s and then 194 s.
  The counts, the byte totals, and each run's own ratios are the
  measurement; the seconds compare only within a run.

## The reloads

Four renders of the materialized room, in the order run. The third carried
temporary timing lines in the settle loop.

| run | wall | longest silence | settle span | silence / settle | frames in | frames out |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline, first | 487 s | 213 s | 193 s | 1.10 | 1,040 | 1,327 |
| yielding, first | 477 s | 195 s | 271 s | 0.72 | 1,976 | 1,696 |
| yielding, instrumented | 298 s | 98 s | 136 s | 0.72 | 2,000 | 1,710 |
| baseline, second | 194 s | 72 s | 72 s | 1.00 | 655 | 944 |

In the baseline the silence is the whole settle: the client sent 343 and
349 frames inside it, 342 and 347 of them commits, and read nothing until
the pass ended. With the yield the silence is 72% of the settle in both
runs, and the client sent two frames inside it.

The work is the same in both arms: 2,094 and 2,095 action runs, 982 commit
preparations, 412 and 413 committed operations, 10,766 and 10,805 watch
roots, 5,043 and 5,049 documents delivered, 10.8 and 10.9 MB out, 8.4 to
8.7 MB in. The frame counts differ because the yielding client reads each
response as it arrives and requests its roots in more, smaller frames: 649
to 662 `session.watch.add` frames against 435 to 473, and 1,679 to 1,695
responses against 580 to 963.

## What the remaining silence is

The instrumented run timed every yield, every action longer than a second,
and every iteration's preparation. Its 98 s silence is three units back to
back, and nothing else:

| unit | duration |
| --- | ---: |
| a list `map` run and its commit | 40.1 s |
| the second list `map` run and its commit | 38.9 s |
| preparing the next iteration of 3,644 actions | 18.9 s |

The room has two lists of message rows, and each `map` run is one action:
17.6 s in the action at most, and 24.6 s preparing its commit for CFC at
most. Preparing an iteration builds its work set and sorts it
topologically, 17.1 s of the 18.9 s in the sort, in one synchronous call.
The loop asks for a yield before each action and nowhere else. It yielded
between the two runs, and once more before the last small actions of that
iteration, 9 ms before the preparation began; nothing yields between an
iteration's last action and the next iteration's preparation. A yield
cannot divide a unit.

Neither of those two yields read a frame, although the server had answered
the pending request long before. The client decodes an inbound frame
through an asynchronous gzip stream, each frame chained behind the one
before it (`packages/runner/src/storage/v2-remote-session.ts`), so a frame
needs several event-loop turns to reach the replica, and one turn between
two long units advances that chain without finishing it. In a separate
Deno process a plain WebSocket `message` listener received every buffered
frame in a single `setTimeout(0)` turn, so the turns are the decode's, not
the socket's.

That iteration then ran its 3,644 actions in 35 s with 524 yields.
The client read 1,186 frames during it, with a gap between consecutive
frames of 115 ms at the 95th percentile and 6.1 s at most.

The span statistics give the same three units on every run:

| run | longest action run with its commit | longest `map` | longest commit preparation | sort |
| --- | ---: | ---: | ---: | ---: |
| baseline, first | 76.0 s | 32.5 s | 43.2 s | 23.8 s |
| yielding, first | 79.9 s | 36.0 s | 45.3 s | 34.4 s |
| yielding, instrumented | 40.1 s | 17.6 s | 24.6 s | 17.1 s |
| baseline, second | 29.1 s | 10.6 s | 18.4 s | 8.9 s |

Commit preparation is 982 calls per reload, and the two longest are 88 to
92% of its time on every run: 88 s in all on the first baseline run with
the two longest at 43 s and 38 s, and a 95th percentile of 35 ms.

## With the sort's cycle break on a heap

`main` then gained a topological sort whose cycle break chooses from a heap
(`6986fd8f47`). One reload of the same room with the yield merged onto it,
at a load of 330 to 470 and 646 s of wall time: the sort is 0.6 s at most,
the settle spans 180 s, and the settle's silence is 123 s, which is the two
`map` runs and nothing else, 62.2 s and 57.2 s: 18.7 s and 18.4 s in the
action, 42.0 s and 37.1 s preparing the commit. Two units remain.

That run's longest silence is an earlier one, 175 s between 8 s and 183 s
of the run with one 2 KB frame sent, before the settle begins. Each of the
four runs above has a silence of that shape before its settle, 21 to 44 s
with one frame sent, in both arms. It is not attributed here.

## The server

Over the session the toolshed's slowest frame was handled in 10.1 s and
queued for 1.6 s at most, against a 95th percentile of 29 ms handling and
25 ms queueing over 14,859 frames. The silence that remains is ten to
nineteen times the longest server operation of the same session.

## The first run

One render of the never-opened room with the yield, with no baseline to
pair it with: 574 s of wall time, and silences of 106 s, 80 s, and 53 s.
The first two each held one commit of the room's tree, 2.3 MB and 1,572
and 1,573 operations, sent after a single preparation of up to 42 s: the
room's tree was committed twice.

## Numbers that decide the next fix

- A yield between actions takes the settle's many small actions out of
  the silence, about 28% of the settle on this room, and leaves three
  units: two `map` runs with their commits and one sort. With the sort's
  cycle break on a heap, the two `map` runs are what is left.
- Per reload, two commits are 88 to 92% of all commit preparation time.
- One event-loop turn does not deliver a compressed frame; the turns
  between long units read nothing.
