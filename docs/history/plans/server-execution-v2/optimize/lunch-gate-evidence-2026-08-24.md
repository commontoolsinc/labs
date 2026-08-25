# lunch-poll ON-skip lift gate — measurement report

*Archived verbatim 2026-08-24; the raw run artifacts it cites — the 11 run
directories with their logs, stores and stats, the `probes/` runs,
`final-ledger.txt` and the harness — are not in the repo and live on the
measuring box at `/Users/berni/labs-worktrees/lunch-lift-evidence/`.*

Seat: run the lunch-poll gate evidence campaign at the merged head and,
if the bar holds, lift the FILE entry for
`integration/lunch-poll-vote.test.ts` from
`tasks/server-execution-on-skips.ts`. The entry's merge note is explicit
that it "lifts on its own gate evidence at the merged head, never by
inference" from the default-app gate. This file is that evidence.

- Worktree: `/Users/berni/labs-worktrees/lunch-lift`
- Branch: `claude/server-exec-v2-lunch-lift`, base `origin/main`
- Head: `f14e44830480b6dc07c42a88586caf43b8a566df` — the merge of PR #6224
  (OW45 arm B, catch-up-and-start)
- ON binary: `dist/toolshed`, built at that head with
  `COMMIT_SHA=$(git rev-parse HEAD) EXPERIMENTAL_SERVER_EXECUTION=true
  deno task --no-lock build-binaries toolshed`
- Binary sha256:
  `ce65782063f4f14a13b120a018274c86dcacb5bf07a2fe00c58cdc33732d5c81`
- Evidence dir (untracked, outside the checkout):
  `/Users/berni/labs-worktrees/lunch-lift-evidence/` — `runs/r00…r10/`
  each holding `ledger.txt`, `test.log`, `toolshed.log`, `meta.json`,
  `stats.json` and that run's fresh `memory/` store; `probes/p1…p3/`
  for the side probe; `campaign.log`, `final-ledger.txt`, and the
  harness (`run-gate.sh`, `campaign.sh`, `probe-ensure-on.sh`,
  `extract-ledger.py`).

## Method (as prescribed, unchanged)

Per `catchup-start-build-report.md` §"The lunch-poll FILE entry: gate
method for the lift seat":

1. ON binary built at the merged head; sha256 recorded above and
   re-verified into every run's ledger line.
2. The lunch-poll FILE entry NEUTRALIZED in the working tree for all
   runs (41 lines removed from
   `tasks/server-execution-on-skips.ts`; the file's `--ignore` stdout is
   empty for `patterns` with only the default-app STEP entry left). The
   tree was held at exactly that one-file diff for the whole campaign —
   every run's ledger records `tree_dirty` so the stability is on the
   record rather than asserted. The file's actually having RUN is
   verified per run from the `running 1 test from
   ./integration/lunch-poll-vote.test.ts` line.
3. Per run: fresh store (`MEMORY_DIR="file://$RUN_DIR/memory/"` — a
   file:// URL), own 97xx port, `CFTS_AI_GATEWAY_URL=""
   CFTS_AI_LLM_ANTHROPIC_API_KEY=fake EXPERIMENTAL_SERVER_EXECUTION=true
   SERVER_EXECUTION_ENSURE_SPACE_ROOTS=false`, `./dist/toolshed
   --port=$PORT --background --log-file=…`. PID-only kills (the PID is
   read from the background launcher's own "(pid N)" line); a port-free
   check follows every run.
4. Posture probe per run before the gate: `/api/meta`
   `.shellServerExecutionDefine == "true"` AND `/api/health/stats`
   `.servingLoop != null`.
5. The gate, from `packages/patterns`: `HEADLESS=1
   API_URL=http://localhost:$PORT/ EXPERIMENTAL_SERVER_EXECUTION=true
   SERVER_EXECUTION_ENSURE_SPACE_ROOTS=false FORWARD_WORKER_CONSOLE=1
   PIPE_CONSOLE=1 timeout 600 deno test --no-lock --no-check
   --v8-flags=--max-old-space-size=4096 -A
   integration/lunch-poll-vote.test.ts`. The 600 s cap is the harness
   bound and was never raised.
6. Campaign: 10 counted runs, 5 quiet + 5 loaded, INTERLEAVED
   (r01/r03/r05/r07/r09 quiet, r02/r04/r06/r08/r10 loaded) so neither
   arm inherits the other's position in the sequence. Loaded = 6 pinned
   CPU spinners, PID-tracked and killed per run, with 45 s of spin-up
   before the server starts so the load is actually in the run. Load
   averages recorded before and after either way. r00 is a smoke run and
   is NOT counted.
7. Step verdicts parsed AFTER the line's last `" ..."` so a word
   containing "ok" cannot false-positive (the prior campaign's own
   extractor bug: "notebook").

Posture note: this invocation matches the CI ON pattern-shard step
byte-for-byte on the posture-bearing variables (`HEADLESS`, `API_URL`,
`EXPERIMENTAL_SERVER_EXECUTION=true`,
`SERVER_EXECUTION_ENSURE_SPACE_ROOTS=false`, `--no-check`,
`--v8-flags=--max-old-space-size=4096`). The two additions —
`FORWARD_WORKER_CONSOLE=1 PIPE_CONSOLE=1` — are the method's
instrumentation and are observation-only by construction (the
console-error gate excludes `[worker]`-prefixed lines so forwarding
cannot change a verdict).

Instrument check, done before trusting any count: the browser worker's
console bridge covers `log`, `warn` AND `error`
(`packages/runtime-client/backends/web-worker/index.ts`
`installWorkerConsoleBridge`), the transport re-emits each as
`[worker] …` on the page console, and `PIPE_CONSOLE` puts the page
console in the test output. The bridge was verified LIVE in the logs at
all three levels: `Browser Console [log]: [worker] Experimental flag
overrides:` in every run, and `Browser Console [error]: [worker] …`
lines carrying real runner diagnostics — including a browser-side
`piece-start-commit-failed` with its full ConflictError payload. So the
per-run counts cover BOTH the Deno controller's runtime and the two
browsers' — the client the entry is actually about. This mattered: the
"forwarding is OFF" info line that appears at initial page load is
printed before the seed and is stale, not a blind instrument. It is why
"the reds are SILENT" below is a finding rather than an artifact.

## Ledger

**7/10 green. The 10/10 bar is NOT met. No lift.**

`catch` = `deferred-start-catchup` lines; `cfail` =
`deferred-start-catchup-failed`; `txdef` = `Error committing deferred …`
(the b04 terminal death); `pscf` = `piece-start-commit-failed` (the
sibling arm, see below); `stale` = stale confirmed/pending read lines;
`ple` = `pattern-load-error`. `ran` = the run's count of `running 1 test
from ./integration/lunch-poll-vote.test.ts` — 1 in every run, so the
file executed every time. Counts are grep-line counts, per the method's
ledger, and cover the Deno controller AND both browser workers.

```
run  mode    rc  wall  load(b/a)      step   ran catch cfail txdef pscf stale ple  steptime
r00  quiet   1   316s  3.76/2.52      RED    1   1     0     0     1    2     0    3413ms   (smoke, NOT counted)
r01  quiet   0    19s  1.67/2.36      GREEN  1   1     0     0     1    2     0    4086ms
r02  loaded  1   322s  2.17/15.46     RED    1   1     0     0     1    2     0    4737ms
r03  quiet   0    21s  15.46/13.92    GREEN  1   1     0     0     2    3     0    4812ms
r04  loaded  0    26s  13.92/11.49    GREEN  1   1     0     0     1    2     0    5325ms
r05  quiet   1   313s  10.81/3.31     RED    1   1     0     0     1    2     0    2765ms
r06  loaded  0    39s  3.31/11.92     GREEN  1   1     0     0     2    3     0    6810ms
r07  quiet   0    19s  11.21/9.28     GREEN  1   1     0     0     1    2     0    3420ms
r08  loaded  0    31s  9.28/9.80      GREEN  1   1     0     0     1    2     0    5671ms
r09  quiet   1   322s  9.80/10.57     RED    1   1     0     0     1    2     0    5183ms
r10  loaded  0    34s  9.89/10.21     GREEN  1   1     0     0     2    2     0    6749ms
```

Counted totals (r00 excluded): **7/10 green**; catchup activations
**10** (one per run, every run); `deferred-start-catchup-failed`
**0**; terminal `Error committing deferred …` **0**;
`pattern-load-error` **0**.

Green steps run **19–39 s**. Every red is the 300 s
`waitForCondition` net plus setup, i.e. 313–322 s wall — the timeout is
the test's own, never the 600 s harness bound, which was never hit and
never raised.

Reds by arm: **2 quiet (r05, r09) and 1 loaded (r02)** — plus the r00
smoke, quiet. The failure is not load-driven; if anything the quiet arm
fared worse. Load averages spanned 1.7–15.5 with no relationship to the
verdict.

Hygiene, every run: `shellServerExecutionDefine == "true"`,
`servingLoop` present, `port_free_after=yes`, and the working tree at
exactly the one-file neutralization diff (`M
tasks/server-execution-on-skips.ts`, 41 deletions) — recorded in each
run's own ledger line, so tree stability across the campaign is
evidenced rather than asserted.

### The green/red separator, 11 runs out of 11

Two independent signals separate the arms perfectly, including the
smoke run:

```
run  verdict  profile spaces (commits, serverLogMentions)   identity homes   browser warn/err
r00  RED      [(16, 186), (4, 0)]                           [4, 2]           SILENT
r01  GREEN    [(15,  63), (14, 186)]                        [4, 4]           5
r02  RED      [(13, 169), (4, 0)]                           [4, 2]           SILENT
r03  GREEN    [(16, 177), (14, 123)]                        [4, 4]           9
r04  GREEN    [(19, 132), (17,  57)]                        [4, 4]           6
r05  RED      [(16, 186), (4, 0)]                           [4, 2]           SILENT
r06  GREEN    [(21, 147), (16,  60)]                        [4, 4]           11
r07  GREEN    [(16,  66), (15, 216)]                        [4, 4]           7
r08  GREEN    [(18, 141), (15,  57)]                        [4, 4]           12
r09  RED      [(14, 186), (4, 0)]                           [4, 2]           1
r10  GREEN    [(19, 189), (16,  66)]                        [4, 4]           14
```

In every RED the guest's profile space holds exactly **4 commits, no
`patternIdentity` in any of them, and 0 mentions in the server's own
log**, and the guest's identity home space holds 2 instead of 4. In
every GREEN both profile spaces reach 14–21 commits, both carry
`patternIdentity`, and both are named 57–216 times by the server.

The reds are also SILENT: no browser-side warn or error at all in r00,
r02, r05, and exactly one line in r09. Greens emit 5–14
(`CFC enforcement rejected`, `speculative-basis-refused` — designed,
non-fatal). The client says nothing when it fails and complains when it
succeeds.

## What the recovery did, live

The catch-up-and-start recovery behaved exactly as PR #6224's merge note
predicted, in every run of both arms:

- `deferred-start-catchup` WARN fired in EVERY one of the 11 runs
  (10 activations across the counted 10), in both arms and in reds as
  well as greens.
- `deferred-start-catchup-failed`: **0** across the whole campaign.
- `Error committing deferred …` (the b04 terminal death the entry's
  recorded reds carry): **0** across the whole campaign.

So the shape shift the seat was told to expect DID occur, and the
entry's own recorded death — "the flag-ON client's deferred start of the
freshly created piece dies terminally on a stale-confirmed-read
ConflictError" — did not reproduce even once. The entry's *recorded*
mechanism is closed.

The file still does not green, for a different reason.

## The red: classification

Every red is the same failure, at the same place, with the same
signature: `Timed out waiting for #lp-join-button to render` at
`lunch-poll-vote.test.ts:306` — the **GUEST's** join click. The host
always joins. The probe body shows the join card still rendering
`Unknown profile` / `Create profile`: the viewer's `#profile` wish never
resolves. Everything before it passes in seconds (measured steps total
3.4–5.3 s in red runs too); the wall time is entirely the 300 s
`waitForCondition` net.

The reds are SILENT on both sides — that is what makes the store the
only usable witness.

### The store/log discriminator (separates green from red 11/11)

Each run gets a fresh store. Classifying each space by its seq-1 ACL
(`OWNER == self` = an identity home space; `"*":"WRITE"` + an OWNER = a
shared space) gives the poll space, the host's profile space, and the
guest's profile space. Then, per profile space: commit count, whether
ANY commit in it ever carries `patternIdentity`, and how often the
server's own log names the space.

- **GREEN**: both profile spaces reach 14–19 commits, BOTH carry
  `patternIdentity`, and both are named 57–186 times in the toolshed
  log.
- **RED**: the guest's profile space stalls at **4 commits**, carries
  **no `patternIdentity` in any commit**, and is named **0 times** in
  the toolshed log.

The separation is total — no green run has a patternIdentity-less
profile space, no red run lacks one.

### What actually lands, and what does not

The stalled space is **byte-identical in every red run** — r00, r02 and
r05 (and the later reds) all produce exactly this store and nothing
more:

```
seq=1  authored  337 B      1 op   {of:1}            patternIdentity=False   <- the space ACL
seq=2  derived   167 B      1 op   {of:1}            patternIdentity=False   <- watermark set
seq=3  authored  125187 B   3 ops  {of:2, cid:1}     patternIdentity=False
seq=4  derived   200 B      1 op   {of:1}            patternIdentity=False   <- watermark patch
```

The three ids in `seq=3` are content-addressed and identical across runs
AND across different randomly generated identities — a deterministic,
identity-independent closure fragment, not the guest's own piece.

What is MISSING is the commit that carries `patternIdentity`: in a green
run (and for the HOST's space even inside a red run) the same space also
receives a **~98–101 operation, 76–200 KB authored commit** holding the
piece's root doc, its `computed:` docs and its whole `cid:`
program/schema closure, WITH `patternIdentity`. Only after that commit
does the serving side engage — a fat `derived` commit full of
`computed:` patches — and the space converges over 13–19 commits.

In the reds that commit never arrives. With no pattern meta durable in
the space, the serving loop has nothing to load and never names the
space at all. The `#profile` wish therefore has nothing to resolve, the
join card renders the placeholder forever, and `#lp-join-button` never
appears.

**What the evidence does NOT determine**: whether the missing commit was
refused, dropped, or never issued by the client. The guest's space
appears in NO server-side line — not even in the `foreign-write-refused`
/ `seal-space-commit-failed` refusals that fire 50–73 times per run for
OTHER spaces — so the refusal hypothesis is *not* supported by these
logs, and the write appears never to have reached the server. That link
is the open question this campaign hands on, and it is deliberately not
asserted here.

### Against the OW45 arm-B residue members

The seat was asked to classify the red against the two read-side members
the OW45 row names. It is **neither**, and it is not the closed start
class either:

- **NOT the b04 client-start death.** Zero terminal deferred-start
  deaths and zero recovery failures in the whole campaign; the catchup
  fired in every run and was never followed by either loud failure arm.
  (Strictly, that is the absence of the failure lines, not a positive
  witness of each recovery's success — but the entry's death has an
  unmissable signature and it did not appear once.)
- **NOT r01's silent readCell starvation.** That member is
  store-verified COMPLETE (all appends durable) with the piece context
  fully live and only the read starved. Here the store is *missing the
  program*, and no piece ever ran: there is no live context to starve.
- **NOT r06/r09's stranded whole-piece.** That member fires ONE watcher
  `pattern-load-error` for a keyless identity, and the register is
  explicit that "the durable store's patternIdentity pointers are all
  REAL identities, so the keyless ref is session-side". Here
  `pattern-load-error` count is **0** in every run, and the durable
  store has **no patternIdentity at all** for the affected space. The
  keylessness is DURABLE, not session-side — the opposite of r06/r09.

**What it IS**: the surface the OW45 row opens with — "Under ON the
created piece's program (code + CFC labelMap + schema docs) is only ever
written by the client's own post-arrival commit … nothing re-issues it
… so the space's serving loop parks the structure load forever and the
name renders the `#id` placeholder." That is this failure, verbatim,
including the placeholder — reappearing for a piece the SECOND browser
creates MID-SESSION.

With one important difference from the row's recorded mechanism: there,
the loss route was the server's `compile-cache/writeback` fallback being
refused as a foreign-space write (`seal-space-commit-failed`, "17
refusals per profile space observed"). **S-A fixed that route** (built
2026-08-21, carriage threaded into the writeback stamps). Refusals do
still fire here — 50–73 per run — but they name OTHER spaces, never the
stalled one, and they fire just as often in green runs. So this is not
S-A regressing: the client's program commit for the guest's space
appears never to reach the server at all, which is a different route to
the same parked end state.

Two things make it a distinct, reportable member rather than a
re-sighting:

1. **S-B's durability barrier does not cover it.** The test does
   `await waitForRuntimeIdle(guestPage)` immediately after the create
   (`lunch-poll-vote.test.ts`, and the host's identical path succeeds
   every time). S-B extended `idleWithPendingCommits` to await pattern
   loads and compile-cache write-backs — but a write that is never
   in flight is not awaited by a barrier over in-flight work.
2. **S-C (heal-on-read) was SKIPPED BY RULING** on the stated evidence
   that it "sits OFF the lift critical path" because "the home-profile
   durability test's own contract runs every create through
   `waitForRuntimeIdle` — S-B's barrier — before any reload". This
   surface has **no reload at all**, runs the create through
   `waitForRuntimeIdle`, and still loses the program in every red run of
   this campaign. The premise of that ruling does not reach this case.
   Flagged for the owner, not acted on.

There is also a THIRD arm worth recording because it looked like the
culprit and is not: `piece-start-commit-failed` — the sibling
piece-instantiate commit whose error arm has NO catch-up recovery
wired to it (`runner.ts` `reportPieceStartCommitFailure`, vs the
deferred-start arm's `catchUpAndStartOnStaleRead`). It fires on the same
stale-confirmed-read family, and the register already carries it as an
open residual ("the client-instantiate-vs-server-derive race at piece
creation is pre-existing and only softened, not closed"). It fires in
GREEN runs as often as in red ones, so it is **not** this file's
discriminator. Recorded so the next seat does not re-derive it.

Observability note: OW46's `structure-load-stuck` counter — built to
make dead spaces visible — fires 6 times per run in BOTH arms, and in
the reds it names only the HOST's space. It cannot see this failure,
because the counter counts *deferred structure loads of demanded roots*
and this space's root is never demanded at all.

## Side probe (DIAGNOSTIC — not part of the gate, not in the ledger)

The gate's posture is `SERVER_EXECUTION_ENSURE_SPACE_ROOTS=false`,
deliberately, because that is the CI ON lane's posture and therefore
what a lifted file would actually run under. Since the red is a
freshly-created space the serving side never engages with, the obvious
question is whether the OW45 arm-B space-root ensure (stage 1) would
rescue it. Three runs were made with ONLY that variable flipped to
`true`, after the campaign closed, into a separate `probes/` directory.

**3/3 RED, and red EARLIER and differently.** All three fail at
`Timed out filling cf input "#wish-profile-name-input" with "Alice"` —
the HOST's profile-create surface never renders at all, 300 s, before
the campaign's failure point is even reached. Their stores show NO
profile space created whatsoever (the campaign's reds at least create
the guest's space and put the create commit in it).

Two conclusions, both narrow:

1. Flipping the ensure ON does **not** green this file, so "the lane's
   ensure-off posture is the cause" is ruled out as an explanation of
   the campaign's reds.
2. `SERVER_EXECUTION_ENSURE_SPACE_ROOTS=true` is a strictly worse
   regime for this file — deterministically fatal at the first profile
   create in 3/3. That is worth someone's attention independently of
   this seat, but n=3 on a non-sanctioned posture is a lead, not a
   finding, and it is recorded as such.

## Disposition

**NO LIFT. The entry STAYS, unchanged.**

The bar the merge note set is 10/10 at the merged head on the entry's
own gate evidence. The campaign returned **7/10**, with a reproducible
red that is neither the class the entry names nor either of the two
residue members the OW45 row names. Per the instruction ("Any red → NO
lift"), nothing was changed in the repository:

- `tasks/server-execution-on-skips.ts` — the working-tree
  neutralization used for the campaign has been REVERTED; the FILE
  entry for `integration/lunch-poll-vote.test.ts` stands exactly as
  merged.
- No change to `tasks/server-execution-on-skips.test.ts`,
  `.github/workflows/deno.yml`, `docs/plans/server-execution-v2.md`, or
  `docs/specs/server-side-execution/verification-coverage.md`. Those
  edits were scoped to the lift case only, and the lift did not happen.
- No PR opened. Branch `claude/server-exec-v2-lunch-lift` carries no
  commits and sits at `origin/main`'s `f14e44830`; the worktree's only
  content is the reverted checkout. The evidence lives outside the
  checkout, in `/Users/berni/labs-worktrees/lunch-lift-evidence/`
  (11 run directories with logs and stores, `final-ledger.txt`, the
  harness scripts) and in this report.

### What the next seat should NOT have to re-derive

1. **The entry's recorded mechanism is closed.** Zero terminal
   deferred-start deaths and zero recovery failures in 11 runs; the
   catchup fires every run. If anyone re-reads the entry's reason
   ("dies terminally on a stale-confirmed-read ConflictError"), that
   sentence no longer describes what this file does when it fails.
2. **The current red is a THIRD member**, on the write/materialization
   side: the viewer's mid-session-created profile piece never gets its
   `patternIdentity` and program closure written into its own space, so
   the serving loop never engages with that space at all and the
   `#profile` wish has nothing to resolve. Store-and-log verified,
   11/11 separation. Details and the negative results are in "The red:
   classification" above.
3. **`piece-start-commit-failed` is NOT the discriminator.** It fires
   1–2 times per run in green runs too (13 across the campaign). It is
   a real unrecovered arm — the catch-up recovery is wired only to the
   deferred-start commit, not to the piece-instantiate one — and the
   register already tracks it, but it does not explain this file's
   reds. It cost this seat real time to rule out.
4. **OW46's `structure-load-stuck` cannot see this failure.** It fires
   6× per run in both arms and names only the host's space; the stalled
   space's root is never demanded, so the counter built for dead spaces
   never counts it.

### Flagged, not acted on

- **The S-C skip ruling's premise does not reach this surface.** S-C
  (heal-on-read) was skipped on the reasoning that every create runs
  through `waitForRuntimeIdle` before any reload. This failure involves
  no reload, does run the create through `waitForRuntimeIdle`, and
  still loses the program in 3 of 10 runs. Whether that reopens S-C is
  an owner call, not a measurement call.
- **The last causal link is not established.** The evidence shows the
  program commit is absent from the store and the space is absent from
  the server log. It does NOT show whether that commit was refused,
  dropped in flight, or never issued. The `foreign-write-refused` /
  `seal-space-commit-failed` refusals present in every run (50–73) name
  other spaces and fire equally in greens, so they are not it. Naming a
  cause beyond this would be inference, and the entry's own merge note
  is explicit that inference is not evidence.
