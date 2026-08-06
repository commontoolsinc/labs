---
status: historical
created: 2026-08-06
archived: 2026-08-06
reason: "Measurement record: Topics storage anatomy and WAN-testbed startup experiments behind the improvement plan."
---

# Topics performance: storage anatomy and WAN-testbed measurements

## Purpose

This report freezes the second round of the Topics interaction-performance
investigation: the byte-level anatomy of the 2.5 GB Rapids space database, and
a set of controlled startup experiments against a local clone of that space
behind an emulated WAN link. It builds directly on the evidence snapshot in
[`topics-performance-investigation-2026-08-06.md`](topics-performance-investigation-2026-08-06.md)
and uses the same immutable snapshot (SHA-256
`47a97cf28edc239d895052904b826fb7e584b4260f7786cf591f81413b10aef7`, database
head commit sequence `315287`).

The forward-looking outcome of this work — what to change and in what order —
is not here; it lives in the live plan at
[`../plans/topics-performance-improvement.md`](../plans/topics-performance-improvement.md)
and in Linear issues CT-1954 through CT-1961. This document is the evidence
those decisions rest on.

## Part 1: where the 2.5 GB lives

All numbers measured with read-only SQLite queries against the verified
snapshot.

### The byte pie

| What | Bytes | Share of 2.50 GB file |
| --- | ---: | ---: |
| `commit.original` total | 1,822,659,978 | 73% |
| … of which `reads.confirmed` (read-set records) | ~1.37 GB | ~55% |
| … of which `operations` | ~410 MB | ~16% |
| `revision.data` (byte-for-byte re-store of those operations) | 443,613,184 | 18% |
| `commit.resolution` | 8,320,224 | 0.3% |
| Indexes, heads, snapshots, page slack | remainder | ~11% |

The read-set split was measured directly: for the 3,136 commits at or above
64 KB (1.40 GB of payload), `json_extract` of `$.reads` sums to 1,146,669,444
bytes against 248,644,925 bytes of `$.operations`; a 2% sample of the 312,151
smaller commits shows 52% reads / 38% operations, extrapolating to ~223 MB /
~162 MB. One percent of commits carries 77% of the commit-table bytes.

### What a read-set record is

Every commit envelope stores the transaction's full read observations
verbatim: one JSON record per leaf path read, shaped like

```text
{"id":"of:fid1:<48 chars>","path":["value","$UI","children","0",...],"scope":"space","seq":309065}
```

at ~120–167 bytes each, with the entity id repeated for every path on that
entity, VDOM paths running 20 segments deep. The startup commit `315286` is
8,828,447 bytes: a single 7,296-byte session-scoped `set` towing 52,465
confirmed-read records (8.82 MB, 99.9% of the envelope). Commits `315282` and
`315286` — two different writer actors in the same startup window — carry
byte-identical 8,820,919-byte read blocks; nothing deduplicates them.

Corroborating code facts (from the storage layer, not the snapshot):

- `original` is the verbatim `ClientCommit`, reads included
  (`packages/memory/v2/engine.ts:5179`); `resolution` is only `{seq}` plus
  pending-read resolutions.
- The operation payload is stored twice — the in-repo measurement and the
  suggested fix (store a hash) already exist in
  `packages/piece/test/state-continuity-harness.ts:174-221`.
- There is no retention mechanism: the spec
  (`docs/specs/memory-v2/02-storage.md:428-458`) promises a background GC that
  is not implemented; only `snapshot` rows (retention 2) and scheduler
  contexts are pruned.
- Content addressing was deliberately removed; `blob_store` has zero rows.
- Per-commit auth is unsigned in this build; `invocation` and `authorization`
  are empty. Signatures are not a cost factor.

### Growth shape and the July churn loop

The entire 2.5 GB is five weeks old: July 2026 added 1.55 GB across 310,507
commits; the first six days of August added 273 MB. At the August cadence the
large-commit classes alone add 40–60 MB/day.

The hottest document, `of:fid1:XEmjoPs4Bs7oU_brGkcMARajfJxfoCoCQWce6IB1xik`,
accumulated **48,751 revisions with only 6 distinct payloads** between July 9
and July 24 — roughly one write per minute for two weeks, each a `/result`
link patch carrying a full embedded JSON Schema. Two siblings show
21,751 revisions / 10 distinct payloads and 16,522 / 10. The loop stopped on
July 23–24, timing consistent with the wrapper-bind fixes of that week; the
~87k commits remain in the file because nothing reclaims history.

### The cold-start write classes, priced

From the studied startup window `315264–315287` (24 commits, ~25.2 MB):

- The three session-materialization commits (`315282`, `315284`, `315286`,
  7.5–8.8 MB each) are 99.8% of the window's bytes. Each is a fresh-session
  `set` whose canonical value hash equals the value already stored — a no-op
  by content, priced at ~9 MB of durable read-set.
- The fourteen A→B→A user-scope commits (the profile-wish flap) are ~1 KB
  each — storage-trivial, but fourteen durable commits with zero net change.
  The mechanism is in the runner: the `#profile`-family wishes read the home
  space synchronously, cannot distinguish "not loaded" from "no profiles"
  (`packages/runner/src/builtins/wish.ts:416-484`), and publish a concrete
  error state including an error-UI VDOM (`wish.ts:2533-2560`) that a later
  re-run reverses. Equal-value suppression is intra-transaction only
  (`packages/runner/src/storage/v2-transaction.ts:1185-1190`), and scheduler
  rehydration rejects any cross-space observation
  (`packages/runner/src/storage/v2.ts:2447-2462`), so the flap recurs every
  cold start whose home-space sync loses the race.

## Part 2: the WAN testbed and what it measured

### Construction

1. Clone of the verified snapshot via the rehearsal procedure
   (`docs/development/space-clone-rehearsal.md`) at `~/clones/topics-perf`,
   served by a loopback toolshed (`HOST=127.0.0.1 MEMORY_DIR=... --port-offset
   10`, rehearsal banner confirmed).
2. `scripts/delay-proxy.ts` in front of it: 95 ms one-way delay (190 ms RTT,
   matching Rapids' measured data RTT) and optionally a 600,000 B/s
   (~4.8 Mbps) per-direction cap — the sustained rate the Rapids link itself
   demonstrated while streaming the 2.5 GB snapshot in ~70 minutes.
3. The workload: `cf piece verbs` against the Topics board fid, a fresh CLI
   process per run — the same command the prior report measured at ~108 s on
   Rapids.
4. `EXPERIMENTAL_CONCURRENT_WATCH_REFRESH=true` toggles the storage flag in
   the CLI (parity plumbing landed with this report); `CF_WS_SIZE_LOG=1` logs
   outbound message sizes.
5. One additional probe was run from a throwaway patch that is deliberately
   not landed, because it disables read-validity checking: emptying the commit
   read-set at the client. Recipe: in `packages/runner/src/storage/v2.ts`,
   have the reads-assembly return `{ confirmed: [], pending: [] }` instead of
   the `compactCommitReads` pair. Measurement only; never deploy.

### The measured ladder

| Condition | Wall time |
| --- | ---: |
| Direct to loopback toolshed, no emulation | **12.4 s** |
| +190 ms RTT | 16.9 s |
| +190 ms RTT, `experimentalConcurrentWatchRefresh` on | 16.6 s |
| +190 ms RTT and ~4.8 Mbps cap | **64.2 s** |
| Same capped link, commit read-sets stripped | **30.0 s** |

Repeat runs were stable to within ~1 s. The server was warm (one discarded
warmup run); the concurrent-dump contention and cold caches of the original
Rapids measurements are additional costs on top of this ladder, which is
consistent with the ~108 s observed there.

### Transfer volume and composition

One cold `verbs` run moves **28 MB**: 20,015,496 bytes up, 8,108,073 bytes
down (proxy TCP totals; identical across runs). Outbound message composition,
measured with `CF_WS_SIZE_LOG` as UTF-8 payload bytes before WebSocket
framing (the per-type sum, 20,029,242, brackets the proxy's TCP figure):

| Message type | Count | Bytes |
| --- | ---: | ---: |
| `transact` | 4 | 17,290,301 |
| `session.watch.add` | 20 | 2,737,241 |
| `session.open` + `session.ack` | 4 | 1,385 |
| `hello` | 1 | 315 |

The four transacts are two commit attempts sent twice: an 8,459,433-byte
first attempt that the server rejects, then its 8,828,550-byte retry, plus the
same pattern at 1,159 bytes. **The multi-megabyte read-set envelope is paid
twice per startup.** With read-sets stripped, `transact` collapses to 2
messages / 8,062 bytes and the rejection disappears — the retry is
read-validity-induced.

The twenty `watch.add` messages are the round-trip waves; their 2.74 MB is
dominated by full JSON Schemas inlined in watch selectors — the largest single
request is 2,013,901 bytes.

Every run also appended the 8,828,447-byte session-materialization commit to
the clone — six byte-identical instances across the experiments. Reading the
board grows the space by ~9 MB per session.

The server logged `slow-traverse` warnings of 1.3–2.7 s per startup for the
board-adjacent documents — the per-startup server traversal cost.

### The flag verdict

`experimentalConcurrentWatchRefresh` (window 8) measured no effect on this
workload: 16.9 s off vs 16.6 s on at 190 ms RTT. The twenty waves are
*dependent* — inputs link closure, result cell, main fan-out, `cid:` schema
hop, and the depth-two argument-link walk, run twice per `runSynced`
(`packages/runner/src/runner.ts:3806-3993`) — and overlapping cannot collapse
waves whose targets are discovered from the previous wave's values. This
supports the flag's registered exit path: superseded by reducing the
round-trip count at the source.

## The mechanism, by granularity

1. **Bytes (dominant on real links).** 28 MB of motion per cold interaction;
   at ~5 Mbps that is ~47 s of pure transmission. Composition: read-set
   envelope × 2 (rejection retry), inline watch schemas, and an 8.1 MB
   download driven by full-graph discovery.
2. **Waves (the RTT term).** ~20 dependent `watch.add` round trips ≈ 4.5 s at
   190 ms. Concurrency does not help; wave-count reduction does.
3. **Compute floor.** 12.4 s at zero latency: ~8 s client CPU
   (deep-freeze/canonicalize/hash, much of it spent on the very bytes above),
   1.3–2.7 s server traverse, process start.
4. **Storage feedback.** Each interaction appends ~9 MB of read-set exhaust;
   the file's growth is the accumulated record of having read it, and a larger
   file makes traversal and snapshots slower.

## Provenance

- Snapshot: manifest and hash in
  [`topics-performance-investigation-2026-08-06.md`](topics-performance-investigation-2026-08-06.md);
  verified before use.
- Clone: `~/clones/topics-perf`, content fingerprint
  `fid1:Jh3qsvlfGcs0q3AYPQm3SAyj12sckOOGkD3rReF9gwo` at clone time; the
  experiments appended session-materialization commits (sequences 315288+),
  so reset the clone before reusing it as a baseline.
- Workload identity: `claude.key` transport identity; `cf piece verbs`
  against the Topics board fid from the snapshot manifest.
- Tooling landed with this report: `scripts/delay-proxy.ts`, CLI parity for
  `experimentalConcurrentWatchRefresh`, `CF_WS_SIZE_LOG`.
