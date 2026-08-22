---
status: historical
created: 2026-08-22
archived: 2026-08-22
reason: "OW53 triage+build: the sqlite multi-runtime identity pair under ON determined IMPLEMENTATION on both halves against the ruled identity model (no fork memo owed) — the mint-site and hash-keying traces, the four-defect family (ambient identity consumed where the run's carried principal is required), the red-first fix, the 5/5+5/5 true-ON gate, and the one flagged severable arm (actor-less served creation mints no owner)."
---

# OW53 triage report — the sqlite multi-runtime identity pair under ON

Builder: OW53 triage+build agent. Worktree
`/Users/berni/labs-worktrees/ow53-triage`, branch
`claude/server-exec-v2-ow53-triage` off `origin/main` @ `51350077e`.
Date: 2026-08-22.

The row (verification-coverage.md §3, as minted 2026-08-21): two
semantic asserts red under the TRUE ON topology — db-owner ("bob's
runtime must not re-mint itself as the db owner") and read-clearance
("baseline request hash stays reader-blind" fails; the cleared result
doc carries more than the declared surface) — "an identity-model
decision ADJACENT to OW31's ruled posture but not covered by it",
**UNTRIAGED whether the fix is model or implementation**. This report
is the triage's record: the reproduction at main, the traces, the
determination, and the build.

## 1. Reproduction at main (before any change)

True ON topology per the first-ON-CI-gate protocol: the integration
runner's own toolshed at a private port offset (never :8000 — that is
a production instance on this machine), `EXPERIMENTAL_SERVER_EXECUTION=true`
inherited by servers and test workers, fresh store per run, posture
verified live (`/api/health/stats`: serving-loop waves and
`derivedCommits` advancing; `raw/run/sqliteDatabase` executing in the
TOOLSHED process; "Experimental flag overrides: serverExecution=true"
in every worker).

Both files red at `51350077e`, and **both failure shapes had MOVED off
the row's minted text** (the substrate that landed since the mint —
OW34/OW59's per-run trust snapshots, OW31's posture, the OW51/OW52
fixes — changed what is observable):

- **db-owner** (red in 6 s): `fromBob.owner` =
  `did:key:z6MksHnZ…` — **the toolshed's SERVICE identity**
  (`Identity.fromPassphrase("implicit trust")`, the default
  `IDENTITY_PASSPHRASE`), not bob. Bob's runtime does NOT re-mint
  itself; the serving runtime mints ITSELF at creation.
- **read-clearance** (red in 32 s, all three steps): (1) "alice's
  cleared query settles on her two rows" TIMES OUT; (2) the two
  readers' cleared request hashes are IDENTICAL (`oQICZ_0Yk…` both) —
  the assert that fails is the cleared-hash `assertNotEquals`, not the
  minted row's baseline-hash equality; (3) bob's raw cleared doc
  carries ONLY `["pending","requestHash"]` — a bare claim, i.e. LESS
  than the declared surface, not more: the cleared result never
  arrives at all.

## 2. The traces

### 2a. The mint site (db-owner)

`packages/runner/src/builtins/sqlite-builtins.ts`, the `sqliteDatabase`
init action: `owner = prior !== undefined ? prior.owner :
runtime.trustSnapshotProvider()?.actingPrincipal`. The provider is
BOUND AT RUNTIME CONSTRUCTION to `storageManager.as.did()`
(runtime.ts) — the user's own DID on a client, the SERVICE DID on the
serving runtime.

Instrumented at the mint (probe run, toolshed process):

```
ambient=SERVICE  prior=false  mintedOwner=SERVICE
txSnap=ALICE
waveCtx={kind:"derivation",
         scopeKeyIdentity:{principal: ALICE, sessionId:…},
         actionScopeKey:"space", attributionFromScope:true}
```

Three facts the fix rests on: (i) the serving-side creating run
CARRIES the demanding principal (alice) even for this space-scoped
node — the demand-supplied run identity is present; (ii) the OW34
per-run tx snapshot is ALREADY CORRECT (alice) — exactly what the
OW34 design's Q5 ruling promised ("this design only guarantees the tx
snapshot they would re-point at is right"); (iii) the mint reads the
RUNTIME-ambient provider instead, and mints the service. Client-side
probes: alice's bootstrap speculation minted alice into her overlay
(diverted, never committed); every later client run saw `prior=true`
and kept the durable (service) owner. The committed value is the
server's.

### 2b. The hash keying and the completion (read-clearance)

The cleared query fans per user on the server (probe:
`actionScopeKey:"user:alice"` / `"user:bob"` instance runs, each with
the CORRECT per-run tx snapshot), and:

- **The request hash** (`clearanceReader:` in the action) reads
  `runtime.trustSnapshotProvider()?.actingPrincipal` = SERVICE for
  every instance → both readers stage ONE service-keyed hash (probe:
  `hash=LTNDzv2I` for alice's AND bob's instance). Step 2's red.
- **The claims land per-user** — each stamped run's commit annotates
  its instance `scope_key` — so `user:alice` and `user:bob` each hold
  `{pending: true, requestHash: H_svc}`.
- **The flush's writeback never lands.** The completion runs in the
  toolshed process (`outbox {queued: 5, completed: 5, failed: 0}`) but
  its `editWithRetry` transactions are UNSTAMPED
  (probe: `scopeKeyIdentity={principal: SERVICE}`, `wtxCtx=null`), so
  the hash-guard read `result.withTx(wtx).get()?.requestHash` resolves
  the SERVICE's user-partition — which holds NO claim
  (probe: `storedHash=undefined`) — and returns without writing. This
  is the KNOWN, FLAGGED-not-filled stage-A residual, in the code's own
  words (space-server.ts `#commitEffectCompletion`): "the writeback
  transaction itself is unstamped, so its hash-guard READS resolve
  against the service's instances; a per-instance node's effect
  completion is unpinned in this stage." The orphan-claim re-issue
  (serving-loop.md §4/§6) re-fires the effect every wave and each
  flush no-ops the same way — bare claims forever (steps 1 and 3).
- **One collision more:** with both instances staging the SAME hash,
  their outbox keys (`effectTargetKey` embeds the hash) collide — only
  ONE cleared flush ran for TWO instances (probe: 4 stamped query
  runs, 1 cleared flush). Reader-keyed hashes dissolve this for
  cleared queries by construction.

## 3. The determination — IMPLEMENTATION on both halves

The row asked whether the fix is model or implementation. The model
was COMPLETED by rulings that landed after the row was minted; the
composed sentences determine the fix, and no fork memo is owed:

- **serving-loop.md §3c (RULED 2026-08-21):** "The run's CFC trust
  snapshot carries the run's ACTING principal … **never the serving
  runtime's ambient identity**."
- **protocol.md §1 (RULED 2026-08-03):** "Server-side runs never
  derive identity from their own session: identity arrives WITH the
  work (the demand, or the stamped `firedAt`) and is **carried into
  keys, not resolved from ambient state**."
- **builtins.md §2 (RULED 2026-08-02):** the sqlite memo-key basis
  includes the "reader principal"; "one cleared result cell per
  (query, reader)"; "cleared **where the read is served**".
- **serving-loop.md §4 (RULED 2026-08-03/05):** the effect enqueues
  with "the run's identity carriage — the result-cell address
  including its instance `scope_key`, plus the run's acting identity
  where it had one"; "the completion commit's identity annotations
  are sourced from the carriage captured at the ORIGINAL run's seal".
- **06-cfc.md's dbOwner row:** the owner is "the principal that
  created the SqliteDb cell" — under the ruled tx model, the CREATING
  RUN's acting principal (which the trace shows is carried and
  correct in the per-run snapshot). On a client the ambient IS the
  acting user, so this reading is byte-identical OFF and
  OFF-equivalent ON (the same owner alice's own client would have
  minted).
- **OW34 design §7 + Q5 (RULED 2026-08-21):** named these exact
  direct provider reads as the re-point sites and the per-run
  snapshot as the substrate, deliberately leaving the re-point to
  OW53.

Every defect in §2 is code resolving identity from ambient state
where these sentences require the run-carried principal. The only
question the ruled corpus does not answer to the letter:

**The flagged arm (severable, built conservative): a SERVED creating
run with NO carried actor.** `#stampRun` leaves the ambient service
snapshot on such a run (the Q3 ruling), so a naive tx-snapshot
re-point would mint `owner = SERVICE` — which GRANTS the service
dbOwner() row-read admission, a capability widening no ruling asks
for. The build follows the closest ruled precedents instead — OW31's
genesis arm ("serving runtime with no actor REFUSES") and
`homeSpacePrincipalFor` ("refuses loudly rather than falling back to
the service DID"): an actor-less served creation mints NO owner, the
handle is ownerless, and dbOwner() fails closed downstream (the
mint's own documented ownerless posture). The Q3 keep-service reading
(the label-placeholder carve-out's analog) is the alternative arm; it
is one branch to change if the owner rules the other way. No live
surface reaches this arm today (a creation demanded by nobody).

Deliberately NOT determined here (flag, don't fill):

- **llm-dialog's provider read** (`llm-dialog.ts:2426`) — the same
  family, named untouched by OW34 §7 and left untouched by this
  build: OW53's row and trigger are the sqlite pair; no ON surface
  pins llm-dialog's read today. Recorded in the register row as a
  residual; whether it gets its own OW row is the coordinator's call.
- **The per-instance effect-key gap for NON-clearance user-scoped
  queries:** a reader-blind hash (by design — non-clearance queries
  must not re-hash per reader) means two instances of a per-user
  query share one outbox key, so the second instance's completion is
  deduped away — the OW17 flag's remaining scope, with no live
  surface and no pin. The fix direction, if a surface ever appears,
  is the instance key joining `effectTargetKey`; building it now
  would change outbox dedupe semantics for every effect kind with no
  red test to answer to.
- **NOTE-6** (delegated read sessions register demand under the
  process DID) — untouched, label-inert, as the OW59 row records.

## 4. The fix

`packages/runner/src/builtins/sqlite-builtins.ts`, one exported helper
plus its consumption:

1. **`sqliteRunActingPrincipal(runtime, tx)`** — a stamped run's
   carried actor (`context.acting?.user ??
   context.scopeKeyIdentity?.principal`; a derivation's context
   carries the demanded principal with `attributionFromScope`, no
   eager acting); an unstamped run (every client run — ON speculation
   included — and the whole OFF arm) keeps the ambient provider read
   byte for byte.
2. **The mint** consumes it: a served creation mints the creating
   run's principal; actor-less → NO owner (fail closed); unstamped →
   the provider (unchanged).
3. **The cleared-read hash** keys `clearanceReader` by it.
4. **The flush** captures the requesting run's reader and
   `scopeKeyIdentity` at action time and (i) sets the OW17 identity
   seam (`wtx.tx.scopeKeyIdentity`) on EVERY writeback transaction —
   inside the `editWithRetry` callbacks, success and failQuery arms
   alike, so each retry's fresh transaction carries it before its
   first read — making the hash-guard read and the writes resolve the
   REQUESTING instance; (ii) resolves the ceiling placeholders and
   the clearance reader from the CAPTURED principal on served
   requests (a served request with no captured reader passes
   undefined and the clearance path refuses — fail closed), keeping
   the unstamped arm's read-at-flush-time provider behavior
   byte-identical.

The completion tx deliberately gains NO wave-run stamp: §4 says the
completion "never passes through §3d's sealing — the run is long over
when the response arrives"; the identity seam without a stamp is the
event-preflight precedent (scheduler/events.ts), and the durable-side
annotations continue to ride the outbox carriage as before.

Spec sentences landed with the code (docs-move-together):
06-cfc.md's dbOwner row (creation under served execution mints the
creating run's acting principal, never the ambient service; actor-less
mints no owner) and the Phase 3.b acting-reader sentence (the
requesting run's principal, with the builtins.md §2 cross-reference).

## 5. Red-first evidence

Unit pins (`packages/runner/test/sqlite-served-identity.test.ts` —
raw builtins driven with hand-stamped transactions, the ambient
identity playing the service):

| pin | base (WATCHED) | fixed |
|---|---|---|
| served creation mints the stamped run's principal | RED — minted the ambient service DID against a stamped alice run | GREEN |
| actor-less served creation mints NO owner | RED — minted the service DID | GREEN |
| unstamped creation keeps the provider (client neutrality) | GREEN | GREEN |
| cleared hashes keyed per stamped reader | RED — both readers staged ONE service-keyed hash | GREEN |

The durable per-instance completion arm is not unit-pinnable without
the full serving harness (the unit harness's authored-commit path
resolves scope by session, so both halves of the seam cannot be held
consistent in one emulated realm); the composed pins are the two
integration files themselves, WATCHED RED at main (§1) and green at
the fix head (§6).

## 6. The true-ON gate (the lift evidence)

Same topology and protocol as §1; fresh store per run
(`rm -rf packages/toolshed/cache`); load recorded per round; posture
verified live each run.

| round | load (1/5/15 min) | db-owner | read-clearance (3 steps) |
|---|---|---|---|
| 1 | 6.8/7.2/6.6 | PASS (1 step) | PASS |
| 2 | 5.9/6.9/6.6 | PASS | PASS |
| 3 | 7.8/7.3/6.7 | PASS | PASS |
| 4 | 8.5/7.4/6.8 | PASS | PASS |
| 5 | 9.0/7.7/6.9 | PASS | PASS |

**`sqlite-db-owner-multi-runtime` 5/5; `sqlite-read-clearance-multi-runtime`
5/5 with all three steps.** Both ON skip entries LIFTED (the row's
minted trigger); the skip-list test re-pins the lift (no gate FILE
entry remains — the first-ON-CI-gate set is fully lifted at the file
level; `patterns` holds `topics-navigation` + the default-app reload
STEP under OW45).

## 7. Suites run at the fix head

Per-file (the runner package's task-shaped invocation):
`sqlite-served-identity` 4/4 steps, `sqlite-db-owner` (the OFF mint
contract) 1/1, `sqlite-builtins` 9/9, `sqlite-read-labeling` 7/7,
`sqlite-handle-multi-runtime` 2/2, `sqlite-row-label-read` 34/34,
`executor-trust-attribution` (the OW34 pins) 17/17, `executor-outbox`
18/18, `executor-serving-loop` 25/25, `executor-instance-keyed-replica`
6/6; `tasks/server-execution-on-skips.test.ts` 17/17;
`tasks/select-pattern-integration-files.test.ts` 13/13; `deno check`
clean on the changed module and the new test file. (The full-package
and repo gates ride the PR's CI.)
