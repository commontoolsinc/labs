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

1. **Attribution: owner-resolved, fail-closed (design §4 option (b);
   open question 2).** The ensure resolves the space's ACL owner
   through a thin public API over the memory server's
   `#resolveSpaceOwnerBinding` — the one ruled service-identity ACL
   read (OW31, 2026-08-19) — and the creation transaction stamps
   `bookkeeping` PLUS an owner-resolved per-run CFC trust snapshot
   (`trustSnapshotForPrincipal(owner)`), the exact follow-up OW59's Q3
   caveat pre-named. A space whose ACL yields no concrete owner gets NO
   ensure: skip, warn, count, retry next tenure — never the service DID
   as fallback (`homeSpacePrincipalFor`'s posture; OW53's ruled shape).
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
  flagged for the owner beside assumption 1 rather than filled.
- **Sessionless-activation ensure (design open question 5).** The owed
  step arms at `activate()` unconditionally, so event-carrying and
  warm-request activations ensure too — the design's recommendation
  (idempotence makes the cost one fast-path read; a wish-provisioned
  space gets its root before first open). If the owner prefers
  session-bearing activations only, the arming moves behind the
  trigger, one line.

## The seat as built

_TO BE FILLED with the landed shape (owed-step flag, single-flight,
counters, failure arms) once the code is pushed — this skeleton records
the assumptions first so the branch carries them from its first push._

## Red-first evidence

_TO BE FILLED per pin: the watched failure text before the seat/fix
exists, including the OFF witness._

## Measurement — before/after at the true ON topology, ambient load only

_TO BE FILLED: whether the server's ensure precedes the client's, the
ARM-A refusal rate, and the client's five-commit sequence
(count/composition), before vs after, with run ledgers._

## Suites run

_TO BE FILLED with counts._
