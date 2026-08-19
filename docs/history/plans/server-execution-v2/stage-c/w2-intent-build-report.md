---
status: historical
created: 2026-08-19
archived: 2026-08-19
reason: "Stage-C evidence: W2 — the (e) build (design §6): the client's whole-sidecar intent watch replaced by a NON-REACTIVE storage-notification listener keyed on the outstanding intent set; W0's (e) gate numbers (the narrowed-sink probe) first, then what was built, the pin/mutation table, suite counts, and the PROVISIONAL series numbers with load."
---

# Stage C — W2: (e) the intent listener (server-execution v2)

*Fix-pass note (2026-08-19): this report is the BUILD report, written
at the build tip `2ce7cb8c7` (pre-rebase). The independent adversarial
review (`w2-intent-review-report.md`, LANDABLE-WITH-FIXES — 0 BLOCKER /
1 MAJOR / 7 MINOR / 6 NIT) and the fix pass (`w2-intent-fix-report.md`)
sit beside it; claims the review refuted or sharpened are corrected IN
PLACE below with a dated "Fix-pass" note, the original wording kept.
The branch was rebased onto the design branch's tip `461b01822` (review
MIN-7) — the code is byte-identical across the rebase.*

Date: 2026-08-19 (runs 07:02–07:53 UTC). Base: the stage-C design
branch tip `c3ec7fc7b` (`claude/server-exec-v2-stage-c-design`, PR
#6017's line, off `bebf8e1ff` → the tuning trio's `b54bf5215`) —
*fix-pass: rebased onto `461b01822`, the branch's stated base*. Branch
`claude/server-exec-v2-w2-intent-listener` (worktree
`/Users/berni/labs-worktrees/w2-intent`), stacked PR **#6039** onto the
design branch, to be RE-STACKED onto W1's tip (`claude/server-exec-v2-w1-dprime`)
when W1 lands. Durable copy of this report:
`/Users/berni/labs-worktrees/w2-intent-build-report.md`. Raw run
artifacts (driver logs, test logs, toolshed logs, `/api/health/stats`
pre/post, per-run stores, per-note extractions) under the session
scratchpad `…/0e87bf81-…/scratchpad/w2bench/runs/<run>-<workload>-<arm>/`
with the driver (`run-arm.sh`, the W0 (d′) driver byte-for-byte plus a
`PROFILE=1` knob that turns on the note test's per-note profile + action-
run captures), `extract-note.py`, and the three ON binaries. Design
references: `stage-c-design.md` §3 (the (e) design; §3.3 the seven-point
contract; §3.4 pins 1–11), §5 items 4–9, 13, 15, 16, §6 "W0 … (e)" and
"W2 — (e)"; the lens report `stage-c-lens-e-client-intent.md`; the
attribution report §2c.

## 0. Verdict in one line

**W0's (e) gate PASSED decisively — the O(history) client term IS the
intent sink — and (a) is BUILT: the whole-sidecar `cell.sink` is gone,
the intent watch is one storage-notification listener keyed on the
outstanding set (zero transactions, zero CFC probes, no scheduler node,
O(outstanding + hints) per check), the effects channel follows (item
13), the RULED sentences of items 5/6, 7, 8 landed; per-note client
`scheduler/run` on the note n=20 series is FLAT (71–170 ms; the design
tip the same hour: 0.84 → 14–20 s) and createToView p50 fell 4.03 →
0.79 s (PROVISIONAL, load 3.1–6.0).**

## 1. The W0 (e) gate — measured BEFORE building (design §6 "W0 … (e)")

Protocol: built ON binaries (`deno task --no-lock build-binaries
toolshed`, `COMMIT_SHA` set, `EXPERIMENTAL_SERVER_EXECUTION=true`), the
posture read per run from `/api/meta.shellServerExecutionDefine`
(`"true"`) + `/api/health/stats.servingLoop` present, `gitSha` per run;
NO configured LLM model (0 `CFTS_AI_LLM_*_API_KEY`, no
`packages/toolshed/.env`, every toolshed log `No default model
available`); fresh cwd = fresh store per run; `--background --log-file
--port=8961` with `PORT/API_URL/MEMORY_URL` on 8961; the note workload
`packages/patterns/integration/default-app.test.ts` with
`CF_NOTE_CREATE_TIMING_SERIES=20` PLUS the client-counter captures
`CF_CAPTURE_NOTE_CREATE_PROFILE_SERIES=20 CF_CAPTURE_ACTION_RUN_SERIES=20`
(the same in both arms — they add an `idle()` + read per note), under
`gtimeout --kill-after=30 520 deno test -A --no-lock
--v8-flags=--max-old-space-size=4096 --trace-leaks`, FOREGROUND, one Bash
call each; loads recorded before/after; logs read with `/usr/bin/grep
-a`; no orphaned headless shells. Both runs' test step 1 is RED on the
pre-existing `splitDefinitions` console gate (as in W0 (d′)'s n1–n3 and
the re-benchmark's n2); the n=20 series completed in both.

| run | tip | binary sha256 | start (UTC) | load 1/5/15 before → after | wall |
|---|---|---|---|---|---|
| b1 (baseline: the schema-less sink) | design tip `c3ec7fc7b` | `7a9157db3ec36ef0` | 07:03:52 | 1.96/2.64/2.95 → 5.51/4.59/3.77 | 286 s |
| e1 (interim (b): the schema-narrowed sink, scratch `e91194469`) | +1 scratch commit | `c262190bda9fed13` | 07:12:20 | 3.51/4.29/3.82 → 4.29/4.38/3.92 | 121 s |

*Fix-pass note (review N-4): the table's loads are the 1/5/15-min
triples at start and end; the IN-RUN 1-min peaks (from
`load-samples.txt`, 10-s cadence) were b1 **6.29** (07:08:30Z,
mid-series) and e1 5.01 — the baseline arm ran under the highest load
of the arms, which inflates the b1/e1 ratio a little; the monotone-vs-
flat SLOPE is the robust signal and is unaffected.*

Per-note CLIENT counters (the profile's cumulative logger totals,
differenced per note; the action-run trace per note):

| note | b1 `scheduler/run` ms | b1 `run/commit` ms | b1 sink runs / ms | e1 `scheduler/run` ms | e1 `run/commit` ms | e1 sink runs / ms |
|---|---|---|---|---|---|---|
| 1 | 839 | 430 | 9 / 142 | 182 | 22 | 7 / 4 |
| 4 | 2 413 | 1 633 | 18 / 482 | 74 | 11 | 11 / 4 |
| 7 | 3 951 | 2 665 | 18 / 831 | 88 | 12 | 11 / 6 |
| 10 | 3 844 | 2 589 | 13 / 754 | 334 | 44 | 12 / 18 |
| 12 | 6 636 | 4 554 | 13 / 1 252 | 140 | 22 | 11 / 12 |
| 15 | 7 107 | 4 868 | 16 / 1 416 | 188 | 38 | 11 / 14 |
| 18 | 14 599 | 9 936 | 18 / 2 939 | 99 | 16 | 11 / 14 |
| 20 | 13 948 | 9 549 | 16 / 2 747 | 158 | 28 | 11 / 20 |

`scheduler/run` COUNT per note is the same in both arms (77–128): the
cost per run collapsed, not the run count. Full per-note series:
b1 `839 1660 3230 2413 1993 3424 3951 3405 3905 3844 4695 6636 4701 4074
7107 9857 10916 14599 19624 13948` (0.84 → 14–20 s, monotone;
`run/commit` — the CFC probes on the sink's tx — 60–70 % of it); e1 `182
115 107 74 114 106 88 97 107 334 132 140 126 153 188 123 118 99 125 158`
(FLAT ~0.1–0.2 s). createToView per note: b1 `1721 2342 3729 3122 2467
4026 4916 2881 4768 3060 3785 8161 3837 4277 4876 13565 6637 10816 15126
9695` (p50 4 026 — W0 (d′)'s 4.09 s without the captures; the slope 1.7 →
15 s); e1 `1312 927 805 856 671 528 979 1103 687 901 781 741 1239 907 760
802 520 1261 489 2068` (p50 805; first-10 median 901 / last-10 801 — no
slope). Server counters unchanged in class (waves 363 vs 303,
`events.appended = processed = 94` both, lease.lost 0 both).

**Verdict:** the growth FLATTENS with the narrowed sink → the O(history)
term is the intent sink's schema-less traversal + CFC probes, exactly as
attributed (design §3.1, attribution §2c) → build (a). (C's Q9 list was
not consulted: nothing was left to re-attribute — the residual per-fire
sink cost under (b) is 4 → 20 ms, the design's predicted linear O(E) at
E ≈ 100.) The interim (b) did NOT ship (item 16: (a) replaced the sink
outright); its scratch commit stays in the branch history as W0's arm.

## 2. What was built (design §3.3's seven-point contract, point by point)

Files: `packages/runner/src/speculation/doc-notification-listener.ts`
(NEW — the shared `CoalescedDocListener`), `overlay-destination.ts`
(the intent section rewritten), `effects-channel.ts` (onto the same
listener), `packages/patterns/integration/cfc-browser-helpers.ts` (three
churn counters), tests (below), specs + register + plan + design notes.

1. **State.** `#trackedIntents` (space → sidecar → eventIds) unchanged —
   the OUTSTANDING set. `#intentSinks` REPLACED by `#intentListener`
   (ONE `CoalescedDocListener` per overlay) and `#intentSidecarStates`
   (space\0sidecar → `{ hints: Set<index> }`, the verified entry-index
   hints since the last check). Diagnostics: `#intentCheckCount`,
   `#intentCheckVisits`, `#intentCheckMaxVisits`,
   `#intentListenerInstalls`.
2. **Install in `trackIntent`.** (i) the listener subscribes ONCE via
   `runtime.storageManager.subscribe(...)` (item 15), lazily on the first
   outstanding intent, `wants` = a map lookup on the outstanding set
   (space-scoped changes for a tracked sidecar id); (ii) the sidecar is
   kept WATCHED at the first `trackIntent` on it through
   `storageManager.open(space).sync(sidecarId, { path: [], schema: false
   }, "space")` — the schema-less selector `syncCell` uses (a covered
   watch is a replica no-op), best-effort with the loud
   `intent-watch-failed` arm — *fix-pass (review MIN-4): the kick now
   runs on EVERY `trackIntent`, not only the first on a sidecar, so a
   transient first-pull failure (which drops the replica's tracker
   entry and leaves the stream unwatched — NO frame arrives) heals on
   the next fire; a covered watch is an O(1) tracker lookup, no wire;
   pinned*; (iii) an IMMEDIATE raw check runs at
   `trackIntent` (T25: a re-fired caller-supplied id whose consequence
   already landed resolves here) and the listener is installed only if
   ids remain tracked (no leak). Install failure is fail-soft and loud
   (`intent-listener-failed`; the watermark backstop stands) — the
   posture of the old `intent-sink-failed` arm.
3. **Trigger.** Any notification touching a tracked sidecar (commit /
   integrate / pull / load / revert; a `reset` is relayed as "everything
   tracked in the space is dirty"). The listener never acts inline: it
   records the change paths and `queueMicrotask`s ONE coalesced check
   per (space, sidecar) per burst; the hints are the differential's
   `["value","entries","<i>",…]` indices.
4. **Check.** Re-reads the RAW replica doc
   (`replica.getDocument(sidecarId, "space")` — no transaction, no
   proxy); locates each outstanding id by verified hint
   (`entries[i].eventId === id`) else a backward scan from the tail that
   stops when all are located; not-found stays tracked. Today's arms in
   today's order on the ONE located entry (`#applyIntentEntry`): `status
   === "dropped"` → untrack, `retireIntent`, settle `dropped`, notify;
   else `consequenced === true` → untrack, retire, settle `errored` (if
   `error`) or `consequenced`, notify `errored` if `error`.
   `resolveIntent`, `waitForIntentConsequence`, `subscribeIntentOutcomes`
   untouched. *Fix-pass (review MAJ-1): the check's per-entry gate is
   the LIVE tracked set re-fetched from the map, not only the check's
   pre-loop snapshot — as built here, an outcome subscriber that
   re-fired on the same sidecar (a retry-on-drop UI, the events.md §5
   hook) ran a nested `trackIntent` → an INNER check that retired an
   id the outer check's snapshot still held, and the outer check then
   applied it AGAIN (`dropped:X` delivered twice; a stale memo). The
   old sink's scan gated on the live `ids.has(...)` per entry and its
   `trackIntent` returned early while a sink existed, so it could not
   double-apply: a regression vs the old guard, latent (no production
   subscriber yet), fixed with its pin. Review N-2: the apply is
   wrapped in a per-entry try/catch (`intent-apply-failed`) so a future
   throw in one entry's arm cannot strand the check's other ids.*
5. **Release.** `#untrackIntent` drops the sidecar's state when its set
   empties and releases the listener when NOTHING is outstanding;
   `close()` releases it (and a delivery already dispatched before close
   never checks).
6. **Backstop unchanged.** `#ensureWatermarkSink` / `#sweep`, the
   ack observer, the arrival observer — untouched; the sweep now counts
   an intent-origin entry it retires (`intent-echo-retired-by-backstop`).
7. **Diagnostics.** Getters `pendingIntentCount`,
   `intentListenerInstalled`, `intentListenerInstallCount`,
   `intentCheckCount`, `intentCheckVisits`, `intentCheckMaxVisits`;
   logger keys under `speculation-overlay/` (the `commonfabric.*`
   surface — `getLoggerCounts().counts`): `intent-check`,
   `intent-retired-by-consequence-of`, `intent-drop-notice`,
   `intent-error-notice`, `intent-refused`,
   `intent-echo-retired-by-backstop`, `intent-listener-installed`,
   `intent-listener-released`, and the fail-soft arms; the browser churn
   line gained `overlayIntentChecks` / `overlayIntentsByConsequenceOf` /
   `overlayIntentEchoBackstops`.

**The effects channel (item 13 — (e)'s second step, BUILT here).**
`effects-channel.ts` keeps its reconcile byte-for-byte in logic but
watches through the same `CoalescedDocListener` (`wants` = the session
effects doc at scope "session" in a subscribed space; reconcile from a
microtask over the RAW session instance), keeps the doc watched + does
the LT8 resubscribe re-read through `sync(id, { path: [], schema: false
}, "session")` (reconcile on landing, idempotent by nonce), and releases
on close. Getters `reconcileCount`, `listenerInstalled`; key
`effects-reconcile`. Its old sink shared the intent sink's shape
(schema-less whole-doc effect FOLLOWING `args.target` links into the
navigated-to doc), so it was retired here rather than measured for
"small enough" — the effects doc IS small on the acceptance workloads
(one entry + one ack per navigation).

**Spec text landed (RULED 2026-08-18, text with the build):**
speculation.md §4 step 2 — the match-and-carrier sentence (items 5/6:
the match is on `consequenceOf`, carried as the tracked entry's own
`consequenced` / `status` / `error` — SANCTIONED; `consequenceOf` not on
the wire; tracked-entry-only, never HISTORY, backstopped by `W ≥ seq(e)`
/ `eventWatermark ≥ seq(e)` — item 9's clause folded in) + item 8 ("the
client keeps a stream subscribed while it has intents outstanding on
it") with its spec home NAMED as speculation.md §4 beside step 2 + item
4's non-reactive-listener statement; events.md §5 — item 7 ("drops and
errors ride `consequenceOf`", verified against
`space-server.ts` `#sealEventConsequenceNotice`: the notice seals as an
event-handler-kind tx stamped with the eventId, so the wave's
`consequenceOf` fold carries it); speculation.md's "Stated honestly"
rationale phrase "any per-user subtree the demand walk does not reach"
swept to a mechanism-neutral form (the register said W2 sweeps it).
Register: the "Stage C design build delta — W2 (e)" LANDED block (a
coverage row per sentence; the counters; the W4 client witnesses; OW40
re-read unchanged; one recorded-not-numbered follow-up). Plan
coordination block + design §3.3/§6: landing notes.

## 3. Decisions (design's recommendation taken; the alternative named)

- **One listener per OVERLAY (not per sidecar)** — contract point 2(i)
  allowed either; per overlay = O(changes) map lookups per notification
  with no per-sidecar subscription churn; the alternative (one per
  sidecar) would filter each notification k times.
- **The immediate check at `trackIntent` walks the raw array once for a
  fresh id** (T25 needs a full backward scan; a minted id's entry cannot
  be present, but `trackIntent` cannot tell a minted id from a
  re-delivered caller id without a new parameter). A plain JS array
  walk, no transaction, microseconds at E = 1 000; `intentCheckMaxVisits`
  reports it; every NOTIFIED check is O(outstanding + hints) (pin 5).
  Alternative not taken: a per-sidecar "scanned length" memo (would
  break under compaction's index shift; the mark's own hint rescues it,
  but the reasoning is subtler than the µs it saves). *Fix-pass
  (review MIN-2): "O(outstanding + hints)" is the HINTED arm; a change
  with no usable index (an append's `["value","entries"]`, a moved
  hint) degrades to the backward tail scan over the entries appended
  AFTER the tracked one — O(k) per notification while an intent stays
  outstanding on a busy shared stream (µs at k ≈ 100). The spec
  sentence in speculation.md §4 said "O(outstanding), never O(history)"
  and now says what the code does; memoizing each located index into
  the hint set (O(1) thereafter) is the fix shape if it ever matters —
  flagged, not built. Review N-3: the tail-first scan reads the
  TAIL-MOST entry for a tracked id, so a T25 duplicate that coexists
  with its consequenced original waits for the duplicate's OWN mark
  (the skip path seals it consequenced without error → `consequenced`),
  where the old forward scan read the original's (and its `error`) —
  this fire's own consequence; a behavior delta in that corner, stated.*
- **Item 8's spec home = speculation.md §4 beside step 2** (the
  client-side reconciliation rule sits with the retirement it serves;
  events.md §5 is the server's failure semantics) — the design left the
  home to the build.
- **Item 16: no interim shipped** — (a) replaced the sink outright; the
  (b) scratch commit stays only as W0's measurement arm in history.
- **The effects channel is in THIS PR** (item 13 "if it fits") — same
  shape, one shared helper, 15/15 e2e steps green through it.
- **Fail-soft install** — a `subscribe` that throws (test stubs without
  a relay; no production manager) logs `intent-listener-failed` and
  leaves the watermark backstop, mirroring today's `intent-sink-failed`
  posture rather than failing the fire.
- **`wants` restricts to space-scoped changes** for the sidecar id
  (sidecars are space docs; hygiene, not a semantic).

## 4. Pins 1–11 and the mutation that kills each (all run; RED under the mutation, GREEN restored)

*Fix-pass note (review N-1): "each with its mutation" — pins 3 and 4
are folded into pin 1's step, and pin 11 (the OFF witness) has no
mutation. Review MIN-5: pin 10's landed form asserted "resolved by the
time the mark is visible on a MACROTASK poll", weaker than the design's
"by the time `synced()` / `idle()` resolve after a frame"; it now states
the design's guarantee (observed from a subscriber registered after the
listener, arming both barriers AT the mark's frame) and is killed by a
macrotask deferral of the check (`queueMicrotask` → `setTimeout(0)`),
which the macrotask-poll form could NOT see (the deferred check ran
before the next 20-ms poll). The reviewer's own probes (MX1 "record only
the first wanted change per notification" survived every shipped pin;
MX4 "`wants` accepts only `scope === undefined`" survived the scripted
pins because the harness sent no scope) are now killed: the MIN-1 pin
(one notification spanning two tracked sidecars) and the harness's
production `scope: "space"` on every change address (MIN-6). Three
review pins were added to `speculation-intent-listener.test.ts`: MAJ-1
(re-entrant `trackIntent` in an outcome callback — exactly one outcome
per retired id; RED on the build tip: `["dropped:Z","dropped:X",
"dropped:X"]`), MIN-1 (two tracked sidecars in one notification; RED
under MX1), MIN-4 (a transiently failed first `sync` is re-issued by the
next fire on the stream; RED on the build tip). Suite now 2 tests / 12
steps.*

`packages/runner/test/speculation-intent-listener.test.ts` (scripted
seam: `speculation-intent-test-utils.ts` — a stub manager implementing
exactly `subscribe` / `unsubscribe` / `open(space).replica.getDocument` /
`open(space).sync`, driving `IStorageNotification.next` with the
differential's leaf-path shapes; e2e: EmulatedStorageManager + memory
server + a live ExecutorHost for the served mark), plus the re-seamed pin
in `event-append-client.test.ts` and the honest stub in
`speculation-arrival-gate.test.ts` (the late-echo test's stub manager now
carries the relay seam).

| pin | asserts | mutation | red under mutation? |
|---|---|---|---|
| 1 (+3, +4) | consequenced retires silently; errored/dropped retire AND signal; `waitForIntentConsequence` per kind, memo consumed; listener releases with the last id; the refusal path | M1: `listener.ensure()` skipped (never installed) | YES (also pins 2, 5, 7, 8, 9, e2e 6, 10) |
| 2 | an UNTRACKED id's drop/mark is ignored; the tracked id stays | M2: the outstanding-set guard dropped in the check | YES (pin 2 only) |
| 5 | 1 000 consequenced + 1 outstanding: the mark's check visits ≤ 2, zero `runtime.edit`; a moved index re-locates from the tail | M5a: full forward scan, hints ignored → visits 1 001; M5b: the check mints a tx | YES (M5a: pin 5; M5b: pins 1 + 5) |
| 6 (e2e) | no `sink:…/of:stream-events:` node after a fire, before/after the append lands; the effects channel: no `sink:…/of:server-execution-effects/` node, `listenerInstalled` | M6: the old `cell.sink` kept beside the listener | YES (pins 6 + 10) |
| 7 | T25 duplicate resolves AT `trackIntent`, no listener installed, waiter resolves at once | M7: the immediate check skipped | YES (pins 5 + 7) |
| 8 | `close()` releases; a delivery dispatched before close never checks; nothing after close subscribes | M8: the release forgotten in `close()` | YES (pin 8) |
| 9 | the check runs in a microtask (outcome callback sees no dispatch on the stack; outstanding when `next` returns); a burst coalesces to ONE check; a reset re-checks | M9: the listener dispatches inline from `next` | YES (pins 8 + 9) |
| 10 (e2e) | the served mark resolves the intent by the time it is visible in the client replica (no extra turn), `intentCheckMaxVisits ≤ 2`, echo retires, authoritative value renders, durable ack settles non-error | M1 / M6 | YES |
| 11 (e2e) | OFF: no overlay, no `subscribe`, no node, the handler runs locally | (byte-identity witness) | n/a |

The re-seamed `event-append-client.test.ts` pin was RED against the new
code before the re-seam (the old `getCellFromLink().sink` stub seam is
gone) and GREEN after; `executor-events-down.test.ts`'s full loop is the
standing e2e witness whose ack assertion settles only through the
carrier (green).

## 5. Suites (every green is a LOCAL run — a stacked PR gets no CI)

FOREGROUND, `--no-lock`; counts filled from the runs on the tip:

- runner (`packages/runner`, `deno task test`, the clock preload):
  SEE §5a below (first full run at the pre-fix checkpoint: 1211 passed /
  6725 steps, the only reds my own two — the arrival-gate stub without
  a relay, and the new suite missing from the preload's real-clock list;
  both fixed).
- runtime-client, memory, toolshed, piece, spec-model: SEE §5a.
- `deno task check-docs --no-lock`, `deno fmt --check`, `deno lint`: SEE
  §5a.
- Targeted: `speculation-intent-listener.test.ts` 2 tests / 9 steps
  green (×5 across the mutation rounds); `event-append-client.test.ts`
  4 / 15 green; `speculation-arrival-gate.test.ts` 1 / 6 green;
  `executor-effect-channel.test.ts` 1 / 15 green (through the new
  listener, incl. the LT8 reload journey and the receipt-race divert
  pin — flag 14's ~1-in-3 flake did not fire in this run; not chased,
  not silenced); `executor-events-down.test.ts` 1 / 13 green (under the
  interim (b) too).

### 5a. Final counts (the tip; FOREGROUND, `--no-lock`)

- runner — `packages/runner` `deno task test` (the clock preload):
  **1213 passed (6728 steps) / 0 failed** (7m07s) at `75f02c1f7`; the
  3-line effects-channel retry tweak after it re-ran
  `executor-effect-channel` + `speculation-intent-listener` green (3 /
  24). (The first full run at the pre-fix checkpoint read 1211 / 6725
  with exactly my two reds: the arrival-gate late-echo stub lacked the
  relay seam; the new suite was missing from the preload's real-clock
  list — both fixed, both now green.)
- memory — `deno task test` (check + tests): **521 passed (229 steps)**.
- toolshed — **142 passed (428 steps)**.
- runtime-client — **61 passed (212 steps)**.
- piece — **37 passed (451 steps)**.
- spec-model — **23 passed**.
- `deno task check-docs`: 548 code blocks pass; `check-docs-history-index`:
  120 entries / 163 documents (this report rides the
  `plans/server-execution-v2/` directory entry, as W0's does).
- `deno fmt --check`: every file this PR touches is formatted; the 5
  unformatted files it reports are pre-existing at the base
  (`packages/patterns/system/summary-index.tsx`,
  `packages/runner/src/builtins/llm-dialog.ts`,
  `packages/runner/test/space-host-late-hint.test.ts`,
  `packages/shell/test/env.test.ts`, `skills/state-inspector/SKILL.md` —
  the stage-C closeout's "6 fmt-dirty files at HEAD" minus one). `deno
  lint` on the touched files: clean.

## 6. The series on the W2 tip (PROVISIONAL — W4 is the quiet acceptance run)

Same recipe as §1; ON binary from `7a5481d14` (sha `7964711e835ea16f`),
`gitSha` read per run, `No default model available`, fresh store.

| run | workload | start (UTC) | load before → after | wall | result |
|---|---|---|---|---|---|
| a1 | note n=20 (+ the client captures) | 07:44:02 | 3.06/3.90/3.71 → **5.99**/4.68/4.04 | 125 s | series ✓ (step 1 red on the pre-existing console gate) |
| ca1 | chat n=20 @2 s | 07:47:40 | 4.27/4.51/4.04 → 3.80/4.76/4.35 | 326 s | ✓ green, series COMPLETE |

*Fix-pass note (review N-4): in-run 1-min peaks from `load-samples.txt`
— a1 6.07, ca1 **7.61** (07:51:04Z); the three note arms' loads were
NOT equal (b1 6.29 / e1 5.01 / a1 6.07), so the cross-arm RATIOS are
indicative and the per-arm SLOPE is the signal.*

**Note (the (e) witness):** per-note client `scheduler/run` `101 91 82
80 77 71 78 91 89 103 87 88 135 170 129 123 149 109 109 80` ms — FLAT
(first-10 / last-10 medians 88 / 122; the design tip: 0.84 → 14–20 s);
`run/commit` 11–32 ms; the sink effect: 0 runs, 0 ms (design tip 9–19
runs, 142 → 4 096 ms); createToView `1145 692 637 878 765 741 932 444
879 415 596 474 1275 1166 876 887 574 793 1879 778` ms — p50 792 (the
test's 778), p95 1 879, first-10 / last-10 medians 764 / 876 (no slope);
vs the design tip's 4 026 the same hour and W0 (d′)'s 4.09 s; the OFF
number on record is 1.10–1.20 s (W0/re-benchmark). Server side unchanged
in class (waves 288, `events 94/94`, lease.lost 0, structureLoadTerminal
674 — a server number). The run's own load rose to 5.99 by its end
(above the 5 line for the last notes) — hence PROVISIONAL.

**Chat (design tip's server — the walk still present — so compare
against the trio tip's numbers, per the brief):** cross-user median
11 270 ms (q1 8 637 / q3 16 913 / min 5 193 / max 19 252) at load
4.1–4.9 in-test — the trio tip's re-benchmark: 7 397–9 734 ms p50 at
load 4.0–6.5; per-post `7449 6208 5193 8185 8137 8637 10890 10161 8808
11713 19252 17102 16913 17314 11270 11030 11603 18347 13692 11907` (the
per-post climb is the server's walk term, W1's; not (e)'s). Client
witnesses (the churn line): Alice `overlayIntentChecks=75` for 25 fires
(3 per intent — fire, append landing, mark), `overlayIntentsBy
ConsequenceOf=25` (every fire resolved by its mark), `overlayIntentEcho
Backstops=2` — *fix-pass (review N-5): this counter counts ECHO entries
the W sweep retired, not missed marks: the arrival sweep runs
synchronously inside `applySessionSync` and can retire the echo before
the mark's microtask check runs, so 2 backstops coexist with 25/25
resolved by mark* — `overlayArrivalSweeps=106`, `actionRuns=2540` (trio
2 722–2 753; OFF 975–1 006 — the remaining ON excess is NOT the intent
watch: 75 checks are not scheduler runs; it is the speculation
echo/arrival re-derivation class, W1/W4 territory); Bob
`overlayIntentChecks=10`, 3/3 by mark, `actionRuns=851`. Steps: Alice
save + own status 1 679 ms (trio 873–2 344; OFF ~307 — an actor-side
step that awaits a SERVER-derived status, not the echo), room
propagation 13.2 s (trio 9.5–10.2 s; the walk). Server: waves 151,
`wavesBudgetExhausted` 866, `events 28/28`, lease.lost 0.

**Client-local speculation latency preserved:** by construction — the
fire's own echo run and its seal are inside the flat 71–170 ms per-note
client budget, and the click path's `trackIntent` is O(1) + one raw
check (no transaction, no sink run). A dedicated sender-echo instrument
(click → the sender's OWN render, the attribution's 1–3 ms) does not
exist in the harness; W4 should add it (recorded in the register block).

## 7. Flags for the owner (flag-don't-fill)

1. **The tracked-set drain when a mark never arrives** — recorded, not
   numbered: an intent stays outstanding until its entry's mark, a
   refusal, or close; if compaction (OW24, unbuilt) ever removes the
   entry before this client saw its mark, the intent never resolves
   (`waitForIntentConsequence` hangs; the ECHO still retires by W).
   Pre-existing with the sink; unreachable today. Fix shape when OW24
   lands: record the entry's `seq` at first sight, treat `eventWatermark
   ≥ seq` with the entry gone as consequenced (item 9's fact applied to
   the tracked SET) — ~10 lines. Recommend: number it in the sweep, land
   with OW24. *Fix-pass (review MIN-3): NUMBERED — register row
   **OW41**, trigger OW24 (the compaction PR cannot land without it);
   the hang also reaches the caller's durable-ack `onCommit` (`cell.ts`
   routes the flag-ON send path's ack through `waitForIntentConsequence`
   — the CLI verb dispatch / webhook forwarder would wait forever);
   verified unreachable today (the watermark is recomputed from the
   contiguous consequenced frontier, so `eventWatermark ≥ seq(e)`
   implies the mark is present; nothing else removes an entry).*
2. **The remaining ON client action-run excess on chat** (Alice 2 540 vs
   OFF ~1 000) is NOT the intent watch — the listener runs no scheduler
   action (75 checks) — it is the arrival/echo re-derivation class
   (`overlayArrivalSweeps` 106); the note per-note client budget is flat,
   so this is a chat-shape term for W1/W4 to look at, not (e)'s.
3. **A sender-echo instrument is missing** from the two-browsers
   harness (click → own render); the W4 acceptance's "client-local
   speculation latency preserved" line needs it to be a NUMBER rather
   than a construction argument.
4. Item 10 (scopes.md §9 "ragged at the space→user hop") is server-side
   text and NOT landed here (W1's train, per design §6's "rides the
   build train").

## 8. Not done, and why

- **No OFF bracket runs on this tip** — the OFF arm is byte-identical
  by construction (the overlay and the effects channel exist only under
  the flag off the serving posture; pin 11 is the witness; the runner
  suite ran OFF-posture as always) and W0 (d′)/the re-benchmark hold the
  OFF numbers (note 1.10–1.20 s; chat 0.22–0.24 s) — the box time went
  to the two ON series instead. The OFF store's commit table on the
  workloads (design §6's witness) is W4's.
- **No lunch run** — not in W2's brief; the lunch gate's duplicate-
  consequence family is (α)'s (W3).
- **The T25-class immediate walk** was not memoized (decision above).
- **The sender-echo instrument** was not added (flag 3).
- **The scopes.md §9 amendment** (item 10) — W1's.
