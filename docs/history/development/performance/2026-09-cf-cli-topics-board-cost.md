---
status: historical
created: 2026-09-09
archived: 2026-09-09
reason: "Investigation record: where a cf CLI call against the 217-topic Topics board spends its time, measured end to end on a clone of the Estuary space — what each command syncs, commits, and computes, and which of those costs are avoidable."
---

# What a `cf` call against the Topics board costs, and why

Measured 2026-09-09 on a writable clone of the Estuary Topics space
(`topics-dev-476ea34f`, snapshot of 2026-09-09 00:02 UTC, 217 topics, 6.8 GB,
507k commits) served by a source-run toolshed at commit `d6d947cb1d` on an
Apple-silicon laptop, loopback only. Both ends were on the `serverExecution`
OFF arm (`/api/meta` reported `serverExecution: false`; `cf` declared the
same). Every number below is in-process wall time of the `cf` command unless
it says otherwise; the launcher adds about 1.3 s of Deno startup on top.

Instruments: `CF_CLI_TRACE_TIMINGS=1` for the CLI's phases, the logger's
timing statistics and `CF_TIMING_MEASURES` spans read in-process, a V8
sampling profile of the CLI process and of the toolshed over its inspector
port, `/api/health/stats` differenced around each command, and a per-frame
record of the wire in both directions (`CF_MEMORY_FRAME_LOG`, added during
this work). The scripts are in `skills/perf-investigation/scripts/`.

## The numbers

| Command (warm server cache) | Wall | Inbound | Outbound | Docs delivered |
| --- | --- | --- | --- | --- |
| `cell get <topic> title --input` | 0.15 s | 1 MB | 8 KB | 41 |
| `cell get <board> index --step --select @,title,…` | 3.5–5.1 s | 24.7 MB | 2.4–3.0 MB | 20,039 |
| `piece verbs --cell <board> --json` | 1.5 s | 17 MB | 7 KB | 4,340 |
| `piece call <topic> addComment` | 4.4–7.5 s | 15.4 MB | 2.2 MB | 5,600 |
| `piece call <board> addTopic` | 15.3–25.7 s | 26 MB | 14.3 MB | 22,000 |

Cold (toolshed just started, document cache empty): the survey took 8.2 s,
of which the board's start was 7.0 s, and the server's twelve watch adds took
5.9 s against 1.7 s warm. The cold cost is the engine decoding 22,500
documents once; the warm numbers are what a deployment whose cache holds the
board pays.

The survey's output is 58 KB. Its input read (`--input` on a field) is fast:
the CLI's own overhead is not the problem, and neither is the server when it
is warm — both CPU profiles are half idle, each side waiting on the other.
What costs is the volume the client asks for and the work it then does with
it.

## Where the survey's five seconds go

`cell get <board> index --step` starts the board pattern in the CLI process,
pulls the `index` derivation, and projects it. Phases:

| Phase | Warm | What it is |
| --- | --- | --- |
| `get.runtime.start` | 2.4–6.0 s | the runner's resume pre-sync plus instantiation |
| `getCellValue.step.target.pull` | 0.2–0.3 s | the `index` pull |
| `deriveSelectedValue.output.pull` | 0.8–4.3 s | the projection's own pull and commit |

The pre-sync issues twelve watch adds. Two of them are the survey:

- **The board's argument, through the board's argument schema.** One root
  (`topics` on the argument document, items `TopicDemand`) returns 4,237
  documents and 15.6 MB in 1.3 s of server time. The schema is narrow —
  `TopicDemand` names eight scalar fields — but a document is delivered
  whole, and each topic's result document is 57 KB: `$UI` 8.7 KB, `crossrefs`
  4.5 KB, and 38 KB of metadata (`internal` 24 KB, `schema` 7.8 KB,
  `argument` 5.6 KB). 222 of those are 11.7 MB, half the survey's inbound
  bytes, and the survey reads four scalars from each.
- **The list coordinator's children, with a rejecting schema.** The resume
  pre-sync syncs each of the `index` map's 217 element cells with
  `{ schema: false }`, and the server answers such a root with the document
  and every document its metadata rails reach — 14,675 documents and 7 MB for
  433 roots, about 35 per child: the child's argument and internal documents,
  8,026 link documents, 3,110 stream markers, 2,925 bare strings.

Then the survey commits 224 times, and 223 of those are rejected; the one
that lands is the session-scope bootstrap commit sent before the board
starts. The instantiation commit (690 operations, 1.9 MB) reads 1,562 documents it
believes absent — the per-element cells the map re-derives — because the
watch that requested them under the row schema went out 26 ms before the
commit and answered 300 ms after it. The server rejects it with a stale read
at seq 0, and the 222 per-element commits behind it fail on "pending
dependency not resolved". The client's local result is what the command
prints, so the answer is right; the 2.4 MB upload, the server's handling of
239 frames, and its two 0.8 s watch-set refreshes to echo the one landed
commit are spent on nothing. The durable store gained that one commit.

## Where `addTopic`'s twenty seconds go

Phases of one run, by the `--verbose` spans:

| Span | Time |
| --- | --- |
| `initial_sync → dispatched` | 3.6–4.2 s |
| `dispatched → committed` | 10.4–13.3 s |
| `readback → settled` | 2.9–4.1 s |

The first span is the space root's start (1.1–1.5 s, 10 MB: 39 registered
pieces' full results) plus the board's start (2.3 s, 9 MB, the same two watch
shapes as the survey). The last is the receipt pull, most of it a 223-root
watch of the board's row schema behind the retried handler.

The middle span is a chain, read off the frame log:

1. The handler runs and creates the Topic piece (231 operations). The child's
   setup runs `backlinksOf`, which reads the board's crossref table row by
   row — 229 rows the pre-sync never fetched, read at seq 0. The commit is
   rejected.
2. `crossrefTable`, the board's mention pivot, re-runs over the pushed list.
   Its argument validates as undefined on a cold replica, and the runner's
   invalid-input diagnostic then serializes the lift's entire input through
   the action's own transaction: 67,399 reads, 377 per topic, to depth 20 —
   every topic's rendered `$UI` tree, read through `toJSON`. Those reads are
   the commit's basis, so the commit carries them: 11.5 MB for one operation,
   rejected on 5,465 documents read at seq 0 after 1.7 s of server time.
3. The rejection's catch-up syncs 2,731 documents; the lift re-runs (four
   runs in all, 746 ms of CPU each — `mentionedBy` resolving a link per topic
   per mention through `equals`, and materializing each topic's mention list
   through a proxy); the handler re-runs, valid now, and lands.

Making the diagnostic lazy (a getter, evaluated only when logged) cut the
command to 9.3–10.1 s and the upload to 2.3 MB — and the topic was not
created. The retried handler read its `$ctx.crossrefs` input as undefined and
was skipped, silently, as a client-side dispatch is when its argument fails
its schema; the CLI reported `settled` with no `result`. The eager
serialization was what rescued it: its walk registered pulls for everything
the inputs reach, and by the time the handler retried, the pivot's rows were
local and the argument validated. A variant that kept the walk eager but
ran it through a scratch transaction (keeping the reads out of the basis)
lost the topic the same way: the pulls are issued from a transaction's read
log at commit, and an aborted transaction commits nothing. The runner change
was reverted; both halves are recorded below as one defect.

This is the "reported success without committing" the topics skill warns
about, reproduced deterministically.

## What each finding points at

Two fixes exist for every one of these — ask for less, or make the work
cheaper — and they sit at different layers.

1. **Discovery syncs the board through its full result schema.** `piece
   verbs` and `piece describe` open the piece with `getResultCellWithSourceSchema`,
   and on a board that means every topic: 16 MB and 4,286 documents to list
   eleven verbs, whose names are top-level keys of one document. Bounding
   that read to the piece's own document is a CLI change.
2. **The resume pre-sync asks for whole documents it reads four fields of,
   and for metadata rails it never reads.** The argument pre-sync's width is
   the stored document's shape (66 % metadata); the list-child pre-sync's
   width is what a `false` selector means on the server. Either the server
   projects a delivered document to the selector, or the pre-sync narrows
   what it asks — the second is the runtime change, the first is the storage
   change that would pay everywhere.
3. **The invalid-input diagnostic runs inside the action's transaction.**
   `#getJavaScriptInputState` in `packages/runner/src/runner.ts` serializes
   the whole input eagerly whenever an argument reads as undefined, and its
   reads enter the commit basis. On a cold replica that is a guaranteed
   conflict of the largest commit in the run. It cannot simply be made lazy,
   because of the next item.
4. **A retried client dispatch is skipped silently when a dependent
   derivation reads as undefined.** The handler's `presyncInputs` follows the
   argument's value, not its schema, so an input whose document is not local
   syncs nothing, and the retry's undefined argument is treated as a schema
   mismatch rather than a cold read. A schema-driven presync (the way
   `#syncArgumentLinkTargets` walks a declared schema through links) or a
   requeue that parks on the loads the failed run registered, bounded like
   the served path's deferrals, is what lets item 3 be fixed.
5. **`crossrefTable` resolves a link per topic per mention.** `mentionedBy`
   in `packages/patterns/topics/main.tsx` calls `equals` inside a scan over
   a proxy-materialized mention list: 1.5 s of link resolution and 0.9 s of
   proxy materialization per run at 217 topics, run four times here.
   Resolving each topic's address once and comparing strings is a pattern
   change; the runtime could also make `equals` on two already-resolved links
   not resolve them again.
6. **Every `piece call` starts the space root first**, so that a verb which
   creates a piece can register it — 1.1–1.5 s and 10 MB before `addComment`
   dispatches, for a verb that creates nothing.
7. **A landed commit refreshes the session's whole watch set.** The server's
   `flush/refresh` re-evaluated 2,400–5,500 watches for 0.4–2.1 s to deliver
   one or two upserts, once per commit the CLI landed.

The survey's per-element commits and their rejection are item 4's read side:
the instantiation reads what its own watch has not yet delivered.

## What was ruled out

- The CLI's own phases. `--input` reads finish in 150 ms; the launcher's
  startup is 1.3 s and fixed.
- Server CPU as the bound when warm. The toolshed profile is 58 % idle over a
  survey; its work is traversal proportional to the documents delivered
  (`traverse` 7,860 calls) and encoding them.
- The pattern's declared demand. The board's index row schema and the
  `TopicDemand` argument schema are as narrow as the record they reach;
  what they cannot narrow is the document that carries the field.

## Instruments added

- `CF_MEMORY_FRAME_LOG=<file>`: one JSON line per memory-protocol frame,
  either direction, with a watch's roots and selectors, a commit's operations
  and read-set shape, and every delivered document's size and keys
  (`packages/memory/v2/frame-log.ts`).
- `CF_SLOW_QUERY_THRESHOLD_MS`: the server's slow-query threshold, so a
  local run records every operation's root, read and upsert counts.
- `executeCallable.dispatch`, `executeCallable.receipt.pull`,
  `executeCallable.select` and `executeCallable.boundCyclic` phases under
  `CF_CLI_TRACE_TIMINGS`, splitting a `piece call`'s readback.
- `skills/perf-investigation/scripts/profile-cf.ts` (a `cf` invocation
  in-process, with its logger statistics, spans and a CPU profile),
  `profile-toolshed.ts` (the server over its inspector port, bracketed by a
  command, with the health-stats delta) and `summarize-frame-log.ts`.
