---
status: historical
created: 2026-08-23
archived: 2026-08-23
reason: "OW45 arm-B server-ensure STAGE 1 build report (the #6209 design's stage 1, owner-green-lit 2026-08-23): the space-root ensure — existence + freshness — lands at the SpaceServer's activation as a lease-guarded, single-flight, non-blocking owed step; the client is behaviorally UNCHANGED (stage 2 owns resolve-or-wait). Records the four operating assumptions taken as the design recommended (owner may veto each), the stage-2 gate on the runnability-repair pair, the extraction of the ensure core into the runner, the red-first pins with the OFF witness, and the before/after ambient-load measurement."
---

# OW45 arm B — server-side space-root ensure, stage 1: build report

Seat: stage 1 of the server-ensure design
(`ow45-armb-server-ensure-design.md`, PR #6209, design head `5c1e22e38`),
built on `e55785eff` (origin/main — the same head the design verified
its anchors against). Branch `claude/server-exec-v2-server-ensure-stage1`.

## Scope, stated once

**The server ensures the space-root default pattern exists and is
fresh, at SpaceServer activation. The client is behaviorally UNCHANGED
in this stage.** No client ON branch, no resolve-or-wait, no retirement
of the client's creation path — those are stage 2. What stage 1 changes
is that the server wins most creation races from activation onward; the
ON client's existing `editWithRetry` then usually resolves-early and
never runs its creation arm. Stage 1 does NOT promise the ARM-A refusal
disappears (the client still runs `ensureDefaultPattern`, and on the
fast path still calls `startEnsuredDefaultPattern`, whose deferred
start can still commit child materialization) — the measurement section
reports what actually happens, whichever way it falls.

## Operating assumptions — taken as the design recommended; OWNER MAY VETO EACH

Recorded here per the arc's flag-don't-fill rule. Each is the design's
own recommendation (its §-references), adopted without a fresh ruling;
any of them reverting is a bounded diff, not a redesign.

1. **Attribution: owner-resolved, fail-closed (design §4 option (b)'s
   SNAPSHOT half; open question 2).** The ensure resolves the space's
   ACL owner through a thin public API over the memory server's
   `#resolveSpaceOwnerBinding` — the one ruled service-identity ACL
   read (OW31, 2026-08-19) — and BOTH write halves carry the
   owner-resolved per-run CFC trust snapshot
   (`trustSnapshotForPrincipal(owner)`), the exact follow-up OW59's Q3
   caveat pre-named: the creation transaction (stamped `bookkeeping` +
   snapshot) and, after the adversarial review's F1, the freshness
   half's two write arms (the ensure's snapshot hook threads through
   `checkDefaultPattern` — the update arm runs `runtime.setup` on the
   root, the label-minting class, and shipped first under the ambient
   SERVICE snapshot: OW59's named restage shape, caught by the
   review's live probe, pinned red-first on the minted transactions).
   PRECISION owed to the review's F3: design §4(b)'s ACTING-IDENTITY
   carriage is NOT built — the stamp carries no `acting`, so
   `homeSpacePrincipalFor(tx)`/`getHomeSpaceCell(tx)` would
   fail-closed-throw if a served setup resolved a home space. Inert
   today (the system root patterns resolve no home during setup) and
   consistent with assumption 2's interim, but stage 2's owner-scoped
   custom-URL read is exactly a home-space resolution and needs the
   carriage built first. A space whose ACL yields no concrete owner gets NO
   ensure: skip, warn, count — never the service DID as fallback
   (`homeSpacePrincipalFor`'s posture; OW53's ruled shape). The retry
   cadence is measurement-amended: the design said "retry next tenure"
   under its assumption that an ACTIVE space without an owner is an
   anomaly; run r01 measured it as the NORM for fresh spaces (the host
   activates on session-open, BEFORE the client bootstrap's genesis ACL
   commit — INV-13 makes genesis precede DATA, not ACTIVATION), which
   left the ensure inert on 4/4 gate spaces. The skip now latches
   awaiting-owner and an admitted commit touching the ACL doc
   (`of:<space>`) re-arms the owed ensure in the SAME tenure — the
   identity posture is untouched; the owner may veto the cadence along
   with the rest of this assumption.
   The home-space predicate is re-derived from the ACL (self-owned =
   home): a serving runtime's `userIdentityDID` IS the service DID
   (`runtime.ts:1353`), so the client's `getSpace() === userIdentityDID`
   check and its home read are wrong server-side and are not used.
2. **Custom `defaultAppUrl`: the sanctioned interim only (design §3
   arm (iii) as the interim under recommendation (i); open question
   3).** The server ensure uses the system default-app source for every
   non-home space and logs that posture on the creation path. The
   owner-scoped fetch — a real semantic change (owner's setting instead
   of first-opener's) plus a server-compiles-user-configured-origin
   trust surface extending OW55 — is UNRULED and stays unbuilt.
   Detecting that a custom URL is even configured requires the
   owner-scoped home read, which is the unruled fork itself, so the
   interim logs the posture unconditionally rather than pretending to
   have read the config. Named consequence: while stage 1's server wins
   creation races, a FRESH non-home space whose owner configured a
   custom `defaultAppUrl` gets the system default root where a client
   creation would have used the custom URL; existing roots are
   untouched (the freshness half's admission checks respect stored
   provenance and never swap a custom-source root to the system
   default).
3. **The runnability repair pair is NOT in stage 1 — and is a STAGE-2
   GATE.** The cold-start setup repair and `healDefaultRootByRollForward`
   stay on the client's start path, which stage 1 does not touch. The
   design established (its §2) that both repairs live ONLY there, so
   retiring the client's create-and-start under ON without moving them
   silently retires the only healer of aged roots — an aged space would
   park forever under ON. **Stage 2 must not ship until the repair pair
   moves server-side.** Recorded as a gate, not an aspiration.
4. **ARM-B (`setupDeferredHandlerResultPattern`, `runner.ts:5820`) is
   out of scope**, as the design scoped it (§7): a handler-consequence
   mechanism, accepted 12/12 in every measured run, composing with the
   deferred-start retry work (#6208) rather than with this seat.

## RULED 2026-08-24 — every space gets a root in production; tests get an off switch

The stage-1 CI board (run 32742547103) went red across the ON lanes and
surfaced the scope question the seat reviews could not see: should the
server ensure a default root for EVERY space it activates? The owner
ruled (Berni, 2026-08-24, verbatim):

> "in production there is no reason for a space to not have a default
> pattern, but i can see that for tests this is annoying overhead. so
> let's maybe add a way for tests to disable this. in the simplest form
> that is just a setting in the in-memory version. in the most complex
> form -- real toolshed instance + some spaces actually do need
> defaults and others -- we'll need more design work. `cf test ...`
> almost certainly wants default patterns opt-in, since those tests get
> a bit slower with them and they really aren't needed."

What that settles: (1) NO per-space narrowing — production ensures a
root for every activated space, as built; the mixed case (one toolshed,
some spaces with defaults and some without) is DEFERRED to its own
design work; (2) tests get an off switch, simplest form first;
(3) `cf test` wants default patterns opt-in.

**The diagnosis that placed the switch.** The red lanes' one uniform
failure class: the ensured root's computed cells are CONTENT-ADDRESSED
(space-independent ids — the runtime-client lane's broken doc
`computed:fid1:7BycCyHc…` is byte-for-byte the census's default-app
root cell), so every fixture client holding a plain space-cell
subscription received them, and the delivery reached the replica with
the root's `cid:` schema doc "not delivered and verified" —
`SpaceReplica.#validateArrivedSchemaDocuments` throws UNCAUGHT on the
background consume path and the FILE fails regardless of its own
assertions (13 distinct file-level failures across runner,
runtime-client, shell, and 9/10 pattern shards; environment-sensitive —
one local full-suite run at the same head was green while CI hit it
consistently). Attribution: main is green at the identical base
(`e55785eff`); the breaking docs exist only because the ensure created
them; the OFF lanes stayed green. EVERY failing lane runs a REAL
toolshed binary (the same lanes' in-process-server tests passed), so
the switch needed a toolshed-level home beside the in-memory setting —
still the ruled simple form (a whole-instance flag), NOT the deferred
per-space design.

**As built:** `SpaceServerOptions.ensureSpaceRoots` /
`ExecutorHostOptions.ensureSpaceRoots` (the in-memory setting the
ruling named; default ON) → the toolshed env knob
`SERVER_EXECUTION_ENSURE_SPACE_ROOTS` (only the literal `"false"`
disables; garbage FAILS TO PRODUCTION with a warning). Off is fully
inert: nothing arms, no skip, no ACL re-arm, no counter movement
(pinned both ways; gate-ignored mutation kills the off pin). The CI ON
lanes set it `false` on both the served binary and the test-process env
(the in-process servers some tests boot inherit it).

**`cf test` (ruled opt-in): already the status quo, recorded rather
than built.** Single-user `cf test` runs on `StorageManager.emulate`
with NO ExecutorHost anywhere in `packages/cli` — the ensure is
structurally absent, so "default patterns opt-in" is the factual
present; the in-memory setting for any future cf-test serving host is
exactly `ExecutorHostOptions.ensureSpaceRoots`. The multi-user variant
connects to a LIVE toolshed (`memoryHost`), where the server's own env
knob governs — a cf-test-side flag cannot reach a server it does not
start. Both recorded as the ruling's coverage, not extended.

**Flagged for the owner (not filled):**

- The diagnosis exposed a PRE-EXISTING delivery gap the ensure made
  reachable at scale: a computed doc can be delivered to a replica
  whose `cid:` schema ref is not delivered-and-verified in that
  replica (the client throws fail-closed, uncaught, on the consume
  path). With the lanes switched off it returns to latent. Production
  exposure differs (shell clients demand the root explicitly and
  subscribe root-aware), but space-cell-only subscribers (CLI,
  agents-host) exist; the gap belongs to the delivery/validation
  machinery, not to this seat.
- **CI coverage after the lanes opt out, stated plainly for future
  readers: the four ON lanes' green does NOT speak to the ensure**
  (they run `SERVER_EXECUTION_ENSURE_SPACE_ROOTS=false`). What DOES
  exercise the ensure in CI: the runner unit shards run the seat and
  core suites un-gated at the knob's production default — including
  the HOST-LEVEL live-glue pin added with the knob (a real
  ExecutorHost, a real client session-open driving activation through
  the host's admission observer, the genesis-ACL admission riding the
  host's OWN feed into the re-arm, one root created and durably
  visible to a fresh replica; mutation-checked: `ensureSpaceRoots:
  false` on the host reds it) — plus the memory owner pins, the
  toolshed env-parser/OFF pins, and the piece OFF net in their lanes.
  What remains UNCOVERED in CI is narrower than first written
  (delta-review O1): the OFF direction THROUGH the deployed binary is
  witnessed by every ON-lane run — dropping the
  `startServerExecutionHost` pass-through would default hosts ON and
  loudly re-red the opted-out lanes — so the only binary-true
  uncovered direction is ON-through-deployed-binary (the env chain
  delivering `true`/unset into a real process), whose failure
  direction is the production default (fail-toward-ON, parser
  unit-pinned). The out-of-CI measurement harness covers that
  direction today; a dedicated knob-ON second-server lane step remains
  the named option if binary-true ON coverage is wanted in CI.

## Flagged, not filled

- **OW55's self-pin (design open question 9).** The ensure's fetch
  rides the existing self-HTTP loop (`patternSourceUrl(source,
  runtime.apiUrl)` — the same surface the §3e updater already uses
  server-side). This adds a CONSUMER to the OW55 trust surface
  (`env.API_URL` can name another process's port); the deliberate
  posture (pin-to-self when co-hosted, or verify the served
  `?identity` against the local route) remains owed under OW55's row.
  Not built here: the design offers it as a recommendation on an open
  owner question, and the posture change would also govern the
  EXISTING updater path — wider than this stage's seat.
- **The deferred-start transaction's trust snapshot.** The ensure's
  creation `editWithRetry` arms the runner's deferred start
  (`runner.ts:3689-3702`), whose commit-callback transaction stamps
  itself actor-less `bookkeeping` (`runner.ts:3414-3422`) and therefore
  keeps the AMBIENT SERVICE snapshot — OW59 Q3's arm, surfacing on the
  child-materialization docs (the census's 4 child piece roots) even
  while the ensure's own creation tx carries the owner snapshot.
  Threading a per-arm trust principal through the shared deferred-start
  machinery touches every arming site and is OW59-ruling territory;
  flagged for the owner beside assumption 1 rather than filled. The
  same family has a SECOND, pre-existing member (delta-review N3,
  recorded here so the set of unstamped serving-path writers is
  enumerated in one place): `PatternManager`'s compile-cache
  write-backs, minted INSIDE `compilePattern`, escape the stamp hook
  too — not new with this stage (the updater's server-side compiles
  already ride them) and carrying the S-A delegated carriage where the
  replicate trigger threads it; both members resolve together under
  the OW59 follow-up, not piecemeal.
- **Sessionless-activation ensure (design open question 5).** The owed
  step arms at `activate()` unconditionally, so event-carrying and
  warm-request activations ensure too — the design's recommendation
  (idempotence makes the cost one fast-path read; a wish-provisioned
  space gets its root before first open). If the owner prefers
  session-bearing activations only, the arming moves behind the
  trigger, one line.

## The seat as built

- **The owed step (design §1, sub-option A2).** `SpaceServer.activate()`
  arms `#rootEnsureOwed`; the wave loop's first cycle consumes it as its
  FIRST serialized step — fully awaited like the event drain, before the
  drain (an event may target the root's `addPiece` stream) and before
  any demand pass loads what the ensure materializes. Once per tenure,
  so a slow first compile costs the first wave only; the ensure's
  transactions resolve at seal-accept and their engine write rides that
  cycle's wave commit, so awaiting in-cycle cannot deadlock against the
  wave. "Non-blocking" means at ACTIVATION (the step never runs inside
  `activate()`); the awaited step itself is DEADLINE-BOUNDED (review
  F2: `rootEnsureDeadlineMs`, default 30 s — the resolve path fetches
  with no timeout of its own and can point at a remote host while the
  renew timer keeps the lease, so an unbounded await was a wedged
  tenure holding its lease with no failover and no loop-failed park;
  the deadline lands in the counted-failure arm, the tenure proceeds
  serving, and the detached work's eventual writes stay safe — the
  CREATION arm converges by address (cause-derived id + the OCC
  re-check), the UPDATE arm by OCC refusal: the transition's
  `stillMatches` baseline refuses a moved root, so stale-over-new is
  impossible — delta-review-probed live: wedge released after the
  deadline, root durable and correct from an independent replica, no
  unhandled rejection). All three activation triggers ensure (sessionless included
  — design open question 5's recommendation, recorded above).
- **Single-flight is STRUCTURAL, not enforced** — the
  design-conformance fact this build verified rather than assumed: a
  SpaceServer is a single-tenure object (`#parkRequested` never resets;
  the host constructs a REPLACEMENT SpaceServer per re-activation —
  `host.ts` `#activateInner`, chained behind `whenParked` by
  `#reactivateAfterPark`), so the owed flag's lifetime is the tenure's
  and there is no re-arm bookkeeping to get wrong. The design asked for
  "a lease-guarded, single-flight, non-blocking tenure step"; tenure-
  scoped instance state is how that lands.
- **The ensure core, extracted into the runner**
  (`packages/runner/src/ensure-space-root.ts`, beside
  `pattern-updater.ts` / `ensure-piece-running.ts`, per the design's §1
  implementation note): `createSpaceRootIfAbsent` (resolve + compile
  into the space's compile cache, then the creation `editWithRetry` —
  OCC re-check, identity-bearing cause, `runtime.run` setup, provenance
  stamp, `defaultPattern` link), `resolveSpaceRootPattern` (resolution
  without start), `ensureSpaceRootPattern` (the server flow: resolve →
  create-if-absent → the awaited default-root reconcile, skipped for a
  root this call compiled from the current source). The system source
  refs and `patternSourceUrl` moved here from piece (re-exported), so
  the two creators cannot drift on the identity-bearing cause/source.
  The client controller's creation arm DELEGATES to the same core
  (phase labels preserved through its `timePiecePhase` hook; the
  re-check reads through the controller's own synced space cell via the
  `spaceCell` hook) — OFF stays one code path, the design's stated
  reason for the extraction over an injected hook.
- **Attribution.** The seat resolves the space's ACL owner through the
  memory server's new `resolveSpaceOwner(engine, space)` (a thin public
  API over `#resolveSpaceOwnerBinding` — the OW31-ruled
  service-identity ACL read), derives home-ness as self-owned = home
  (never `userIdentityDID`, which is the service DID on a serving
  runtime), and its creation transaction stamps
  `bookkeeping` + `tx.setCfcTrustSnapshot(trustSnapshotForPrincipal(owner))`
  per attempt, before the first read. No owner → skip, warn,
  `rootEnsure.skippedNoOwner` — never the service DID; the skip
  latches awaiting-owner and the genesis ACL's admission re-arms the
  owed ensure in the same tenure (else the next tenure retries).
- **Counters** (`ServingLoopStats.rootEnsure`): `runs`, `created`,
  `reconciled`, `skippedNoOwner`, `failures`. Failures are counted and
  cleared for the tenure (the next activation retries), so a
  deterministic failure cannot spin the loop; in stage 1 the client-era
  creation path still covers the space regardless. Counting caveat
  (review F4, recorded): `created`/`reconciled` count at seal-accept,
  so a wave dropped whole after admission leaves a count with no
  durable write; the MIRROR direction exists too (delta-review N2,
  confirmed live) — a deadline-detached ensure that later completes is
  a durable write with NO count (`failures` carries the deadline while
  `runs`/`created` stay 0 and the root lands). Stats-only in both
  directions, self-healing next tenure; triangulate against
  `waves`/`lease.lost`. The no-owner WARN fires once per
  tenure (review F6); re-skips count silently.

## Red-first evidence

Every behavior pin was watched failing before its seat/fix existed:

- **The seat pins** (`packages/runner/test/executor-space-root-ensure.test.ts`),
  watched red at `adeb15dd9`'s parent (no seat): pin 1/2/3 failed with
  the root never materializing and pin 4 with
  `TypeError: Cannot read properties of undefined (reading 'skippedNoOwner')`
  (the counters did not exist); after the seat, 4/4 green. Two
  fixture-reality reds along the way are recorded because each names a
  real contract: (i) the suite runs on the REAL clock
  (`clock-preload`'s guard: "clock auto-advance runaway: 2000
  production timers fired … armed at SpaceServer.activate" — the renew
  cadence is wall-clock policy, like every executor suite); (ii) the
  aged-reconcile pin initially red with the second tenure's wave killed
  as `commit replay mismatch … localSeq 1` — a FIXTURE bug violating
  the host's documented contract (ONE process-lifetime `localSeqRef`
  across tenures; a fresh counter re-mints consumed (session, localSeq)
  pairs), now stated in the suite.
- **Mutation kills** (the vacuity check): the no-owner arm mutated to a
  service-DID fallback → the fail-closed pin red (20 s timeout — the
  root got created, which is exactly the bug the pin guards); the
  toolshed OFF gate bypassed → both OFF pins red on the untouchable
  proxies; the core's provenance stamp dropped → the core pin red AND
  the piece provenance suite red THROUGH the delegated controller
  (proving the controller runs the shared core); the ensure's reconcile
  dropped → the aged-root core pin red.
- **The review-fix pins (F1, F2)**, both watched red at the reviewed
  head: the reconcile-attribution pin (the `pattern-update/…`
  transactions' `actingPrincipal` came back as the SERVICE DID before
  the hook — the review's own live probe reproduced) and the wedged-
  ensure deadline pin (a never-settling pattern fetch; before the
  deadline existed the failure never counted and the pin timed out at
  its 20 s net).
- **The memory API pins**
  (`packages/memory/test/v2-server-space-owner.test.ts`), watched red as
  `TS2339: Property 'resolveSpaceOwner' does not exist on type 'Server'`
  before the method existed; 4/4 green after (self-owned → space DID;
  multi-owner → lexicographically first; missing ACL → undefined;
  granted owner → that owner, never the service).
- **The OFF witnesses** (the arc's bar, and this build's explicit
  proof that the server-side path does not exist OFF):
  `packages/toolshed/lib/server-execution.test.ts` — flag unset (the
  first-party default) and flag `"false"` both leave
  `startServerExecutionHost` inert, on untouchable proxy fakes so any
  pre-gate use throws; the seat's only reachability chain (toolshed
  bootstrap → ExecutorHost → SpaceServer.activate) severs at its first
  link. Client arm: the named OFF-arm pin in
  `packages/piece/test/pattern-source-provenance.test.ts` (creation
  still runs on a plain client — root created, linked, idempotent
  re-ensure) plus the pre-existing net green through the delegated
  path: check-update-default-pattern (69 steps — one of which,
  "reconciles a persisted root discovered after a creation race",
  initially red because the delegation bypassed the controller's
  `getSpaceCellContents` seam its stub models; the core now reads
  through the controller-passed `spaceCell` hook, which is also the
  byte-identity-faithful shape), ensure-default-pattern, piece-origin,
  and the home/default-app golden replays.

## Measurement — before/after at the true ON topology, ambient load only

Bench: the OW45 gate-harness shape — fresh store per run, posture probe
per run (`shellServerExecutionDefine=true servingLoop=present` on every
run), ports 9691–9696 (never 8000), PID-only kills, ambient load only
(load-before 2.9–5.8 across the ledger). Gate:
`packages/patterns/integration/default-app.test.ts` with the step's ON
skip entry neutralized in the working tree so the step actually runs
(restored after; the committed entry is untouched). Client worker
console forwarded (`FORWARD_WORKER_CONSOLE=1 PIPE_CONSOLE=1`).

Instruments — two SCRATCH taps, in the tree for the measurement builds
only and reverted before this report's final push (the census's
discipline; the committed diff carries neither):

1. `[ENSURETAP]` at the shared creation core's exit
   (`createSpaceRootIfAbsent`): space, cause, `createdByThisCall`,
   commit-error name. Prints server-side into the toolshed log and
   client-side through the forwarded worker console — the
   who-created-and-who-won instrument.
2. `[SEQTAP]` per client commit at `sealOperations` (localSeq + scheme
   split) — the census's instrument-3 shape. Supplementary only: the
   worker console forward attaches after the earliest boot commits, so
   compositions are read from the refusal payloads (the product's own
   `tx-commit-error` line embeds the whole transaction) and ENSURETAP.

The server's `rootEnsure` counters (`/api/health/stats`) are product
surface, not a tap.

**Before** is the arming-entry report's ledger
(`ow45-armb-arming-entry.md`), measured at `e55785eff` — THIS branch's
base — same gate, same fresh-store/posture/ambient discipline, same
box: 6 informative runs (5 green, 1 red at 325 s), 12/12 ARM-A arms
from `ensureDefaultPattern`, **9 refusals, all ARM-A**, every refused
commit `(50, 16, 15, 19)`, client boot sequence five commits
`(9, 23, 28, 46, 50)` ops. Run r01 below — stage-1 code with the
fail-closed skip still next-tenure-only, i.e. the server INERT — is the
in-branch control that reproduces exactly that before-signature.

### Run ledger

| run | build | exit | wall | load b/a | rootEnsure runs/created/skipNoOwner | server creates | client creation attempts (won) | ARM-A refusals | step |
|---|---|---|---|---|---|---|---|---|---|
| r01 | stage 1, pre-re-arm | 1 | 341 s | 2.9/4.4 | 0/0/4 | 0 | 2 (2) | **2** — both `(50,16,15,19)` at localSeq 5 | **RED** (5 m 26 s) |
| r02 | + same-tenure re-arm | 0 | 25 s | 4.3/5.8 | 4/4/4 | 4 (2 home + 2 default-app) | 1 (0) | 0 | ok 17 s |
| r03 | + same-tenure re-arm | 0 | 25 s | 5.8/4.8 | 4/4/4 | 4 | 2 (0) | 0 | ok 14 s |
| r04 | + same-tenure re-arm | 0 | 30 s | 4.8/4.0 | 4/4/4 | 4 | 1 (0) | 0 | ok 19 s |
| r05 | + same-tenure re-arm | 0 | 29 s | 4.0/4.8 | 4/4/4 | 4 | 1 (0) | 0 | ok 17 s |
| r06 | + same-tenure re-arm | 0 | 25 s | 4.8/4.2 | 4/4/4 | 4 | 1 (0) | 0 | ok 14 s |

### What the numbers say

1. **Does the server's ensure precede the client's?** YES, structurally
   and measured. The activation-time ensure runs ~5–6 s before the
   client's creation would commit (r01's timestamps: the server's
   attempt at :14.5, the client's creation at :20.2). With the
   same-tenure re-arm the server CREATED the root on 20/20
   space-openings across r02–r06 (both arms live: `home-pattern` on
   self-owned spaces, `space-root`/default-app on user-owned spaces).
   The one boot-order fact the design's assumption missed — activation
   precedes the genesis ACL, so the ruled fail-closed skip fires first
   on EVERY fresh space — is what r01 measured (ensure inert, 4/4
   skipped) and what the re-arm closes without touching the identity
   posture.
2. **ARM-A refusal rate:** before, 9 refusals across 6 runs (all
   ARM-A, invariant `(50,16,15,19)`); r01 (server inert) reproduces it
   (2 refusals, same composition). After: **0 refusals in 5/5 runs**.
   The client's remaining creation attempts (6 across r02–r06, all on
   the default-app spaces whose root it demanded mid-boot) all
   resolved the served root inside the transaction
   (`createdByThisCall=false`, no error) — the OCC fast arm engaging
   live, because the serving loop had already started the served root
   and its value was present at the re-check.
3. **The client's five-commit sequence:** the creation pair — the
   46-op originating tx and the 50-op deferred start (commits 4+5,
   the pair the arming report attributed to `ensureDefaultPattern`) —
   is GONE from the client's boot in every after-run: no client
   creation commit, no deferred-start arming from the root's creation,
   zero refusal lines to embed one. On home spaces the client's fast
   path resolves the served root without entering the creation arm at
   all; on default-app spaces it enters and exits on the in-tx re-check
   (a read-only attempt). The three compile-cache write-back commits
   are not individually tabled (SEQTAP attaches too late for the boot
   commits), but the composition change the design predicted — the
   materialization pair moving server-side — is directly witnessed.
4. **Step verdict (not a promised metric, reported because it is the
   skip's subject):** r01, with the server inert, is the known arm-B
   RED (341 s, the b04/h04 family). r02–r06, with the server creating
   every root, are **5/5 GREEN at 14–19 s step walls**. This is
   consistent with the design's does-fix claim (the refusal class and
   the duplicated materialization disappear when the server creates
   first) and it does NOT meet the skip's lift bar (10/10
   quiet-and-loaded, the client-start class explained) — **no skip
   lift is taken or planned here**; the b04 ConflictError class (the
   deferred start of a CLIENT-created piece racing the serving wave's
   materialization of the same piece) is unreachable for the SPACE
   ROOT when the server creates it, but the gate's mid-test piece
   creations still exercise the general class, and 5 runs is 5 runs.

## Suites run

Counts at the final tree (one file per invocation):

- `packages/memory` `v2-server-space-owner.test.ts` — 4/4.
- `packages/runner` `ensure-space-root.test.ts` — 6/6 steps;
  `executor-space-root-ensure.test.ts` — 6/6 steps (real-clock list;
  includes the review-fix pins F1 — reconcile attribution on the live
  transactions — and F2 — the wedged-ensure deadline).
- `packages/piece` `pattern-source-provenance.test.ts` 3/3 steps (the
  OFF-arm witness included), `ensure-default-pattern.test.ts` 16/16
  steps, `check-update-default-pattern.test.ts` 69/69 steps,
  `piece-origin.test.ts` 64/64 steps, `home-golden-replay.test.ts` and
  `default-app-golden-replay.test.ts` green.
- `packages/toolshed` `lib/server-execution.test.ts` — 6/6 steps (the
  OFF witness pins included).
- Neighboring executor suites at the final tree:
  `executor-space-server.test.ts` 15/15 steps,
  `executor-warm-request.test.ts` 8/8 steps,
  `executor-trust-attribution.test.ts` 17/17 steps; and
  `v2-server-acl.test.ts` 39/39 (the memory server's ACL machinery
  around the new read API).
- The live gate: the measurement ledger above (r02–r06 5/5 green with
  the step running; r01 the served-inert control).
