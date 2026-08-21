---
status: historical
created: 2026-08-16
archived: 2026-08-18
reason: "Fan-out evidence: the adversarial panel over the fan-out run-supply design — BUILDABLE-WITH-AMENDMENTS; the amendments landed in fan-out stages A/B."
---

# Fan-out run-supply design — adversarial panel

Report-only. Worktree `/Users/berni/labs-worktrees/fanout-panel` detached at
P7 head `6d18d6998` (matches the design's cited tree). No pushes, no GitHub
writes. Every `file:line` below was opened and read at this head unless marked
"faith". The design under attack:
`/Users/berni/labs-worktrees/fanout-run-supply-design.md`.

**Verdict: BUILDABLE-WITH-AMENDMENTS.** The design is unusually rigorous — 20
facts, of which I re-verified 17 against code; anti-patterns explicitly banned;
residuals named honestly. No section needs a redesign. Five amendments (§Synthesis)
must land in the plan before build. No BLOCKER that forces value-incorrectness;
four MAJORs, each an addition / re-sequencing / claim-correction.

---

## LENS 1 — Correctness of the instance-set function (§B)

### The ragged case is REACHABLE, and the monotonicity argument is FALSE below the top hop

The design's whole `k(node)` single-ratchet (B1) rests on scopes.md §2's
Monotonicity ruling — "narrowing is for everyone or no one … the link INTO the
narrower scope is itself shared state AT the broader scope." I traced the two
narrowing-write paths and the claim is only structurally true for the
**space→user** hop.

Verified mechanism (`pattern-binding.ts:282-334`, `data-updating.ts:701-785`):
the narrowing redirect writes the value at `{...ref, scope: outputScope}` and a
sigil link at the broad slot. With the eager via-user hop
(`pattern-binding.ts:308-326`), a space→session discovery writes THREE things:

- `X/session` = value — resolved against the **run's own identity** → `session:A:s`
- `X/user` = redirect→session — written at `userRef = {...ref, scope:"user"}` →
  resolves to `user:A` (the RUN's user, `resolveScopeKey("user", runIdentity)`)
- `X/space` = redirect→user — the one shared doc

The **first hop (`X/space`→user) is shared** (one space doc, so `X/space`
consistently says "user" for everyone — monotonic). The **second hop
(`X/user`→session) is written into `user:A` only.** `user:B` is a different doc
and is untouched.

**Construct the ragged node.** `X = computed(() => { const p = myProfile; return
p.usesSessionThing ? sessionThing : p.name; })`. User A's profile sets the flag →
A's run reads `sessionThing` (session) → narrows X to session. User B's flag is
off → B's run reads only `myProfile` (user) → narrows X to user. On disk, stably
and consistently:

```
X/space  → redirect(user)                 [shared, written by both]
X/user:A → redirect(session)  X/session:A = A's session value
X/user:B = B's user value      (no redirect — B stopped at user)
```

The node is **session-scoped for A and user-scoped for B, simultaneously.** The
shared `X/space` redirect narrows everyone only to the *shallowest* depth any
principal took (user); below that, per-user raggedness is representable and
reachable. scopes.md §2's structural argument **assumes** raggedness away for the
whole lattice; it only earns it for the top hop. scopes.md §9's tripwire
("ragged instance sets as a steady state") is therefore **violated by reachable
data-dependent patterns, with no detection anywhere.**

### What breaks (and what does NOT)

I chased value-correctness hard, three times. **Values stay correct.** Because k
"only ever narrows" (B1, Permanence), A's session discovery ratchets `k:=session`;
`instances(session, D)` then runs B **per B-session**. Each B-session run is
stamped `{B, s_bi}` but reads `myProfile` at `resolveScopeKey("user",{B,s_bi})` =
`user:B` (the session component is ignored for a user-scoped read), discovers
user, writes `X/user:B` — all B-sessions produce the identical value, later ones
no-op by equality. Push filtering (protocol.md §3) hands A `{X/space, X/user:A,
X/session:A}` and B `{X/space, X/user:B}`; each follows the chain to its own
value. Verified by reading the redirect resolution + `#scopeKeyFor`
(`wave.ts:1660-1668`).

So this is **not a value BLOCKER.** It is a MAJOR with three concrete costs the
design does not model:

1. **The §A/scopes.md §2 monotonicity claim is false as written.** It must be
   restated: structural only at space→user; below that, "k only narrows" is a
   *policy* that forces the finest depth any principal discovers onto ALL
   principals.
2. **Cost is O(sessions), not O(users), for ragged nodes.** A user-scoped-for-B
   node with B holding M sessions runs M times per wave for B (all but one
   no-op). §D's cost model ("N users × M nodes") misses this axis entirely.
3. **Session-keyed basis-row zombies the S4 rule cannot clean.** B's session runs
   record basis rows under the stamped `session:B:s_bi`
   (`wave.ts:1889-1892`, `:2155-2191` use `context.actionScopeKey` = the stamp).
   B3-item-3's S4 narrowing-delete fires only when *discovered* scope is
   **narrower** than the recorded key; here discovered=user is **broader** than
   the stamped `session:B:s_bi`, so it never fires (`scheduler-basis.ts:60-95`
   `replaceSchedulerBasisRows` is only invoked in the narrower direction). When
   B's session retires, the row survives (scopes.md §8's session GC is unbuilt),
   and §6 re-mark re-dirties X at `session:B:s_bi` — a departed session with no
   runnable identity in D → a permanent dirty-frontier entry that never clears.
   This is a NEW zombie class beyond scopes.md §3b's "space-key zombie," and the
   S4 rule was believed to cover exactly this.

### Sub-questions, answered

- **Probe discovering a different scope than another demander would:** yes — the
  probe runs `min(D)` only (B2). If `min(D)` is broad-scoped, k reaches the floor
  via extra re-arm cycles; if narrow, k jumps straight and over-keys the broad
  principals immediately. Either way k converges to the finest depth **any**
  demander discovers. Bounded (≤2 re-arms, lattice depth), value-correct,
  transient-shape only.
- **Ratchet permanence vs a per-user conditional link:** the single k cannot
  represent per-user depth; permanence makes k **stick at the finest even after
  the narrow-discovering principal (A) leaves** — B keeps paying O(sessions)
  forever. Widen-back is closed NO (scopes.md §2), so nothing recovers it.
- **B5 "service never runs demanded work" vs undemanded eager narrowing (§I.4):**
  correctly handled — `D=∅` eager/idle actions keep the wave fallback and write
  `user:<serviceDID>`. That instance is inert: no real user's applicable set
  includes `user:<serviceDID>`, so it is invisible to clients and orphaned.
  accept-and-count is fine.
- **min(D) determinism (risk 5):** safe for VALUE. I verified attribution derives
  from OUTPUT scope (`wave.ts:1861-1878`, §F), never from the probe identity — so
  `min(D)` churning as the smallest pair leaves cannot corrupt any annotation.
  The pin "no annotation depends on min(D)" is correct and satisfied today.

---

## LENS 2 — OW17 prerequisite + stage-A blast radius (§C, §G-A)

### The keying facts hold; the count is exact

- **F4: exactly 16 `docKey(` sites** in `SpaceReplica` — I counted them
  (`storage/v2.ts:1861,2363,2567,2579,4424,4628,4678,4722,4750,4976,5034,5132,5310,5365,5375,5399`;
  `grep -c` = 16). `docKey = ${normalizeCellScope(scope)}\0${id}` (`:2106-2107`),
  one bound identity per replica (`:2300`). Two ADDITIONAL name-keyed sites at
  `:4476`/`:4515` are per-commit-assembly transients (one identity per commit) —
  instance-safe, correctly outside the 16.
- **F5: the wire cannot carry two instances.** `SessionSyncUpsert`/`Remove` have
  `scope?: CellScope` and NO key (`memory/v2.ts:1017-1031`); `toWireUpsert`
  strips `scopeKey` and preserves field order for byte-identity
  (`server-sync.ts:104-125`); `WatchView.applySync` keys by
  `watchKey(branch,id,scope)` (`client.ts:1490-1518`); the collapse guard refuses
  a read set resolving two instances of one (branch,id,scope) (`server.ts:4198-4241`).
  All verified.

### (a) OFF byte-identity — holds BY CONSTRUCTION, on one hinge

`leaseHolderReads` is set **only** in `#denyExplicitInstanceReads`
(`server.ts:4271`), which returns early when `!getServerExecutionConfig()`
(`:4243-4249`). So OFF, no session is ever exempt, no frame carries a key,
`toWireUpsert` strips regardless — byte-identical. Runner side: a watch root
carries `entityScopeKey` only when the read identity ≠ the manager's own, which
at OFF cardinality-1 never happens. **The invariant is real but fragile: a single
new field-set site NOT gated on `getServerExecutionConfig()` + lease-holder
breaks it.** The design lists this as a danger pin; keep it as a grep-able CI
tripwire, not a review nicety.

### (b) tx→replica seam picking wrong — safe because runOnce makes one identity per tx

`v2-transaction.ts:2549,2571` call `replica.getDocument(address.id,
address.scope)` — under A3 they gain `?? own`. The hazard is a tx servicing two
identities' reads. It cannot arise: `runOnce` (`run.ts:410`) creates a **fresh
`state.runtime.edit(...)` per instance run**, so the N-run loop gives each
instance its own tx. The design's "one identity per tx, assert it" (A3) is
satisfied structurally; keep the assertion as a guard against a future code path
that reuses a tx across instances.

### (c) Writer-index fan-in — correct given the instance-keyed dirty log; O(N) waste, not a NEW bug

Today `updateWriterIndex`/`forEachOverlappingWriter` key `writersByEntity` by
`entityKey(write, identity)` = `${space}/${resolveScopeKey(scope,identity)}/${id}`
(`scheduling-writes.ts:79,220`; `keys.ts:26-33`) — instance-resolved against the
runtime identity, collapsing to one at OFF. `readsOverlapWrites`
(`:156-190`) matches by scope **NAME**. The design's A4 makes the writer index
**name-keyed** so the reader→writer *topology* edge survives when reads carry
instances. Attack result: invalidating A's doc re-dirties the **node** (node-level
dirty flag) → all N instances re-run, but **each reads its own instance via the
stage-A read seam** (instance-keyed dependency log, A4 keeps that per-instance),
so the unchanged siblings no-op by equality. Cross-instance *dirtiness* is NOT
introduced — the storm's ping-pong edge (A's write dirtying B's reader) is cut by
the instance-keyed dep log, which the name-keyed writer index does not touch. So:
**correct given stage A, wasteful O(N) (= risk 3), no new correctness bug.** The
pin "user-declared writer + Alice-run reader keep their edge" (A-e) is the right
mutation target.

### (d) Stage A lands and verifies alone — YES, with one caveat

Stage A is testable via **scoped-root demand** (P2-F's existing supply, F2's
second row carries identity) to get cardinality 2 without the stage-B space-root
fan-out. A-d pins R7 at cardinality ONE. A-e drives the cross-instance
reader→writer edge — so the A4 name-keying change (only *exercised* when reads
carry non-own instances) is pinned within stage A, not left dark until B. Caveat:
**the nine-site identity audit (A3) is load-bearing and a partial audit
regresses cardinality-1-invisible bugs.** I verified the sharpest one: the eager
scoped-property seed (`data-updating.ts:850,860`) keys its dedupe memo on
`seedMemoKey(seedTarget, runtime.scopeKeyIdentity)` — the **service** identity.
Post-stage-A at cardinality ≥2, Alice's run records the memo under the service
key, and **Bob's run sees it present → skips the absence check → never seeds
Bob's user-scoped default.** Bob's defaulted doc silently vanishes — a NEW bug
the OFF arm never had. The design flags exactly this site in A3; it must be a
hard stage-A test, not a comment.

---

## LENS 3 — Waves, watermark, budget, the storm (§D)

### The W rule + budget: exhaustion holds W — and sustained N-user load can PIN it

Verified: `advanceTo = exhausted ? this.#watermark : Math.max(...)`
(`space-server.ts:2499-2502`); the T_flush deadline fires **mid-await** via
`Promise.race([settle, deadlinePromise])` (`:2398-2430`), `exhausted=true`
suppresses the advance. So C10 holds: an exhausted wave commits and does not
advance W.

**The attack lands as a MAJOR.** A large-N fan-out is NOT itself "an unquiescing
cascade" — N instance runs each run once and quiesce (equality cutoffs). But with
**instance-imprecise dirtiness** (B7 unbuilt), ONE user's keystroke re-runs ALL N
instances of every downstream narrowed node — O(N) per keystroke, O(N²) for N
concurrent typers (§D states this). At scale, each T_flush window brings new
input from N users, the wave exhausts on the deadline before draining, **W holds**,
the next wave inherits the cascade PLUS the next batch, and W can pin for the
duration of sustained load. The design frames this as "latency, not correctness."
It is more: **the client-half's ruled retirement (§E) fires only when `W ≥ floor`
(speculation.md §4, `overlay-destination.ts:902-910`). Pinned W → retirement never
fires → the OW32-class client loop reactivates at scale** — the exact loop the
whole design exists to kill, now gated on server throughput instead of server
correctness. So **B7 (instance-precise dirtiness) is load-bearing for W-liveness
under concurrency, not the optional optimization §D calls it.** Its trigger should
be W-pinning / retirement-stall, not just a latency benchmark; and the two-browser
gates (N=2) will not surface it.

### The OW29 storm — every edge cut, no residual

The cycle, named explicitly:

```
(collapsed replica, pre-A) A-run and B-run both write local doc  user\0X
  → each seal changes the SHARED doc under a different identity's value
  → own-source skip protects only the writer (invalidation.ts:160-162, by ACTION)
  → every OTHER reader-node of user\0X is invalidated → re-runs → writes back
  → PLUS each patch diffs against the sibling's collapsed value (F7c)
      → engine "missing path" reject → wave withdraws → rollback re-dirties all
  → repeat at the deadline cadence  ≈ 4,427 waves / 5 min  [faith: build report]
```

Per-instance keying (A2/A3) cuts **every** edge, verified by mechanism:
- shared-doc write collision → CUT (`docKey` now `user:A\0X` vs `user:B\0X`).
- cross-instance invalidation → CUT (dep/trigger log stays instance-keyed under
  A4, so A's write to `user:A\0X` matches only readers of `user:A\0X`).
- patch-vs-sibling reject → CUT (A's diff base is `user:A\0X`, its own).
- **re-arm feeding a new wave (the owner's residual-edge worry):** B3.4's
  `markInvalid + queue` re-runs siblings; a sibling that discovers a *still*-
  narrower scope re-arms again, but bounded by lattice depth (≤2) and forbidden
  from oscillating by Permanence (k only narrows). No residual storm edge.
- **B4 per-demander walk (one node, N runs):** its cost is "N × walk per changed
  root" (= what each client tab does today); the walk writes nothing, so it
  triggers no wave of its own. Confirmed against the demand-sink shape
  (`space-server.ts:2229-2253`, `JSON.stringify` read-only walk).

---

## LENS 4 — Identity, attribution, security (§F, §B6, §I.2/3/5) — no security blocker

### (a) risk 4 is UNDER-attribution (fail-closed), never escalation

The LT6 send reads `context.acting` mid-run (`cell.ts:1697-1708`). §F moves
`acting` derivation from stamp-at-start to **output-scope at point of use**. The
ratchet **only narrows** (space→user→session, `recordReadScope`
`extended-storage-transaction.ts:974-979`). So a run that emits an event BEFORE
reading scoped state derives `acting` from a **broader** (space) scope = **fewer**
identity components = LESS actor. You cannot manufacture more session-ness than you
have discovered. Every timing error here is under-attribution → a sessionless
event → the sessionless-write ERROR (scopes.md §5) → **fail-closed**. There is no
path to a user-level actor reaching another user's session instance, and none to
cross-principal escalation: even a threading bug that emitted the *resolution*
pair `{alice, s_rep}` stays within Alice's own sessions. Rank: MAJOR-liveness
(early-emit loses its actor and the consequence mislands/errors), NOT a security
issue. Amend §I.2 accordingly (below).

### (b) Redirect attribution (§B6) leaks only to the server audit log, not to clients

The discovering run writes `X/space`'s redirect inside its own tx, so the op
carries `actingUser` (`wave.ts:1861-1878`). But (i) the redirect VALUE is a
constant `{overwrite:redirect, scope:user}` shape — independent of the user's
data, no value leak; (ii) per-op annotations are DERIVED-commit metadata and are
**not** in the pushed wire frame (`SessionSyncUpsert` = `{branch,id,scope,seq,doc}`,
no annotation field), so Bob never observes "Alice narrowed X first." The residual
is a provenance-fidelity nit (a shared redirect attributed to one arbitrary
first-arriver in the audit trail) — the design's amend-the-sentence rec is right.
**One sharper hazard to add:** the shared `X/space` redirect now rides a per-user
run's tx, so its durability is **hostage to that run's commit** — Alice's rollback
withdraws the space-level redirect Bob's narrowing needs, delaying B by A's fate.
Already true in today's single-deriver model, but at cardinality ≥2 it becomes a
cross-user coupling worth a sentence.

### (c) Transient-demander preflight (§I.5) is SAFE — no reverse-FP2

The event actor is server-stamped from the authenticated append envelope
(events.md §1; protocol.md §2 admission requires append authority on the stream).
Making `firedAt`'s pair a transient demander materializes the **actor's OWN**
instance (`user:<actor>`), which they are entitled to by holding append authority.
It does NOT silent-materialize another principal's instance. The reverse-FP2 trap
does not open. Agree with "include."

### (d) Grant gate + OW31 — home per-user writes are lease-admitted, no refusal

The wave's foreign-write gate (`wave.ts:984-1022`) fires **only** for
foreign-space writes. Home-space per-user writes (the common case — X lives in the
serving space) seal through the replica as `derived` class, admitted by the lease
equality check (protocol.md §2), under the service DID which is implicit owner of
its own space (OW31). So the fan-out's per-user home writes are admissible with no
per-user grant. Cross-space (a wish `.inSpace(home)`) carries
`capabilityRef=demanded-run:<user>` + acting (`space-server.ts:1069-1076`) and
hits `#foreignGrantFor` (`wave.ts:994`) — the Phase-5 delegated path, present but
inheriting OW13's unhardened-grant caveat (already recorded). No new blocker.

---

## LENS 5 — Client half, anti-patterns, plan shape (§E, §H, §G)

### (a)+(b) The boot / first-demand transient is NOT closed by the fan-out — MAJOR sequencing

In steady state the design's client claim is sound: the value and the watermark
advance ride the SAME derived commit (protocol.md §4:598-608), delivered
atomically (F17, speculation.md §4), so when the sweep fires (`W ≥ floor`) the
value is present. Verified against the specs.

But §E residual 1 is the ORIGINAL OW32 symptom, not a corner: a node whose basis W
**already covers** at speculation time (boot; old inputs) retires **immediately**
— before the server has run its first demanded wave — flips to `undefined`,
re-speculates, and loops until the first server value lands (triage's "31× on
`__cfLift_1`", ~80 ms cycles, visible flicker; `nonsettle-triage.md:80-84`). The
fan-out does not fix this; the design defers the shelved arrival gate to
"measure after stage B and maybe land." The triage already measured the arrival
gate: **30 client-only lines, OFF-neutral, 45–56 k → 55–137 runs/5 min, 0
non-settling, idle resolves** (`nonsettle-triage.md:200-237`, R7/R9/R10). Deferring
a cheap, independent, high-value fix that closes the boot transient the fan-out
leaves open is under-sequencing. It should be an EARLY rider (§Synthesis A4).

### (c) Demand-walk coverage — the wish-sidecar chain gap is UNFILLED (verified) — MAJOR

I checked the demand-root chain at THIS head (past the P7 review's finding 4):
- `map.ts:424,452`, `filter.ts:457,485`, `flatMap.ts:462,490` now **do** pass
  `parentPieceRootId` — the review's finding-4 gap was fixed after 97cb7aa47.
- `wish.ts` `runtime.run` sidecars (`:2031,:2042,:2095,:2218,:2356`) use the
  4-arg form `runtime.run(tx, pattern, input, resultCell)` — **no
  `parentPieceRootId`, no demand-root chain.**

Wish sidecars are exactly the per-user `#profile` wish (the lunch gate's blocker,
review finding 3). §B4's per-demander walk follows the root VALUE's links; a wish
sidecar child is instantiated by a builtin sidecar run with its own (unlinked)
demand root, so the walk **cannot reach it** → no demander demands it →
server-side unserved → OW32 persists for it. Therefore **B-h (the lunch gate
"`#profile` wish runs per demander") cannot green while the wish-sidecar chain is
unfilled.** The design lists B-h as a stage-B deliverable but files the chain gap
under "flagged, not filled" (risk 2, §E residual 4). That is internally
inconsistent: completing the wish-sidecar (and re-verifying every) demand-root
chain must be IN stage B's scope.

### (d) Anti-pattern check — clean

No smuggled per-instance graph nodes (the walk is "one node, N runs",
`run.ts:485-491`; node count independent of N, C11b, pinned by A-e/B-c). No client
fallback execution (client speculates own instance only, scopes.md §4/§9). No
static scope analysis — `k` is a runtime memo of the last discovered scope,
forgotten on park, re-learned by the probe (`recordReadScope` is the only writer,
plus the write-path redirect and `homeSpacePrincipalFor`, all runtime events).
The probe "run one representative, then fan" is a staging of "per demanded
instance", not a violation. Disciplined.

### (e) Plan shape — A is independent of B; the smallest first cut is arrival-gate + A

Stage A is reviewable and verifiable alone (Lens 2d). The smallest cut that moves
the two-browser gates is **the client arrival gate (independent, cheap, OFF-neutral)
+ stage A (R7 read seam)** — the arrival gate clears the boot stall, stage A clears
the served-handler wall (R7) the triage found waiting behind it
(`nonsettle-triage.md:258-292`). Full stage B is needed for genuine multi-user
per-user derived state, but the gates may substantially green on arrival-gate + A
before the fan-out supply exists. Re-sequence: arrival-gate + A → B (with the chain
fix and B7-under-concurrency) → C.

---

## SYNTHESIS

### Findings, ranked

**MAJOR (design must add / clarify / re-sequence before build):**

1. **[L1] The monotonicity argument is false below the space→user hop.** Reachable
   data-dependent per-principal narrowing produces a stable ragged node the single
   `k(node)` cannot represent. "k only narrows" preserves value-correctness by
   over-keying, at O(sessions) cost (not in §D's model) and leaving session-keyed
   basis-row zombies the S4 delete never cleans (fires only narrower-than-stamp).
   Amend §A/scopes.md §2's claim; add ragged handling + extend S4/GC to
   broader-than-stamp discovery, or prove data-dependent narrowing unreachable.
2. **[L3] B7 (instance-precise dirtiness) is load-bearing for W-liveness under
   concurrency, not optional.** Sustained N-user O(N²) re-runs keep waves
   exhausting → W pins → client retirement (§E) stalls → OW32 reactivates at
   scale. Make B7's trigger W-pinning/retirement-stall; the N=2 gates won't
   surface it.
3. **[L5c] The wish-sidecar demand-root chain is unfilled** (`wish.ts` `runtime.run`
   sites carry no `parentPieceRootId`). §B4's walk cannot reach per-user wish
   children; B-h (lunch gate) cannot green until the chain is completed. Move it
   from "flagged residual" into stage-B scope.
4. **[L5a/e] Land the client arrival gate early, not as a maybe-follow-up.** It is
   30 client-only OFF-neutral lines, already measured to clear the boot transient
   the fan-out leaves open. Sequence it with/before stage A.

**minor:**
- **[L2a]** OFF byte-identity hinges on every new field-set being gated on
  `getServerExecutionConfig()`+lease-holder; make it a grep-able CI tripwire.
- **[L2 seed]** The A3 nine-site audit (esp. `seedMemoKey` site 4) must be a hard
  stage-A test — partial audit silently drops Bob's user-scoped defaults.
- **[L4b]** The shared `X/space` redirect now rides a per-user run's tx; its
  durability is hostage to that run's commit (cross-user coupling). One sentence.

**note:**
- **[L1]** min(D) is safe for value/attribution (attribution derives from output
  scope, verified); keep the "no annotation depends on min(D)" pin.
- **[L4a]** risk 4 is under-attribution/fail-closed, never escalation — the ratchet
  only narrows, so early-emit yields LESS actor, not more.
- **[L4c/d]** transient-demander and home per-user writes are safe as designed.

### Re-verified vs faith

**Re-verified against code at 6d18d6998 (opened the lines):** F1, F2, F4 (count =
16 exact), F5, F6, F7, F8, F9, F10, F11, F12, F14, F16, F18; F19 (grep: no
`invalidateActionsForDemandRoots`/`knownScope`/`demandersFor`/probe/`dirtyInstanceKeys`
— all genuinely new); the S4 building block (`replaceSchedulerBasisRows`); the
seed-memo service-identity hazard; map/filter/flatMap chain FIXED + wish sidecars
NOT; exhausted-wave W-hold; deadline mid-await race; the ragged redirect mechanism
(both narrowing-write paths traced line-by-line).

**Taken on faith:** F3's exhaustive grep claim; F13's full fan-out gate in
`runSchedulerAction` (read the sink install, not the gate); F17's
`overlay-destination` sweep internals (read the spec, not the code); F20's sqlite
dump and the OW32 store contents; the 4,427-wave storm number; the two-browser
gate stall reproductions. None of the faith items, if wrong, would upgrade a
finding to BLOCKER — they are corroborating evidence for mechanisms I verified
independently.

### Verdict

**BUILDABLE-WITH-AMENDMENTS.** Amendments 1–4 above. No section needs redesign:
§B's `k(node)` needs a ragged-tolerant representation (or an unreachability proof)
and an S4/GC extension; §D must promote B7 under concurrency; §G must fold the
wish-sidecar chain into B and the arrival gate into A; the rest stands. Value-
correctness is preserved throughout given stage A precedes stage B (the design's
hard order), which I confirm is the right and load-bearing sequencing.

### Recommendation on the six §I owner rulings

1. **Mechanism sentence — AGREE, with an amendment.** "Demand at a broad address
   is demand for that principal's instance of every node that narrows beneath it"
   is right, but "every node" must tolerate a node narrowing to DIFFERENT depths
   for different principals (ragged below the top hop). State that k is a
   forced-finest policy, not a structural fact.
2. **Attribution rule — AGREE (output-scope-derived) over keeping P2-F's full
   pair,** but add the risk-4 guard: an event emitted before the ratchet settles
   must be deferred or refused, never silently sessionless (the failure is
   fail-closed, so this is correctness-of-liveness, not security).
3. **Redirect attribution — AGREE (amend the protocol §1 sentence).** It is
   recorded-not-read and not client-visible; also note the per-user-tx durability
   coupling.
4. **Undemanded eager narrowing — AGREE (accept-and-count).** The
   `user:<serviceDID>` instance is inert (no client applicable set includes it);
   revisit only if the counter climbs.
5. **Event actor as transient demander — AGREE (include).** It materializes the
   actor's own entitled instance; no reverse-FP2 leak.
6. **§E residual 1 arrival gate — DISAGREE with "decide after stage B."** Land it
   EARLY (cheap, client-only, OFF-neutral, already measured). It closes the boot
   transient the fan-out does not, and is independent of A/B.
