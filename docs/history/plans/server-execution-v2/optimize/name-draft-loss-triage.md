---
status: historical
created: 2026-08-22
archived: 2026-08-22
reason: "Optimize-phase triage of the name-DRAFT own-write loss (the OW47-family residual behind the profile-embed ON skip after #6187): death site caught on an instrumented client — the speculation.md §6 export refusal fires on the blind fill because CFC prepare's internal-verifier read of the write-target doc names the standing startEditing seed-echo layer; the OW47 fix covers only the structural read. Mechanism determined; the fix forks on an unstated semantic (which state the verifier read bases on under a standing own-echo), so this is a fork memo, not a fix. Frozen at handoff."
---

# The name-draft own-write loss — triage report

Agent: name-draft-triage (optimize-on-main phase). Worktree
`/Users/berni/labs-worktrees/name-draft-triage`, branch
`claude/server-exec-v2-name-draft-triage` off `origin/main` @
`b775787b6`. Post-fix arm: `#6187` head `455c8a75c` (+ the same
instrumentation, local cherry-pick — the branch itself untouched).

## 0. Assignment

Root-cause the residual that keeps `integration/profile-embed.test.ts`
ON-skipped after #6187's routing fix: in that PR's ten-run gate, 3/10
runs lose ONLY the profile NAME draft — a plain client `$value` write
into the test space that never lands as any commit — while the BIO
amend is durable in the same runs. Diagnosis first; a fix only if
determined; unstated semantics ship as flagged questions.

## 1. Verdict — the death site

**The write dies at speculation.md §6's export refusal
(`speculative-basis-refused`), synchronously, client-side, before the
optimistic apply — the exact OW47 mechanism, through a second
layer-naming producer the OW47 fix does not cover.**

The blind fill's transaction carries, besides the structural parent
read the OW47 fix already bases on the non-speculative stack, a
RECURSIVE path-`[]` read of the draft doc: CFC prepare's
`storedMetadataFor` (`packages/runner/src/cfc/prepare.ts` ~:796) —
`tx.readOrThrow({.., path: []}, { meta: INTERNAL_VERIFIER_META })`,
issued inside `prepareCfc`, which by design runs AFTER
`unmarkUiInputBlindWriteTx` ("so CFC boundary-commit read-then-writes
retain their preconditions", reactivity-log.ts). That read enters
`buildReads`' commit set with no exclusion — `pushCommitRead` names
every pending layer of the doc, speculative included — so when the
client's own `startEditing` seed echo still stands on the draft doc,
the commit's basis names the echo layer and `commitOperations` refuses
terminally. Nothing renders, nothing retries; the DOM keeps the typed
text (the input element's own value), the store never sees it.

The refusal is LOUD in the worker (`logger.error`) but the worker
console is not forwarded to the page by default
(`forwardWorkerConsole` host toggle, off), which is why #6187's gate
observed "no refusal surfaces anywhere".

## 2. Method — the instrumented client (S-E's method, extended)

Console taps (`[NDT]` prefix, value/path-filtered to the draft flow)
across: DOM-side `CellHandle.set` → worker `applyCellWrite` (+ the
fire-and-forget `tx.commit()` outcome) → `commitOperations` build
(ops, per-read layer lists, the standing speculative set) → both §6
refusal sites → push rejection / `confirmPending` / `dropPending` →
the echo lifecycle in `overlay-destination.ts` (seal, late-echo drop,
retire-by-intent, sweep holds with reasons, retire-by-sweep,
supersede) → a per-read census at `buildReads` naming each draft-doc
read's marker metadata and drop-rule disposition. Two harness aids
(also on the triage branch): `FORWARD_WORKER_CONSOLE=1` seeds the
worker-console host toggle before login, and forwarded `[worker]`
errors are excluded from the console-error gate so verdicts stay
comparable with the un-forwarded protocol.

Gate protocol per the arc: ON toolshed binary
(`EXPERIMENTAL_SERVER_EXECUTION=true deno task build-binaries
toolshed`), per-iteration fresh store (`MEMORY_DIR=file://…` fresh per
run), self-referential `API_URL`/`MEMORY_URL` on the server env,
posture verified per run (`/api/meta` `shellServerExecutionDefine` +
`/api/health/stats` `servingLoop`), browser-process hygiene between
runs, load averages recorded, per-run store snapshots queried after
teardown (never the render).

## 3. The red trace (post-fix arm, run 7; run 9 identical)

Worker-realm timeline (t = ms mod 1e6; draft doc `of:fid1:WNFC1igb…`,
editing doc `of:fid1:vbL0qaNw…`):

```
t=376871  spec-layer-add localSeq:6   ops: editing/value=true,
                                      nameDraft/value="Ada Lovelace", …
t=376872  echo-seal      localSeq:6   eventId evt:bf2d4b62 (the Edit
                                      click), floor 36
t=376872…891  sweep-hold ×5 localSeq:6 reason=unarrived,
          doc=<editing doc>, floor 36, watermark 38  — coverage
          satisfied, the ARRIVAL gate holds the echo (the served
          startEditing frame not yet confirmed on this replica)
t=376958  cellwrite blind nameDraft "Grace Hopper"
t=376959  commit-build localSeq:11
            ops:  [patch nameDraft /value="Grace Hopper"]   (ONE op)
            pending: [{id: nameDraft, path: [], layers: 6,
                       nr: FALSE, basis: 18}]                (the CFC
                       verifier read — names the echo layer)
            confirmedReads: 1                                (the
                       structural read — OW47 fix working: layers
                       excluded, lands confirmed)
            spec: [6,7,8,9,10]
t=376959  REFUSAL localSeq:11 speculativeLayers:[6]
t=376962  cellwrite-tx-outcome ok:false "authored commit refused: its
          read basis names speculative overlay layer(s) 6 …"
t=376962  cellwrite (the input/change double-dispatch retry)
t=376963  commit-build localSeq:12 — identical shape
t=376963  REFUSAL localSeq:12 speculativeLayers:[6]  — terminal; the
          typed name is dead
t=376970  echo-retire-sweep localSeq:6  ← the echo retires ELEVEN
          MILLISECONDS after the second refusal (the served frame
          arrived)
t=377066  cellwrite blind bioDraft "Countess of computing." →
t=377103  confirm seq 46 — the bio fill, ~100 ms later, sails through
          (no standing layer)
```

The green control (8/10 runs + the smoke): the same commit shape —
`pending: []`, `confirmedReads: 1`, `spec: []` — the seed echo retired
BEFORE the fill (in the smoke, 78 ms seal→fill and the set was already
empty). Green vs red is exactly whether the served round trip
(Edit-click event → served run → wave commit → push → client confirm →
arrival-gated retirement) beats the test's next action (~90 ms later);
the race is fine-grained timing, consistent with #6187's "not
load-correlated" observation.

Every run falls into one of THREE timing regimes at the fill:

1. **Seed echo sealed early, served frame arrived first** → echo
   retired 2–53 ms before the fill → clean export (every green with a
   standing seed; the margin is single-digit ms in several greens —
   one main-arm green survived by 2 ms).
2. **Seed echo sealed LATE** (the client's speculative startEditing
   ran after the served consequence already arrived) → the late-echo
   rule DROPS its writes at seal → no layer ever stands → structurally
   safe (3 pre-arm greens-at-the-fill).
3. **Fill lands inside the standing window** → both commit attempts
   refused, terminal → the loss (post reds: retire +12/+4 ms after the
   fill; pre-arm draft-loss runs: +4/+17 ms; main-arm red: +14 ms).

The knife edge between regimes 1 and 3 measured 2–17 ms across the
thirty runs.

## 4. Store forensics — one correction to #6187's structural trace

The reviewer's red-flow reading was "the served `saveName` no-ops on
the EMPTY draft". The stores say otherwise, both reds:

- TEST space, draft doc history: creation (authored), the served
  startEditing SEED — a derived-class commit patching
  `/value="Ada Lovelace"` — and NO authored "Grace Hopper" commit.
  The server-side seed resolved and landed in every run, red and
  green.
- PROFILE space: an authored eventAppend + derived consequence pair
  carrying **"Ada Lovelace"** — the served `saveName` READ THE SEED
  and SENT `{name: "Ada Lovelace"}`; the amend chain (outbox →
  delivery → profile wave) worked end to end, with the STALE SEED
  value. The bio pair carries "Countess of computing." in the same
  runs.

So the red is not "no amend": it is **the user's typed value replaced
by the seed value** — the badge shows "Ada Lovelace", the test waits
for "Grace Hopper" 300 s. Arguably worse than a visible failure: a
wrong-value amend with no error surfaced anywhere the user (or the
un-forwarded gate) looks. #6187's "0 Grace Hopper commits" and "zero
isolation errors" both reproduce exactly; only the "empty draft
no-op" inference was off (it inferred the draft state from the
missing target value rather than the store's seed commit).

## 5. Rates (instrumented protocol, fresh store per run)

**The headline: the DRAFT-LOSS rate is one knife-edge rate on every
arm — 2/10 pre-fix, 2/10 post-fix, 1/10 merged main — identical
signature throughout.** #6187 neither created nor re-rated this
defect — it
UNMASKED it: pre-fix, every run also carried the send-site kill
(4 `StorageTransactionWriteIsolationError` per run, name amend
durable in ZERO runs), so a draft-loss run was indistinguishable
inside an already-red gate; post-fix it is the only remaining red.
The open "did #6187 change the rate of a pre-existing race" question
closes as NO CHANGE (2/10 vs 2/10; same mechanism, same margins).

| arm | binary | test verdicts | draft-loss runs (refusal + fill non-durable) | send-site iso errors | name amend durable |
|---|---|---|---|---|---|
| post-fix | #6187 head `455c8a75c` + taps | 8 green / 2 red | 2/10 (runs 7, 9) | 0 in all runs | 8/10 (the 2 draft-loss runs amend the stale seed instead) |
| pre-fix | main `b775787b6` + taps | 1 green / 9 red | 2/10 (runs 4, 8) | 4 in EVERY run | 0/10 (send-site kill; greens ride the echo) |
| merged main | `d6dd4fc31` + taps + census | 9 green / 1 red | 1/10 (run 4) | 0 in all runs | 9/10 (the draft-loss run amends the stale seed) |

Post-fix per-run decomposition (seed-echo seal/retire relative to the
fill; negative = before):

| run | verdict | dur | draft refusals | fill durable | seed seal/retire vs fill |
|---|---|---|---|---|---|
| 1 | green | 16s | 0 | yes | −68 / −26 ms |
| 2 | green | 15s | 0 | yes | −74 / −22 ms |
| 3 | green | 14s | 0 | yes | −71 / −6 ms |
| 4 | green | 12s | 0 | yes | −42 / −12 ms |
| 5 | green | 9s | 0 | yes | −38 / −3 ms |
| 6 | green | 17s | 0 | yes | −84 / −30 ms |
| 7 | **RED** | 319s | **2** | **no** | −87 / **+12 ms** |
| 8 | green | 12s | 0 | yes | −58 / −25 ms |
| 9 | **RED** | 312s | **2** | **no** | −45 / **+4 ms** |
| 10 | green | 16s | 0 | yes | −53 / −17 ms |

Pre-fix per-run decomposition (all runs additionally carry the
send-site class: iso=4, profile amend never durable):

| run | verdict | dur | draft refusals | fill durable | seed seal/retire vs fill |
|---|---|---|---|---|---|
| 1 | RED | 310s | 0 | yes | −38 / −17 ms |
| 2 | green | 19s | 0 | yes | seed late-dropped (regime 2) |
| 3 | RED | 317s | 0 | yes | −61 / −24 ms |
| 4 | RED | 309s | **2** | **no** | −35 / **+4 ms** |
| 5 | RED | 321s | 0 | yes | seed late-dropped (regime 2) |
| 6 | RED | 317s | 0 | yes | −91 / −41 ms |
| 7 | RED | 317s | 0 | yes | seed late-dropped (regime 2) |
| 8 | RED | 320s | **2** | **no** | −89 / **+17 ms** |
| 9 | RED | 326s | 0 | yes | −121 / −53 ms |
| 10 | RED | 319s | 0 | yes | −76 / −29 ms |

Post-fix verdicts 8/2 match #6187's 7/3 — the instrumentation did not
perturb the race. Loads 6–33 (1-min avg) across the twenty runs;
draft-loss runs sat at 7.3–11.8 while several clean runs sat higher —
load-uncorrelated, as #6187 observed. (The pre arm's 1/9 verdict
split vs the OW49 report's 4/10 is the echo-green lottery on the
DIFFERENT, send-site family — not this defect.)

Arm-relationship note: mid-triage, #6187 MERGED to main
(`89deb7505`, 2026-08-22T03:22Z; #6186/OW54 after it). The pre-fix
arm is the merge's parent (`b775787b6`, carrying #6083
content-addressed schemas); the post-fix arm is the PR head (fix
without #6083). The two arms therefore BRACKET merged main, and the
identical mechanism on both sides shows the defect is independent of
both #6187 and #6083. A third arm on merged main (`d6dd4fc31` + the
taps + the read census) confirms the residual on main proper: §6.

## 6. The producer, named (read census — merged-main arm)

A third arm on merged main (`d6dd4fc31` = #6187 + #6186 landed, plus
the taps and a per-read census at `buildReads` printing each
draft-doc read's path, recursion, journal index, marker metadata, and
drop-rule disposition) makes the identification empirical. The fill
commit's complete draft-doc read census (main arm run 1, green;
identical shape every run):

```
j=0  ["value","/","link@1"] nr:false  linkResolutionProbe + ignoreReadForCommit  → dropped
j=1  ["value","/","link@1"] nr:false  linkResolutionProbe + ignoreReadForCommit  → dropped
j=2  ["value"]              nr:false  ignoreReadForScheduling + ignoreReadForCommit → dropped
j=3  ["cfc"]                nr:false  internalVerifierRead + ignoreReadForCommit → dropped
j=4  ["value","/","link@1"] nr:false  linkResolutionProbe + ignoreReadForCommit  → dropped
j=5  ["value"]              nr:false  markReadAsAttemptedWrite + allowMutable
                                      + ignoreReadForCommit                      → dropped
j=7  []                     nr:false  ignoreReadForScheduling
                                      + internalVerifierRead                     → KEPT
```

Every read issued inside the blind window carries
`ignoreReadForCommit` and is dropped — including a `["cfc"]` verifier
read (j=3). **The single kept, layer-naming-capable read is j=7: the
CFC prepare pass's internal-verifier read of the write-target doc at
path `[]`, recursive, issued AFTER `unmarkUiInputBlindWriteTx`** —
`storedMetadataFor` (`cfc/prepare.ts` ~:796, `INTERNAL_VERIFIER_META
= ignoreReadForScheduling + internalVerifierRead`). In greens it
lands in the confirmed bucket (compacted with the structural read to
`confirmedReads: 1`); under a standing seed echo it names the echo
layer and the §6 refusal fires.

`buildReads`' drop rules test neither of the verifier markers
(`isReadIgnoredForCommit`; `isReadExcludedFromConflict` +
nonRecursive; the mergeable-op set). The sharp edge: **CFC's own
prefix-provenance digest deliberately EXCLUDES verifier-marked
reads** ("runtime-internal … noise that must not perturb the
enforcement identity", extended-storage-transaction.ts ~:1480) — the
same read the commit basis counts as a full value dependency.

Main-arm gate (merged main `d6dd4fc31` + taps, same protocol): **9
green / 1 red**; the red (run 4) is the identical signature — 2
refusals on the draft, fill non-durable, seed seal −93 ms / retire
**+14 ms** vs the fill, setName sends the stale seed, bio durable,
zero isolation errors — and its refused commit's census is the block
above with the pending read naming that run's echo layer. Greens:
retire 2–45 ms before the fill (run 5 survived by 2 ms), one
late-dropped seed (regime 2). The draft-loss rate across the three
arms — 2/10 pre-fix, 2/10 post-fix, 1/10 merged main — is
statistically one rate; the mechanism is invariant across #6187 and
#6083.

## 7. The profile-lease side-check (question 3)

"The profile space never activates a serving wave" does NOT reproduce
on any arm. Every run, red and green, all three arms: the profile
space's store carries derived-class commits with a `holder` (10–11 of
15–17 commits), and the server log's `wave serving` lines name the
profile space (~94–100 mentions/run). The OW49-report observation is
confirmed stale at ≥ `ec6361782`, closing the reviewer's PLAUSIBLE.
(Live `execution_lease` rows are empty in post-teardown snapshots —
leases are cleaned at shutdown; the holder column on derived commits
is the durable evidence.)

## 8. Register mapping proposal (question 4)

**Re-open OW47 (same family, second producer) rather than mint a new
row.** The row's own mechanism sentence — "the basis named the layer
only because layer-naming in `pushCommitRead` is per-DOC, not
per-value-dependency" — describes THIS defect verbatim; the fix
covered one producer (the blind write's structural read) and §5 of
the OW47 report flagged this exact corner open ("CFC-label reads of a
blind write could in principle also name a standing echo layer …
left refusing loudly rather than widening the exclusion"), missing
only that the CFC read is at path `[]` (whole doc, every blind write)
rather than `["cfc"]`, so no cfc-label echo write is needed — the
per-DOC naming makes any standing echo sufficient. Proposed row
state: RE-OPENED with this report as the trace, the fork below as the
owed decision. The profile-embed skip entry stays; its reason should
name the CFC-verifier-read producer. Coordinator decides at merge.

## 9. The fork — why no fix ships here (flag-don't-fill)

The mechanism is determined; the fix is not. Every repair decides an
unstated semantic on the §6 contract or the CFC prepare contract:

- **(a) `buildReads` drops `internalVerifierRead` reads from the
  commit set** (the digest-exclusion argument extended to the basis).
  Decides that CFC metadata reads carry NO concurrency precondition —
  a concurrent metadata change no longer conflicts the commit.
  Whether client-side label derivation may commit against
  potentially-stale metadata without conflict-retry is a CFC-owner
  call (the server re-enforces at admission, but the client-side
  derivation writes `/cfc` ops the server admits).
- **(b) the verifier read bases on the doc's NON-speculative stack**
  (the OW47 fix's seam, extended): honest only if the READ VALUE also
  comes from the non-speculative stack — i.e. CFC prepare derives
  from durable metadata while an own-echo stands. Changes CFC's
  derivation input; arguably MORE correct (the echo never reaches the
  wire, so the server enforces against exactly the durable state the
  client would now read — today the client derives from state the
  server can never see), but that argument is mine, not ruled text.
  The echo CLASS does write `/cfc` (observed on the bio draft's save
  echo in these traces), so the two bases genuinely diverge in
  general; in the traced reds the seed echo's draft patch was
  value-only, so (b) would have produced the identical derivation
  there.
- **(c) narrow `storedMetadataFor` to path `["cfc"]`** — INERT for
  this defect: `pushCommitRead` names layers per-DOC below the
  commit, so any read of the doc names the echo layer regardless of
  path. Recorded to kill the tempting shallow fix.
- **(d) hold the UI input until the echo retires** — refused by
  design ("a client settle must not wait on the echo's retirement",
  storage/v2.ts; the arrival gate's standing window is unbounded for
  a never-served instance, so this converts loss into indefinite
  input-freeze).

The OW47 fix pass already looked at this corner and chose "refuse
loudly rather than widen" — with the observed consequence now known:
the refusal is not loud where users look, and the served save then
amends the STALE SEED value. The decision is the CFC owner's + the §6
ruling owner's; (b) is the coordinator-shaped recommendation if the
owners rule that CFC prepare's write-target metadata read should see
what the server will see.

Also flagged in passing (separate families, not this defect):

- The worker-side silent CFC rejection class observed in GREEN runs:
  "CFC enforcement rejected commit: relevant transaction was not
  prepared: stored schemaHash … missing or unreadable"
  (`cfc/prepare.ts` `loadSchemaDocument`) plus the OW49-shaped
  "Can't report … in the surface it belongs to" when the error
  report's own write is also refused — wish-envelope maintenance
  commits dying silently in the worker. Invisible pre-forwarding;
  deserves its own look (OW50's surface-report machinery reaches the
  "Can't report" arm).
- `fillCfInput`/cf-input double-dispatch: each fill issues the CellSet
  twice (input + change); the second is elided as a no-change set in
  greens and doubles the refusal in reds (~4 ms apart — both attempts
  landed inside the window in every observed loss). Harmless, noted
  for trace readers.
- One harness-realm (test-process runtime, ON posture)
  `speculative-basis-refused` observed in a GREEN main-arm run, on a
  SummaryIndex `$UI` value write whose pending read named a standing
  layer of another doc — a different surface (plausibly the
  OW33-family Deno-client-under-ON cluster), did not affect the
  verdict; recorded, not analyzed.

## 10. Artifacts

- Instrumentation + harness aids: branch
  `claude/server-exec-v2-name-draft-triage` (`533d874c7` taps,
  `2e7976d48` worker-console seed, `930f0269d` observation-only
  gate exclusion, `83fe82dab` read census, `865e7f32f` merge of
  landed main under the taps).
- Per-run captures (test log with piped worker console, server log,
  posture, stats, store snapshot, load averages): scratchpad
  `gate/{post,pre,main}/run1..10` on the triage machine; the decisive
  extracts are inlined above.
- Binaries: post-fix arm at `455c8a75c` + taps (local cherry-picks
  `96742355e`/`2ad658d93`/… — the in-flight branch itself untouched);
  pre-fix arm at `b775787b6` + taps; merged-main arm at `d6dd4fc31` +
  taps + census.
- The triage branch is a WORKING RECORD, not a merge candidate: the
  `[NDT]` taps in `storage/v2.ts`, `overlay-destination.ts`,
  `runtime-processor.ts`, and `cell-handle.ts` are scratch
  instrumentation and must not land. The two `packages/integration`
  aids (`FORWARD_WORKER_CONSOLE` seeding + the observation-only
  exclusion) are env-gated no-ops by default and are the one part
  worth considering for a real landing, separately.
