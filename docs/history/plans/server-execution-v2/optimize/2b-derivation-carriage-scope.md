---
status: historical
created: 2026-08-21
archived: 2026-08-21
reason: "The cf:module cross-space §2b derivation-carriage residual scoped and closed: the rulings already select the profile space's own serving loop as the deriver (arm c) with the outbox as the amend's crossing (arm b, already built) — no fork; the live blocker was ONE send-site defect — cell.ts picked LT1-vs-outbox by the sending cell's space instead of the wave's home space — fixed red-first. The ten-run gate then separated the families: the amends cross durably in every run that writes them (the bio amend durable 10/10, red runs included), and the remaining red is a DIFFERENT class — the client name-draft own-write loss (OW47's family) — so the profile-embed skip is re-scoped to it, not lifted."
---

# The §2b derivation-carriage residual — scope, verdict, and the fix

Seat: the OW45/OW31-family cross-space-derivation residual (the
profile-embed amend-convergence blocker;
[`ruling5-ow49-report.md`](ruling5-ow49-report.md) §3). Branch
`claude/server-exec-v2-2b-derivation-carriage` off `origin/main` @
`ec6361782`.

## 1. Verdict: DETERMINED — no fork

The scoping question was which sanctioned crossing carries a
derivation's consequences when a HOME-space serving wave runs a
foreign piece's graph. The ruled sentences already decide it, and
they decide it *against* the question's framing: the consequences
never cross, because the derivation itself belongs to the other
space's loop.

- **(a) §2b delegated carriage extended to derivation consequences —
  REFUSED by ruled text.** protocol.md §2b's crossing table:
  "`derived` commit into a foreign space | FORBIDDEN — SpaceServer(B)
  is B's only deriver; A never derives into B." README §3.1: "a
  piece's graph is run by its home space's runtime … derived commits
  never target foreign spaces." The S-A precedent does not
  generalize: OW31's build stamped the compile-cache writeback as "an
  explicit carriage for the bookkeeping-kind materialization family"
  (`#stampRun`'s `info.kind === "bookkeeping" && info.delegated`
  arm) — content-addressed, idempotent program materialization,
  authored-class. A lift's output is a derivation write (§3d, RULED
  2026-08-05: "every write of a derivation run is a pure derivation
  write"); carrying it cross-space would mint a second deriver for
  the target space.
- **(b) The outbox — YES, for the amend EVENT, and it was already
  built.** The amend reaches the profile space as a cross-space
  event append: protocol.md §2b ("an event append to a foreign
  stream — the ONLY cross-space mutation … carried by the OUTBOX",
  with acting identity + `capabilityRef`; LT4's no-retry on
  deterministic rejection), LT5 (envelope = the producing server's
  service identity; admissibility from the validated grant), LT6
  (a demanded run's identity inherits into its emissions uniformly).
  The send site (cell.ts's serving branch), the wave staging
  (`stageOutboundAppend` → FP1 rows inside the wave transaction),
  the delivery admission, and the eventId dedupe all existed and
  were pinned (`executor-outbox.test.ts`).
- **(c) The profile space's own serving loop activates and the
  cf:module derivation runs THERE — YES; this is the ruled
  end-state, and at this head it already happens.** Activation:
  serving-loop.md §1 ("Activation on: session open, event append, or
  explicit warm request"; the provisioned space "stays parked until
  its first session or event", T11.Q7). Both hooks are live
  (`memory/v2/server.ts` `#notifySessionOpened` at session.open;
  `executor/host.ts` `#onCommitAdmitted` — an event-append admission
  activates even with no session). Live at `ec6361782`: the profile
  space acquires a lease, its program docs land server-authored via
  S-A's carriage, and its own wave derives the initial name
  ("Ada Lovelace" in a derived commit of the profile store, basis
  rows written). The OW49 report's "the profile space NEVER
  activates a serving wave" does not reproduce at this head; what
  DOES reproduce (pre-fix) is the amend loss, whose mechanism is §2
  below.

Answer to the standing question "is the never-activates state the
defect or the demand model working as designed": at the RULING-5
head it was a composite symptom; at today's head activation works
as designed and the surviving defect was not in the demand model at
all — it was one wrong comparison at the send site. NOT a demand
hole, consistent with the rootcause report's headline.

## 2. The live blocker, root-caused: the send site's LT1-vs-outbox
## axis was the sending cell's space, not the wave's home space

Reproduced at `ec6361782` on the ON binary (fresh store,
self-referential `API_URL`/`MEMORY_URL`, `servingLoop` posture
verified): profile-embed FAILED in 5m09s at the "Grace Hopper"
badge assert, with the amended values durably absent from every
store — the OW49 report §3 shape exactly. The server log carries
the mechanism, twice, with full stacks:

```
Uncaught error in action: StorageTransactionWriteIsolationError:
Can not open transaction writer for <PROFILE space> because
transaction has writer open for <TEST space>
  at CellImpl.set (cell.ts:1776) ← the LT1 same-space arm's raw entries write
  at CellImpl.send (cell.ts:2069)
  at eval (/system/profile-embed.tsx:103) ← saveName → setName.send
  (and :121 ← saveBio → setBio.send)
  at dispatchQueuedEvent …
```

Chain: the click's save event lands in the TEST space
(events-down); the TEST wave dispatches the served `saveName`
handler; the handler's tx already holds the TEST-space writer (the
`consequenced` mark, `space-server.ts` `#stampRun`); the handler
calls `profileWish.result.setName.send({name})`. The setName stream
is a DIRECT FOREIGN CELL HANDLE — `cell.space === resolved.space
=== the PROFILE space` — so the serving branch's arm selector

```ts
if (resolvedToValueLink.space === this.space) { /* LT1 same-space */ }
```

took the LT1 arm and raw-wrote the profile space's entries doc
inside the home-anchored tx: the one-tx-one-space isolation error
(protocol.md §2b's "an UNMARKED crossing always a bug", firing
correctly). The handler run died, no consequence staged, the
outbox arm was never reached, and the emission was lost — the
client's speculative echo painted "Grace Hopper" with nothing
durable underneath (the which-direction hazard shape the report
named). The standing 60–70 `foreign-write-refused` per run are the
SEPARATE, harmless-by-refusal signature of the home wave also
running the foreign piece's lifts (§4).

LT1's ruled sentence names the axis: "the SAME-SPACE server-emitted
append's durable entry is a WRITE within the wave's own derived
commit" — same-space as the WAVE. The code proxied that with the
sending cell's space, which agrees on every same-space piece (the
lunch/chat gates) and disagrees exactly on a foreign stream reached
through a foreign handle — the wish-embed topology, first exercised
by profile-embed. The proxy was wrong in both directions (an
aliased home target through a foreign handle would have taken the
outbox to the wave's OWN space).

## 3. The fix (determined; red-first)

- `packages/runner/src/storage/interface.ts`:
  `TransactionSealDestination` gains optional `readonly space` — the
  wave's home space; the SpaceServer and the wave accumulator
  already expose it structurally.
- `packages/runner/src/cell.ts` (serving branch): the arm selector
  compares `resolvedToValueLink.space` against the installed
  destination's `space`, falling back to the old cell-space proxy
  only for destinations that name none (bare same-space test
  doubles).

Red-first pin (`packages/runner/test/executor-cross-space.test.ts`,
"a served run's send to a FOREIGN stream cell crosses via the
outbox"): a served event-handler-stamped run, home-anchored, sends
to a stream cell whose own space IS the foreign space. Watched RED
on the unmodified tree — `StorageTransactionWriteIsolationError` at
`CellImpl.send`, byte-identical to the live stack — then GREEN with
the fix: the outbox delivers the entry into the foreign sidecar
with `firedAt` from the CARRIED actor, and the delivered append
ACTIVATES the target space's own loop (the (c) arm's trigger).

Suites at the fix (one file per invocation): executor-cross-space
14, executor-events-down 19, executor-outbox 18, executor-wave 43,
executor-run-supply 14, executor-serving-loop 25 — all green.

## 4. The ten-run gate: the families separate; re-scope, not lift

Ten fresh-store ON runs at the fix head (ON binary rebuilt with the
fix; per-iteration fresh store; self-referential
`API_URL`/`MEMORY_URL`; `servingLoop` posture verified per run; load
averages recorded — full table in the PR body). The durability bar
is store-queried, never the render. Outcome: **7 green / 3 red**.
The greens complete in
11–23 s with BOTH amends durably present — the profile store carries
the outbox-delivered authored append (`acting_principal` = the user,
`capability_ref` = `stream-append:<sidecar>`) AND the profile wave's
own derived consequence; the test space carries the client intent
and the home re-derivation. The three reds are 300 s badge timeouts
with a NEW, separated signature: the BIO amend is durably present
cross-space (the fixed chain end to end) while the NAME never lands
because the name DRAFT — a plain client `$value` write into the
TEST space — never lands as ANY commit; the served `saveName` then
reads an empty draft and correctly no-ops. `fillCfInput`'s host
`commit()` resolves and verifies the DOM value; the store never
sees it; no refusal surfaces anywhere. Not load-correlated: a green
passed at load 18 while the reds landed at loads 8–15. Zero
`StorageTransactionWriteIsolationError` in any run: the send-site
defect is extinct. (Pre-fix baseline at the same protocol: 4/10
green with the amended values durably absent from every store, the
greens riding the echo — the report §3 shape reproduced locally
before the fix as a 5m09s red with the two isolation-error stacks.)

That is OW47's family (client own-write durability), not the §2b
family: the cellset-lww fix closed the BLIND-write structural-read
mechanism, while this write races the served `startEditing` SEED
echo standing on the draft doc (the seed writes the current name
into the draft; the echo's standing window is a full served round
trip) — the value-consuming arm the OW47 fix deliberately kept
refusing, or a sibling loss on the same doc. It needs OW47's
instrumented-client tracing method and its own seat; per
flag-don't-fill it is NOT patched here. The profile-embed skip
entry is RE-SCOPED to name it precisely (the third re-scope, each
naming a strictly smaller blocker); the lift bar (10/10 green +
store-durable amends) is met for the amend-crossing mechanism and
not yet for the file.

Also remaining, flagged (not filled here):

- **The home wave still RUNS the foreign piece's lifts** (the
  standing ~60 refusals per run — `applyInitialName`, `__cfLift_*`
  refused at the accept gate). Fail-closed correct, wasted work and
  log noise: the serving runtime instantiates a piece it renders
  regardless of the piece's home (the wish pulls the foreign piece
  root). The clean end-state under README §3.1 ("a piece's graph is
  run by its home space's runtime") is for the home runtime not to
  RUN foreign-piece derivations at all — a scheduler/demand
  cleanliness item, not a correctness blocker; it should get its own
  seat rather than ride this fix.
- **OW54's give-up-without-consequence corner** stands as recorded
  (its trigger names this lift).
- **home-profile**: the shared refusal layer clears with this fix;
  its lift additionally needs the S-B barrier verified on its reload
  path — reported to the coordinator with a fresh ON run in the PR,
  not forced here.
