---
status: historical
created: 2026-08-23
archived: 2026-08-23
reason: "OW45 arm-B DESIGN for the owner's ruling (2026-08-23 direction: move ensureDefaultPattern into the server when opening a space): the space-root ensure — existence + freshness, the START retired under ON — moves to the SpaceServer's activation as a lease-guarded, single-flight, non-blocking tenure step, and the flag-ON client's ensureDefaultPattern becomes resolve-or-wait (no creation editWithRetry, so ARM-A at pieces-controller.ts:1759 never arms and the measured 5-commit redundant materialization disappears). Fetch: the toolshed serves system patterns from local disk (PatternsServer over packages/patterns), stage 1 keeps the self-HTTP loop with OW55's owed self-pin, the custom defaultAppUrl branch is a genuine fork (recommend: server fetches the OWNER's configured URL; needs a trust ruling). Identity: the ensure run stamps bookkeeping and carries an OWNER-RESOLVED per-run CFC trust snapshot (the memory server's #resolveSpaceOwnerBinding, the ruled service-identity ACL read) — the exact follow-up OW59's Q3 caveat pre-named — failing closed when no owner resolves (OW53's shape); the serving runtime's userIdentityDID is the SERVICE DID, so the client's isHomeSpace check and getDefaultAppUrlFromHome must be re-derived from the ACL. OFF byte-identical: the branch keys on the client runtime's experimental.serverExecution; every caller (shell boot, home/favorites, CLI x2, agents-host, fixture) inherits it through the controller. ARM-B (runner.ts:5820) is explicitly OUT of scope. Honest bar: this removes the ARM-A refusal class and the duplicated materialization; it does NOT explain arm B's red/green (refusals fire on greens 15/18 and s07 passed refused), so the ON skip stays until the redness is explained. Ten numbered owner questions with recommendations close the document."
---

# OW45 arm B — moving `ensureDefaultPattern` into the server: the design

Author: server-ensure DESIGN agent, 2026-08-23. Worktree
`/Users/berni/labs-worktrees/server-ensure-design`, head `e55785eff`
(origin/main — the same head the arming-entry measurement ran on).
Design pass only: no product code in this change. Every mechanism claim
below was re-verified against this head; file:line anchors are to it.

## Why

The OW45 arm-B triage chain ended at a precise arming site: the refused
50-op deferred piece-start commit — MIXED 18/18, refused on greens and
reds alike, 0 of 50 operations unique to the client — is armed by
**`PiecesController.ensureDefaultPattern`**
(`packages/piece/src/ops/pieces-controller.ts:1759`, the creation
`editWithRetry` whose `fn` calls `runtime.run` at `:1783`), reached from
`RuntimeProcessor.handleGetSpaceRootPattern` — session boot. The owner's
direction (2026-08-23, verbatim):

> if that is the source, the easiest solution is to move
> ensureDefaultPattern into the server when opening a space. it's job is
> really just to make sure there is a default pattern (and that it's
> updated). we just only had that in the client, but for ON we can stop
> having clients do that and the server do it instead

and, on the start half:

> on the client we need to start a pattern so that it can be reactive to
> changes, but i think now the server will already start patterns when
> it reads data that is stale. so we don't actually need to start the
> pattern. (but we need to still ensure that it exists and is uptodate)

This document designs that concretely — the server-side seat, what moves
and what retires, the fetch and identity mechanics, the OFF arm, the
other callers, and what it costs — and flags the genuinely open choices
for the owner rather than filling them. It is also the first concrete
instance of two register rows the owner has already pointed at: OW56
("ideally compilation happens on the server and clients just wait for
it") and OW44's ruled pairing ("together with not running the pattern on
the client immediately").

Evidence base (all on branches, verified):
[`ow45-armb-client-start-fork.md`](ow45-armb-client-start-fork.md) (the
fork), `ow45-armb-commit-census.md`
(branch `claude/server-exec-v2-armb-commit-census`, `ab64a048d`),
`ow45-armb-start-commit-sequence.md`
(branch `claude/server-exec-v2-start-commit-sequence`, `55c9be37a`),
`ow45-armb-arming-entry.md`
(branch `claude/server-exec-v2-armb-arming-entry`, `4b41616c0`).

## 0. What `ensureDefaultPattern` is today, precisely

`pieces-controller.ts:1693` — four duties, in order:

1. **Existence.** Fast path: resolve the existing root WITHOUT starting
   it (`getDefaultPattern(false)`, `:1698`). Absent: pick the source by
   space type — home spaces (`getSpace() === runtime.userIdentityDID`,
   `:1704`) get `HOME_PATTERN_SOURCE`, every other space gets a custom
   `defaultAppUrl` read **from the current user's home space**
   (`getDefaultAppUrlFromHome`, `:1512`) or
   `DEFAULT_APP_PATTERN_SOURCE`; resolve via `HttpProgramResolver` over
   `patternSourceUrl(source, runtime.apiUrl)`; compile into the target
   space's content-addressed cell cache (CT-1623); then the creation
   `editWithRetry` (`:1759`) — re-check `defaultPattern` inside the tx
   (the OCC invariant that makes concurrent creators converge), create
   the piece cell, **`runtime.run(tx, pattern, {}, pieceCell, …)`**
   (`:1783`), stamp source provenance, link `defaultPattern`.
2. **Freshness.** `startEnsuredDefaultPattern` (`:1822`) first awaits
   `checkAndUpdateDefaultPattern` (`:2251`) — gated on
   `experimental.systemPatternAutoUpdate`, delegating to
   `patternUpdater.checkDefaultPattern(root, deriveSystemPatternSource(…))`
   — so an obsolete, possibly unloadable `patternIdentity` is replaced
   *before* bootstrap tries to load it. The updater
   (`packages/runner/src/pattern-updater.ts` `#check`, default-root
   mode) probes the patterns route's `?identity`, compiles on mismatch,
   and swaps the metadata pointer in an `editWithRetry` — **never
   run()/stop()** (`applyPieceSourceTransition` only).
3. **Start.** `startPiece` → `runtime.start` (`:1841`) — registers the
   piece client-side so reads resolve and demand registers.
4. **Runnability repair.** If the start throws: the cold-start setup
   repair (`runSynced` with `expectedPatternIdentity`, `:1907`) — a root
   whose identity moved while not running boots over a doc that never
   materialized the pattern's internals and dies at instantiation; run()
   is the sanctioned repair — escalating on exactly two signals (CFC
   migration rejection, stored-argument refusal) to
   `healDefaultRootByRollForward` (`:2024`), which re-fetches the
   official source with ETag revalidation and rolls the root forward.

The measured cost of duty 1 on a flag-ON client, per the sequence memo:
five commits (9, 23, 28, 46, 50 ops — three compile-cache write-backs at
`pattern-manager.ts:2183`, the originating creation tx, and the deferred
start), of which the fifth is refused whenever the serving loop's own
wave covered it first — 50/50 coverage in every measured run, greens
included.

## 1. The seat: the SpaceServer's activation, as a tenure step

**Recommendation: the ensure runs in the `SpaceServer`
(`packages/runner/src/executor/space-server.ts`), armed at `activate()`
and executed as a single-flight, non-blocking step of the serving
tenure — not in the ExecutorHost, not in the memory server's session
open.**

Why this seat and not the others surveyed:

- **The lease makes it single-writer.** `activate()` acquires the
  execution lease before the runtime exists (`space-server.ts:702-717`).
  An ensure inside the tenure is serialized across processes by the
  same mechanism that serializes derivation — the multi-client creation
  race (`ensureDefaultPattern`'s own doc comment calls it out) and the
  client-vs-wave race the sequence memo measured both dissolve
  structurally, instead of being retried politely.
- **The serving runtime is already the right runtime.** The factory
  constructs it with `serverExecution: true` and
  `systemPatternAutoUpdate: true`
  (`packages/toolshed/lib/server-execution.ts:157-173`) — §3e's
  pattern-update posture is already flipped here, and §3d's stamped
  choke points already cover piece-start/setup writes (the F1 fold-in
  RULED 2026-08-13 names "the deferred piece-start/run transactions"
  and "the runtime-internal pattern-update/rollforward writes" as
  `bookkeeping`-stamped). The ensure adds one more stamped internal
  write path to a lane that exists, not a new lane.
- **"Space open", server-side, IS activation.** The host activates on
  exactly the triggers that mean someone opened the space: a live
  client session (`#onSessionOpened`, `host.ts:291`), an
  authored admission implying one, an event-carrying admission, or an
  explicit warm request (`host.ts:258-288`). The client calls
  `ensureDefaultPattern` from `handleGetSpaceRootPattern` at session
  boot — the session-open trigger is the same moment observed from the
  other side.
- **The ExecutorHost is pre-lease** — an ensure there could run in two
  processes at once, re-creating the race this move exists to delete.
  **The memory server** has no compiler, no runtime, and no business
  running pattern setup; its role is admission and activation
  notification.

Placement within the tenure — two sub-options:

- **(A1) awaited inside `activate()`**, before the loop's first wave.
  Simplest ordering story (root exists before any demand pass), but a
  fresh space pays pattern compile time inside activation, delaying
  event drain and lease-cycle start for every cold space.
- **(A2) armed at activation, executed as the first serialized step of
  the wave loop** (the same owed-work shape as `#eventScanOwed` /
  `#outboxDrainOwed`, `space-server.ts:905-952`): activation stays
  fast; the ensure runs single-flight before the tenure's ordinary
  cycles proceed; a client waiting on the root (see §5) covers the
  gap. **Recommended.**

Properties the brief asked for, stated:

- **Idempotence under repeated opens.** Within a tenure: single-flight
  (one owed-step flag, cleared on completion). Across tenures and
  processes: the ensure's `editWithRetry` re-reads `defaultPattern`
  inside the transaction — the same OCC invariant the client's creation
  uses today — so a re-run resolves the existing root and reduces to
  the freshness check. Park/re-activate cycles re-run only the cheap
  fast path plus the updater probe.
- **Ordering vs the first demand pass.** Either order is safe. If a
  client's watch demands the root before the ensure commits, the demand
  pass's structure load returns `no-pattern-meta`, defers under the
  P2-F deferral machinery (`#attemptStructureLoad` /
  `#confirmNoPatternMeta`, `space-server.ts:3274-3334`), and the
  ensure's commit — which touches the space cell the failed load
  observed — re-arms it through the existing observed-doc re-fire. No
  new wake machinery is needed.
- **A space no client has opened** stays parked and gets no root —
  consistent with "activation loads nothing" (N22/N31) and T11.Q7's
  write-alone parking. Two deliberate consequences: an
  **event-triggered** activation (a cross-space delivery into a space
  with no session) DOES ensure — harmless, idempotent, and it is what
  lets a delivered event's consequences register into a piece list that
  exists; a **warm-request** activation (a served provisioning wave)
  DOES ensure — a freshly wish-provisioned space has its root
  materialized before its first human open, which is the CLI
  `newPiece` precondition (registration events target the root's
  `addPiece` stream) applied to the served path.

One structural note for the implementation stage: `packages/piece`
depends on `packages/runner`, so the executor cannot import
`PiecesController`. Either the ensure core is extracted into the runner
package (beside `pattern-updater.ts` and `ensure-piece-running.ts`,
which already hold the freshness and start halves), or the
`ExecutorHost`/`SpaceServer` options gain an injected
`ensureSpaceRoot(runtime, space, ownerDid)` hook that the toolshed
bootstrap (which depends on both) provides from `PiecesController`.
The injected hook reuses the battle-tested ensure/repair/heal code but
requires parameterizing the controller (see §4's identity notes: its
home-space test and home-space read resolve against the wrong identity
on a serving runtime). Recommendation: **extract the core into the
runner** — the controller's ensure logic is already runner-shaped (it
delegates to `patternUpdater`, `runtime.run`, `runtime.runSynced`), and
an extraction leaves the controller calling the shared core so OFF
stays one code path, not a fork.

## 2. What moves, what retires, what stays

**Moves to the server (the ensure proper):**

- The **existence** check and creation: resolve `defaultPattern`;
  absent → select source by space type (ACL-derived, §4), resolve +
  compile (into the space's compile cache, so clients load the compiled
  artifact instead of recompiling — CT-1623 working for the fleet), and
  the creation `editWithRetry` with `runtime.run` — stamped
  `bookkeeping` via `stampServerRun` (`runtime.ts:2143`), the same
  stamp the pattern swap's setup write carries (§3d's sanctioned
  internal kind), with the per-run trust snapshot of §4. On the serving
  runtime, `editWithRetry` still sets
  `immediate`+`deferRunnerStartUntilCommit` (`runtime.ts:2313-2317`)
  and the deferred start tx still arms (`runner.ts:3689-3702`) — but
  under the lease there is no second materializer to lose to, and the
  §3d piece-start choke point already stamps and surfaces its commit
  (`pieceStartCommitFailureObserver`, `space-server.ts:816-823`).
- The **freshness** half: the awaited default-root reconcile
  (`checkAndUpdateDefaultPattern` → `patternUpdater.checkDefaultPattern`)
  runs server-side at ensure time. This is the smallest move of all:
  the updater is **already server-runnable and already stamped** — its
  two `editWithRetry` writes call
  `runtime.stampServerRun(tx, { actionId: "pattern-update/…", kind:
  "bookkeeping" })` citing the 2026-08-05 ruling
  (`pattern-updater.ts:376-379, 593-596`), and §3e records the posture
  flip as landed ("the serving-runtime factory enables
  `systemPatternAutoUpdate` server-side"). What is new is only the
  CALLER: today no server-side code invokes the awaited default-root
  mode (`checkDefaultPattern`'s only caller is the client controller);
  the instantiated-pattern mode already runs server-side via
  `schedule`. The obsolete-`patternIdentity`-before-load ordering the
  owner wants kept is preserved by keeping the same
  reconcile-before-anything-loads sequence inside the server ensure.
- The **runnability repair** pair — the cold-start setup repair and
  `healDefaultRootByRollForward`. This is the part the owner's "its job
  is really just existence + updated" summary does not name, and it
  must move anyway: both repairs today live on the CLIENT's start path,
  so retiring the client's create-and-start under ON silently retires
  the only healer of aged roots ("Handler used as lift"-class docs,
  refused stored arguments) — an aged space would park forever under
  ON with nothing left to fix it (OW46 would make it visible, not
  healed). Recommended seat for the trigger: the ensure performs the
  reconcile, and the REPAIR arm hooks the serving loop's structure-load
  failure for the ROOT specifically — when `#attemptStructureLoad` on
  the space root throws or the root's pattern is unloadable, run the
  repair (`runSynced` with `expectedPatternIdentity`, escalating to
  roll-forward on the two ruled signals), once per tenure, counted.
  That keeps the ensure cheap and puts the heal where the failure
  signal already surfaces (`structureLoadFailures`).

**Retires under ON (client side):**

- The creation `editWithRetry` at `:1759` — with it ARM-A's arming for
  the space root, the refused 50-op materialization, the 46-op
  originating tx, and the three compile-cache write-back commits
  (commits 1–3, `pattern-manager.ts:2183` — the ON client no longer
  compiles the root pattern at all; it loads the server-compiled
  artifact from the space cache).
- The client-side awaited reconcile and the repair/heal pair at root
  open (server owns them).
- **The START does not retire yet** — stage 2 keeps `startPiece` on
  the resolved root (see §10's staging and the honest dependency note
  in §8): retiring it is OW44's ruled "lazy client instantiation"
  pairing plus §3b read-and-render, which the sequence memo showed is
  spec prose, not code. The start of a server-materialized EXISTING
  root is a plain `runtime.start` (no `editWithRetry`, so no ARM-A
  deferral): `Runner.start` instantiates the stored identity without
  re-running setup (`ensure-piece-running.ts:196-198` states the
  contract), so its residual writes are the idempotent child-wiring
  class the owner has already judged safe to discard on conflict.

**Stays (both arms):**

- The whole OFF-arm client path, byte-identical (§5).
- `recreateDefaultPattern` (`:1543`) — an explicit user verb (stop,
  unlink, re-create), client-initiated on both arms. Its creation
  `editWithRetry` at `:1618` is a remaining ARM-A arming site under ON
  (§7).
- ARM-B (`runner.ts:5820`) — out of scope, §7.
- The fast-path resolution and the returned `PieceController` — the
  shell, CLI, and agents-host still get the same object back.

## 3. The fetch

**The owner's claim is confirmed.** The toolshed serves system patterns
from local disk: `PatternsServer`
(`packages/toolshed/routes/patterns/patterns-server.ts`) reads
`packages/patterns/` relative to `import.meta.dirname` ("works with
both dev mode and compiled binaries"), and the `?identity` probe is
computed locally by walking the authored import closure
(`resolveEntryIdentity` over `PATTERNS_ROUTE_PREFIX`-named modules) —
no compiler, no storage, no network. `system:` refs
(`packages/piece/src/system-pattern-url.ts`) expand to that route.

**System-pattern resolution server-side — recommendation: keep the
HTTP loop in stage 1, self-pinned; in-process resolution as the named
follow-up.** The serving runtimes' `apiUrl` is the process's own
`env.API_URL` (`packages/toolshed/index.ts:115-119`), so the §3e
updater already fetches system patterns from the process's own patterns
route over localhost HTTP — the flagged stage-F residual ("the CHECK
half's network source probe against a fully-local store"), and OW55's
minted trust surface (the default `API_URL` can name ANOTHER process's
port; the OW48 misdiagnosis was exactly a stale neighbor on 8000). The
server-side ensure adds one more consumer of this surface. Stage 1
should ride the existing loop — identity parity is guaranteed by
construction, since compile-side identity is computed over the same
route-pathname module names the `?identity` endpoint hashes — while
adopting OW55's owed posture explicitly (pin the serving runtimes'
pattern source to self when co-hosted, or verify the served
`?identity` against the local route before trusting fetched bytes). A
direct in-process `ProgramResolver` over `PatternsServer` closes both
the §3e residual and OW55 for this path and is the right follow-up;
it must preserve the pathname-prefixed module naming or the compiled
identity stops matching the advertised one
(`patterns-server.ts:91-104` documents the invariant).

**The custom `defaultAppUrl` branch — a genuine fork.** Today a
non-home space's root source may come from `defaultPattern.
defaultAppUrl` in **the opening user's** home space
(`getDefaultAppUrlFromHome`, `:1512`), resolved as an arbitrary
absolute URL. Server-side this branch changes twice over: the serving
runtime has no "current user" (its `userIdentityDID` is the SERVICE
DID, `runtime.ts:1353`; `getHomeSpaceCell` on a serving runtime
fail-closes without a run identity, `runtime.ts:2762-2775`), and
fetching a user-configured origin from the server re-opens OW55 as a
cross-ORIGIN question, not just cross-vintage. The arms:

- **(i) The server fetches it, owner-scoped.** Resolve the space's ACL
  owner (§4), read `defaultAppUrl` from the OWNER's home space (a
  foreign read on the serving plane — the Phase-5 foreign-session
  machinery exists, and the ensure run's acting identity makes
  `getHomeSpaceCell` resolve the owner's home), fetch + compile the
  configured URL server-side, stamp provenance as today. Preserves the
  feature with one deterministic creator. Two deltas to name: the
  semantic one — today the FIRST OPENER's setting decides a fresh
  space's root (any visitor's home config); owner-scoping makes it the
  OWNER's setting, which is arguably the correct semantics but is a
  behavior change — and the trust one: the server fetching and
  compiling an arbitrary user-configured origin needs its own ruling
  (it is the inversion of OW56's client-attestation concern: bytes the
  server compiles on a user's say-so).
- **(ii) Custom-URL roots stay a client concern.** The ON client keeps
  the creation branch only when the opener's home sets
  `defaultAppUrl`. Keeps ARM-A alive for exactly those spaces,
  re-splits the creator authority the move exists to unify, and makes
  the server's ensure conditional on state it must read anyway to know
  it should do nothing. Worst of both.
- **(iii) Unsupported under ON.** The server always uses the system
  default-app; a configured `defaultAppUrl` is ignored (logged). The
  simplest and safest, but a feature regression for whoever set it.

**Recommendation: (i)**, with the trust question put to the owner
(open question 3), and (iii) as the explicitly acceptable interim if
stage 1 should land before that ruling: the ensure logs-and-defaults on
a configured custom URL until the fetch posture is ruled, so no space
is created from bytes the owner has not decided the server may compile.

## 4. Identity and authority

A server-side ensure WRITES the space's root: the piece cell, its setup
state, provenance meta, and the space cell's `defaultPattern` link. Two
separable questions — under what authority the writes are ADMITTED, and
what identity the durable rows NAME.

**Admission is the settled half.** The ensure writes the SPACE THE
SPACESERVER SERVES, through the serving runtime's installed seal
destination into the wave — the same lane as the pattern swap's setup
write and the piece-start choke point, both already
`bookkeeping`-stamped (§3d; `ServerRunInfo.kind`, `runtime.ts:354-361`).
No foreign-write carriage is involved (the OW31 accept-gate machinery
governs FOREIGN targets), and no session-plane write exists to refuse.
OW31's pins — "the service principal cannot write into a user home
space" — govern the service's session traffic and carriage-less foreign
wave writes; the loop's own stamped writes into its served space are
the sanctioned lane those pins deliberately leave standing.

**Attribution is the open half, and the register has already
pre-shaped the answer.** The stamp kind alone would leave the run on
OW59's Q3 arm ("actor-less bookkeeping … keeps the ambient service
snapshot"), which mints `authored-by`/`represents-principal` labels
naming the SERVICE on every fresh root — and OW59's own close flags
precisely this shape: "a serving-side system-pattern restage of an
owner-gated pattern … would mint `represents-principal: <service>`
under keep-service; if a live gate ever surfaces that shape, the named
follow-up is an owner-resolved snapshot (OW31's ACL owner resolution),
not a silent widening." A server-side ensure surfaces that shape by
construction, on every fresh space. The candidates:

- **(a) The opening session's principal.** Mirrors today's authorship
  exactly (the first opener creates the root under their identity —
  today ANY visitor, not the owner). Rejected as primary: activation
  is not always session-triggered (event-carrying and warm activations
  have no session), concurrent opening sessions leave "which one"
  arbitrary, and the ensure is a per-space act, not a per-session one.
- **(b) The space's ACL owner.** Resolve via the memory server's
  existing `#resolveSpaceOwnerBinding`
  (`packages/memory/v2/server.ts:1311-1325`): the space DID itself
  when self-owned — which is every home space, giving the server-side
  home-space predicate for free (§0's `userIdentityDID` comparison is
  WRONG on a serving runtime, where it names the service) — else the
  lexicographically first concrete OWNER. This read is the one ruled
  service-identity read ("ACL can be read with service identity" —
  OW31, 2026-08-19). The ensure run then stamps `bookkeeping` and
  attaches `tx.setCfcTrustSnapshot(trustSnapshotForPrincipal(owner))` —
  the substrate OW59 built — so durable labels name the owner; and it
  carries the owner as the run's acting identity so
  `homeSpacePrincipalFor(tx)`/`getHomeSpaceCell` resolve the OWNER's
  home for the custom-URL read instead of fail-closing.
  Deterministic, session-independent, works for every activation
  trigger, and it is the follow-up OW59 named. **Recommended.**
- **(c) Keep-service (the Q3 status quo).** Admitted and simplest, but
  it is the exact store shape OW59's INV-D audit exists to catch, and
  the row's own language forecloses shipping it silently.

**Fail-closed arm (the OW53 shape).** A space whose ACL yields no
concrete owner — missing, invalid, retracted — gets NO ensure: skip,
warn, count, retry next tenure. Never the service DID as fallback
(`homeSpacePrincipalFor`'s own doc states the posture: "refusing to
resolve the SERVICE identity's home space"; OW53 ruled the analogous
sqlite mint fail-closed). Under OW31(b), genesis precedes data for
every served space, so an ACTIVE space without a resolvable owner is an
anomaly worth the warning, not a normal case to paper over.

**What still needs the owner (open question 2):** option (b) mints
`represents-principal: <owner>` for a run the owner did not initiate —
an attribution claim, not a capability exercise. The precedent is
OW59's Q2 arm (demanded derivations stamp the demanding principal's
snapshot with no capability in hand), and the created root is the
space's own furniture, but the arc's rule is that identity postures get
ruled, not inferred. The mechanical alternative if the owner declines
(b): keep-service labels plus a follow-up migration — which OW59
already rejected in spirit.

**Wave-drop semantics, stated.** Bookkeeping writes rebase; a semantic
conflict drops the contribution whole (§3d's conflict classes). For the
ensure this is sound end-to-end: creation is guarded by the
`editWithRetry` OCC invariant (a lost race re-resolves the existing
root), and the owner has already judged the child-materialization
writes idempotent-and-discardable ("BacklinksIndex, SummaryIndex, two
Grid Views … it is safe to fully discard those commits") — which the
census corroborates: every `of:` value in the measured commit is a
static projection or a create-only schema default.

## 5. The OFF arm

The arc's bar: every stage lands with the OFF arm byte-identical
(`docs/plans/server-execution-v2.md:1049`). The split:

- **The branch lives in `PiecesController.ensureDefaultPattern`, keyed
  on `runtime.experimental.serverExecution`.** The flag reaches the
  worker's controller from the shell's build define through
  `InitializationData.experimental` with the worker/host
  posture-agreement assertion
  (`runtime-processor.ts:261-276`); the CLI, agents-host, and fixtures
  resolve it from env (`experimentalOptionsFromEnv`). One branch point
  covers every caller (§6) with no per-caller edits.
- **OFF:** the existing path, untouched — creation, reconcile, start,
  repair, heal. The server half does not exist OFF (the ExecutorHost
  is only constructed under `EXPERIMENTAL_SERVER_EXECUTION`;
  `startServerExecutionHost` returns undefined otherwise), so OFF is
  structurally incapable of drifting.
- **ON:** resolve-or-wait — `getDefaultPattern(false)`; absent →
  subscribe to the space cell's `defaultPattern` key and wait, bounded,
  for the served ensure's commit to push it (the client's watch on the
  space cell is exactly the delivery path the serving loop already
  serves); then `startEnsuredDefaultPattern` WITHOUT the reconcile
  (server owns freshness) and — stage 2 — still WITH `startPiece`.
  The bounded wait's timeout error must name the likely cause
  (posture mismatch: a flag-ON client against a flag-OFF server has no
  server-side creator; the shell/toolshed deploy couples the flags, the
  CLI's env does not), because that misconfiguration otherwise presents
  as an infinite hang — today's OFF client would have just created the
  root.

Witnesses owed at build time, per the arc's discipline: the OFF gate
suite unchanged, plus an explicit OFF-arm unit pin that the creation
`editWithRetry` still runs OFF (watched red against the branch flipped
the wrong way), plus an ON-arm pin that the client mints NO creation
commit (the `ensureDefaultPattern.editWithRetry` timing phase absent /
no client commit carrying the site tag) — the missing-witness class the
arc has already been burned by.

## 6. The other callers

All five callers keep their call sites; the controller branch decides
the behavior. Per caller:

- **`RuntimeProcessor.handleGetSpaceRootPattern`**
  (`runtime-processor.ts:1314`) — the shell's session boot, the
  measured arming entry. ON: resolve-or-wait + start; no creation. The
  page ref it returns is unchanged in shape.
- **`RuntimeProcessor.handleEnsureHomePatternRunning`**
  (`runtime-processor.ts:1240`) — favorites need the HOME root running.
  Same ON arm; the home space activates on the same session-open
  trigger when the shell connects. Note its comment ("with
  `systemPatternAutoUpdate` unset nothing else heals the root") is the
  client-era framing — under ON the healer is the server ensure (§2's
  repair seat).
- **CLI `newPiece`** (`packages/cli/lib/piece.ts:1369`) — hard-requires
  the root (registration events target its `addPiece` stream). ON: the
  wait applies; on timeout the existing error path fires with its
  actionable message. The CLI's session-open activates the space, so
  the server ensure is triggered by the CLI's own connection.
- **CLI `loadPieceForCallables`** (`piece.ts:1852`) — best-effort
  ensure before call/verbs; already warn-and-continue on failure. ON:
  same wait, shorter patience is acceptable (a missing root here
  degrades to the existing warning).
- **`agents-host/src/debug-view.ts:660`** — an exists-gate before
  deploying the debug view. ON: resolve-or-wait, unchanged otherwise.
- **`patterns/integration/topic-board-fixture.ts:231`** — seeds
  against a live toolshed; under an ON toolshed the fixture's
  session-open triggers the served ensure and the fixture waits like
  any client; under OFF harnesses it creates as today. The fixture is
  also the natural early integration witness that the wait converges.

One honesty note for the CLI/agents-host fleet: their ON arm engages
only when their OWN runtime resolves `serverExecution` from env. A CLI
without the env var against an ON toolshed keeps the client-era create
path — which still works (the OCC invariant converges with the server's
ensure; one side wins, the other resolves), it merely keeps paying the
redundant-materialization cost and the ARM-A exposure for that process.
Deployment guidance, not a code gate.

## 7. The second deferred-start mechanism — scoped OUT

`setupDeferredHandlerResultPattern` (`runner.ts:5791`, arming at
`:5820`) arms `startAfterSuccessfulCommit` for any handler-result
pattern containing a `navigateTo` — ungated by the defer flags, needing
no `editWithRetry`. It shares the seat and the terminal error string
("Error committing deferred start transaction") with ARM-A, and it
fired in every measured session — accepted 12/12.

**Out of scope, deliberately.** It is a HANDLER-CONSEQUENCE start:
armed by a user event's result pattern, carrying the §3d-ruled
`event-handler` stamp semantics on the ON client (the
speculative-consequence sanction), with its own receipt-race design
("a client win would suppress the served navigateTo"). Moving the
space-root ensure server-side neither reaches nor changes it, and
conflating them would put an event-consequence mechanism inside a
space-open design. Its loss windows (never observed refused, but
unbounded under contention per the arming report's own caveat) belong
to the deferred-start RETRY work — PR #6208, open — which composes
with this design rather than competing with it.

Post-move ARM-A residual population, named so nobody rediscovers it:
`recreateDefaultPattern`'s creation tx
(`pieces-controller.ts:1618`) and `llm-dialog.ts:3032` remain
`editWithRetry`→`run` sites that arm deferred starts under ON. The
error string therefore does NOT become unambiguous after this move;
any zero-refusals assertion must scope by site tag or composition, not
by string absence alone (§9).

## 8. What this does — and does not — fix

**Does:** removes the ARM-A space-root refusal class at its arming
site (the only arm measured refusing: 9/9 refusals over 6 runs,
including the red, all `ensureDefaultPattern`), and with it the
redundant client materialization — five commits per fresh-root open
(9+23+28+46+50 ops), 0 of 50 deferred-start operations unique to the
client, plus the client-side compile of the root pattern. It also
dissolves the multi-client creation race by lease rather than by OCC
retry, and banks the first concrete instance of OW56 (server-owned
materialization + compilation, clients wait).

**Does not:** explain the arm-B red/green difference, and no one
should claim it does. The evidence is uniform: the refusal fires on
GREENS (15 of the census's 18 captures; the sequence memo's s07 passed
WITH its first session's commit refused 50/50-covered; the arming
report's a05/a06 greens carry the same two-refusal count as the a04
red), the red's refused commit is doc-for-doc identical to the
greens', and refusal count anti-correlates if anything. Whatever reds
the reload step lives DOWNSTREAM of the refusal. Removing the refusal
removes a suspect and a noise source — if the step still reds with
ARM-A gone, the cause was never the refusal, which is a real
diagnostic gain — but the ON skip's lift bar is NOT met by this design
succeeding (§9).

**One dependency stated honestly:** the ON client's rendering today
DEPENDS on its client-side start (the fork memo's measured mechanism:
a dead start means no client piece context, no registered demand,
`undefined` reads for the session). Stage 2 therefore keeps the client
start; what it removes is only the creation run. The start's own
retirement (read-and-render at the root seam) is OW44's ruled pairing
and stays out of this design's committed scope — N62's premise
("clients no longer run committed derivations at all") remains ahead
of the code, and this design narrows that gap at the root's CREATE
path only.

## 9. Acceptance and gates

- **The refusal's disappearance, instrumented.** The census's own
  product-payload instrument becomes the assertion: across the
  default-app gate's runs at the true ON topology, zero
  `tx-commit-error … Error committing deferred start transaction`
  events whose commit composition matches the ARM-A signature (or,
  cheaper and stronger if the build carries the site tag: zero
  deferred-start commits armed from `ensureDefaultPattern`) — scoped
  per §7's warning, since ARM-B and the residual ARM-A sites share the
  string.
- **The served-ensure pins, red-first:** activation of a fresh space
  with a live client session materializes `defaultPattern` + the root
  (watched failing before the seat exists); park/re-activate and
  double-activation converge on ONE root (the OCC invariant pin);
  labels on the created docs name the resolved OWNER, never the
  service DID (the OW59 INV-D store-audit shape, inverted into a pin);
  the no-owner space SKIPS with the counter bumped (the fail-closed
  pin); an aged-root fixture's activation reconciles the identity
  before any load (the updater-ordering pin); the root repair fires
  from the structure-load failure hook (the runnability pin).
- **The ON client pins:** resolve-or-wait converges on the served
  root with NO client creation commit; the bounded wait's timeout
  surfaces the posture-mismatch error.
- **OFF neutrality:** the OFF gate unchanged plus §5's two explicit
  witnesses.
- **The default-app ON gate and the skip-list consequence.** Run the
  gate with the step ENABLED at the true ON topology, 10-plus runs,
  to MEASURE — and expect one of two honest outcomes: the step greens
  10/10 quiet-and-loaded, in which case the skip's stated lift bar
  ("the client-start class closes and the fixed step greens ON
  10/10") is met on its own terms and the lift is justified; or reds
  persist without the refusal, which localizes arm B's cause
  downstream and the skip STAYS with its reason updated to the
  narrowed map. **Do not plan the lift** — the flip PR's list-EMPTY
  bar hangs on evidence this design cannot promise, because the
  refusal demonstrably does not determine the verdict.

## 10. Sizing

Staged so each stage lands alone, OFF-neutral, in the arc's
red-first/adversarial-review/CI discipline:

- **Stage 1 — the server ensure (no client change).** The memory
  server exposes owner resolution to the host (a thin API over
  `#resolveSpaceOwnerBinding`); the ensure core extracted into the
  runner (existence + freshness + the repair hook), stamped and
  owner-snapshotted; the SpaceServer tenure step + counters; pins.
  Ships alone and is USEFUL alone: the server wins most creation races
  from then on, so the ON client's existing `editWithRetry` usually
  resolves-early and never runs — ARM-A shrinks to the races the
  client still wins, without any client diff. Estimate: 2–3 PRs
  (owner-resolution API; ensure core + seat + pins; custom-URL arm per
  its ruling or the log-and-default interim). The most substantial
  single item is parameterizing the ensure core off the controller's
  client-identity assumptions (home-space predicate, home read).
- **Stage 2 — the ON client stops creating.** The controller branch
  (resolve-or-wait, reconcile dropped, start kept), the bounded wait,
  the witnesses, the gate instrumentation, the measurement run of §9.
  Estimate: 1–2 PRs. This is the stage that deletes ARM-A's space-root
  instance outright.
- **Out of committed scope, named:** the client start's retirement at
  the root seam (OW44's pairing + §3b read-and-render made real —
  including what client-side speculation needs from a non-started
  piece), the in-process pattern resolver closing OW55/§3e for this
  path, and ARM-B/retry hardening (#6208's lane).

## Open questions for the owner

1. **The seat's sub-choice.** SpaceServer tenure step, non-blocking
   (A2) vs awaited inside activation (A1). *Recommendation: A2 — the
   owed-step shape the tenure already uses, activation latency kept
   flat; the client's bounded wait covers the window, and the demand
   pass's deferral re-arm makes either order safe.*
2. **The ensure run's attribution.** Owner-resolved per-run trust
   snapshot (labels name the space's ACL owner; the OW59 Q3 caveat's
   named follow-up) vs keep-service vs opening-session principal.
   *Recommendation: owner-resolved, fail-closed when no owner
   resolves; it is the only arm that is deterministic across all
   three activation triggers and that OW59's own close pre-endorsed.
   Needs your ruling because it mints `represents-principal` for a run
   you did not initiate — the Q2-arm precedent applied to creation.*
3. **The custom `defaultAppUrl` branch.** Server fetches the OWNER's
   configured URL (semantic change: owner's setting, not first
   opener's; plus a server-compiles-user-configured-origin trust
   surface extending OW55) vs client-kept vs unsupported-under-ON.
   *Recommendation: server-fetched owner-scoped, with
   log-and-use-system-default as the interim until you rule the fetch
   trust posture.*
4. **The runnability-repair seat.** Repair/roll-forward hooked on the
   serving loop's ROOT structure-load failure (recommended: cheap
   ensure, heal where the signal lives) vs eagerly probed inside every
   ensure. *Recommendation: the failure hook, once per tenure,
   counted.*
5. **Ensure on sessionless activations.** Event-carrying and
   warm-request activations ensure (recommended — the wish-provisioned
   and cross-space-delivery spaces get a piece list before first
   open); a stricter alternative limits the ensure to session-bearing
   activations. *Recommendation: ensure on all three triggers;
   idempotence makes the cost one fast-path read.*
6. **The client start in stage 2.** Keep `startPiece` on the resolved
   root (recommended; retirement is OW44's own arc) — confirm that
   the start's retirement stays OUT of this design's scope so the
   stage-2 diff stays small and the read-and-render dependency is not
   smuggled in.
7. **The skip-list posture.** Confirm §9's bar: the measurement run
   decides the lift on the skip's own stated terms; this design does
   not promise it. *Recommendation: as stated — plan the measurement,
   not the lift.*
8. **PR #6208 (the deferred-start retry).** It covers the ARM-A
   residual sites (`recreateDefaultPattern`, `llm-dialog`) and ARM-B's
   unmeasured loss windows that this design deliberately leaves. Land
   it as the complementary safety net, or hold it pending stage 2's
   measurement? *Recommendation: land it — the mechanisms compose, and
   the retry is the only cover for the sites this design does not
   reach.*
9. **The OW55 posture for the ensure's fetch.** Stage 1 rides the
   self-HTTP loop; adopting OW55's owed self-pin in the same stage
   (recommended) vs deferring to the in-process resolver follow-up.
   *Recommendation: pin in stage 1 — one line of posture now versus a
   trust surface quietly gaining a consumer.*
10. **N62's honesty note.** The sequence memo showed N62's deletion
    premise ("clients no longer run committed derivations") is ahead
    of the code; this design narrows the gap at the root's CREATE path
    but the START half remains client-side until OW44's arc runs.
    *Recommendation: no code action; record the narrowed residual in
    the OW45 row when stage 2 lands, so the spec-vs-code gap stays a
    tracked fact rather than an assumed-closed one.*
