---
status: historical
created: 2026-08-16
archived: 2026-08-18
reason: "Fan-out evidence: the design scout's fan-out run-supply design + implementation plan (P7 head 6d18d6998) that fan-out stages A/B built; §I's owner rulings were ruled 2026-08-16."
---

# Fan-out run supply — design + implementation plan

Design scout output (read-only; no code, no pushes). Tree: P7 head
`6d18d6998` (`origin/claude/server-exec-v2-phase-7`, the full 17-branch
stack), checked out read-only at `/Users/berni/labs-worktrees/fanout-design`.
Every `file:line` below resolves against that tree. Specs are
`docs/specs/server-side-execution/*.md` at the same head.

Owner ruling this answers (2026-08-16, verbatim): *"let's fix the root
cause here, which is that if a space scoped calculation gets narrowed to
user, it'll have to run for all users that demand it. then after that
let's revisit this question if necessary. but as of now we haven't
actually accomplished our goal of running all reactive computation
server-side! this is deeper, so needs careful planning."*

Thesis in one line: **the demand registry throws away WHO demands a
space-scoped root, so the run supply cannot fan a narrowed node out to
its demanders; and even if it could, the serving replica cannot HOLD two
instances of one doc, so the fanned runs would read each other's data.
Fix the second first (OW17), then the first (the supply), then revisit
the client.**

Sections: §0 verified facts · §1 the gap, drawn · §A demand semantics ·
§B instance-set computation · §C the read seam (OW17) · §D wave /
watermark / storm · §E client half · §F identity fidelity · §G stages,
tests, spec edits, pins · §H what NOT to do · §I owner rulings needed ·
§J risks · §K cite index.

---

## 0. Verified facts (each checked against the P7 head)

| # | Fact | Where | How verified |
|---|---|---|---|
| F1 | The run supply resolves an action's instances ONLY from identity-bearing demand entries; a space-scoped demand contributes nothing. | `packages/runner/src/executor/space-server.ts:1124-1156` (`#runInstancesFor`; docstring :1133-1135 "Space-scope demands carry no identity and contribute nothing (the wave-level fallback run)"). Consumer: `scheduler/run.ts:376-405` (`[undefined]` fallback at :402-405). | read |
| F2 | The registry drops identity for space roots at BOTH ends: the memory server dedupes space roots to one identity-less entry; the SpaceServer keys them `space\0id`. | `packages/memory/v2/server.ts:4050-4056` (`if (scope === "space") { key = space\0id; roots.set(key, {id}) }`); `space-server.ts:2062-2081` (`keyOf`: `scope === "space" \|\| root.identity === undefined → space\0id`), :2118-2130 (identity recorded only when `root.identity !== undefined`). The session's `principal`/`id` ARE in hand at `server.ts:4041-4063` — the drop is a choice, not a missing input. | read |
| F3 | The runner NEVER issues an explicit-instance read: no `entityScopeKey` anywhere under `packages/runner/src/` except basis-row plumbing (`space-server.ts:227`, `wave.ts:2162-2185`, `engine-wave-sink.ts:284`). Watch roots are `{id, scope, selector}` (`storage/v2.ts:3520-3530`). | grep | grep |
| F4 | The serving replica keys every local doc by scope NAME: `docKey = ${normalizeCellScope(scope)}\0${id}` (`storage/v2.ts:2106-2107`), 16 call sites in `SpaceReplica` (`:1861, :2363, :2567, :2579, :4424, :4628, :4678, :4722, :4750, :4976, :5034, :5132, :5310, :5365, :5375, :5399`); one bound identity per replica (`:2112`, `:2300`). The tx→replica boundary passes no identity (`storage/v2-transaction.ts:2549`, `:2571` `replica.getDocument(address.id, address.scope)`); the tx's own doc cache is name-keyed too (`v2-transaction.ts:173-174`). Seals apply pending by name (`v2.ts:3154-3193` → `sealOperations` → `applyPending(operation, localSeq)` at :3257-3259; the wave calls `replica.sealNative(native, source, promise)` with no identity, `wave.ts:1024-1035`). | read |
| F5 | The wire cannot carry two instances of one (id, scope): `SessionSyncUpsert`/`Remove` have `scope?: CellScope` and no key (`packages/memory/v2.ts:1017-1031`); frames strip keys back to names (`toWireUpsert`, `server-sync.ts:104`; used at `server.ts:3359, :3816`); `WatchView` keys by (branch, id, scope) (`memory/v2/client.ts:1414`, `:1490-1518` `watchKey(branch,id,scope)`); admission REFUSES a read set naming two instances of one (id, scope) — "the wire collapse guard" (`server.ts:4198-4241`, message :4235-4238). | read |
| F6 | The lease-holder push exemption exists (`server.ts:3722-3752`, `#currentLeaseHolderExemption` :4286-4313) but only arms after an explicit-instance read admission (`session.leaseHolderReads = true`, :4271) — which by F3 never happens. So the loopback session receives ONLY the service identity's applicable set. The memory server itself names the residual: "a serving session's HOME reads … keep today's tolerated collapsed-view behavior (the OW17 residual)" (`server.ts:4340-4342`). | read |
| F7 | Consequently a per-user run today (a) writes the RIGHT engine row (the wave resolves each op's scope against the run identity, `wave.ts:1655-1668` `#scopeKeyFor`; annotations :1860-1878) but (b) READS the service instance's collapsed local doc for every scoped input and (c) diffs its patch against that collapsed doc. This is the R7 wall (triage §7: served save handler as Alice reads the service `nameDraft` → writes nothing) and the OW29 storm substrate (register OW17 Phase-7 evidence, `verification-coverage.md:978-997`). | read + triage |
| F8 | The scheduler resolves every dependency key against the RUNTIME's identity, not the run's: `entityKey(address, identity)` (`scheduler/keys.ts:26-33`) is fed `() => this.runtime.scopeKeyIdentity` at every seat (`facade.ts:271, :349, :1684, :1689, :1708, :1937, :2126, :2298`; `scheduling-writes.ts:81-84`; `dependency-graph.ts:324-339`). At the collapse this is invisible; once instances are distinct it is a live bug (Bob's input change would not wake the node). | read |
| F9 | Under N instance runs the node's subscription is REPLACED per run — last run wins: `run.ts:687-692` `resubscribe(action, committedLog)` inside `finalizeReactiveActionCommit` (per `runOnce`), and `dependency-updates.ts:33` `state.dependencies.set(action, schedulingLog)`. Same invisibility/live-bug shape as F8. | read |
| F10 | `actionScopeKey` and `acting` are STAMPED AT RUN START from the demand key's own instance (`run.ts:434-443`; `space-server.ts:1022-1080` — `acting` derived at :1023-1031 from `scopeKeyIdentity.principal` + `sessionId`; `capabilityRef` :1069-1076). Basis rows use the stamped key (`wave.ts:1889-1892`, `:2155-2191` at :2157). Nothing re-derives from the DISCOVERED scope; the S4 narrowing-delete is a building block only (`memory/v2/scheduler-basis.ts:60-95`), never invoked for narrowing. Effect: a user-scoped watch stamps `user:alice` on a node that discovered `space` (over-keyed rows), and a user-instance run is attributed to an ARBITRARY session (the first-seen one — `server.ts:4058-4082` dedupes per resolved instance keeping the first session; `#runInstancesFor` :1147-1148 keeps the first identity). events.md rules otherwise: "a user-instance run's carries the user with `session = "server"`" (`events.md:96-102`). | read |
| F11 | Discovered scope IS available per run: the tx ratchet `narrowestReadScope` (`storage/extended-storage-transaction.ts:303`, get/reset :945-951, ratchet on every read :974-979); reset before inputs (`runner.ts:6329`), read after (`runner.ts:6439`); the runner folds declared schema scope into `effectiveOutputScope` (`runner.ts:5799-5812`, keyed per run identity at :5809-5812 — site 3 already per-run). | read |
| F12 | The narrowing write is per run: `pattern-binding.ts:274-330` (redirect at the broad slot + value at `{...ref, scope: outputScope}`; eager via-user hop :302-330 flag-gated), `data-updating.ts:690-785` (declared-scope redirects; the value is "diffed against the narrower instance's own current value" :759-773 — the diff-base read F7(c) is here). | read |
| F13 | The demand walk runs as the SERVICE: `#loadDemandedStructure` installs `cell.sink(demandRead)` on the serving runtime's own cell (`space-server.ts:2229-2253`; walk = `JSON.stringify(value)` :2245-2252). A sink action receives the scheduler's tx (`cell.ts:3486-3515`, `sinkHelper` :3530-3567 → `resubscribe(..., {isEffect:true})`), and `runSchedulerAction` fans an action out only if it carries `schedulerObservationIdentity.demandRootIds/pieceRootId` (`run.ts:393-401`) — the demand sink carries none, so it walks once, as the service. TODAY that walk follows redirects into the SERVICE's per-user subtree (the collapsed local doc holds the fallback run's value — which is why the 15 group-chat lifts do run server-side, under `user:<serviceDID>`, triage step 1). Once instances are keyed (stage A) and the service never runs demanded pieces (stage B), the service walk finds nothing behind a redirect and stops — per-user subtrees are then demanded by nobody unless the walk runs per demander (§B4). | read |
| F14 | Reader→writer (pull/liveness) edges match on the DECLARED write surface with exact (space,id,scope-NAME) equality (`scheduling-writes.ts:156-190` `readsOverlapWrites`; index keyed by `entityKey` :81-84). A narrowed node's readers form the edge through the BROAD-slot redirect read, so pull edges are instance-independent — good: instance re-keying does not break demand propagation. | read |
| F15 | The loop is woken on demand change (`space-server.ts:803-807` `noteDemandChanged`, edge-triggered) and the T_flush deadline fires MID-await of `runtime.idle()` (`space-server.ts:2394-2440`), so a long instance loop is cut by the deadline without a new yield point (sealed instances commit; the in-flight tx opens the next wave — natural double-buffering, `space-server.ts:258-264`). | read |
| F16 | Own-commit-source skip is BY ACTION (`invalidation.ts:160-162` `notification.source.sourceAction === action`) — all instance runs of one node are the same action, so a run's own seal never re-dirties its own node; a retirement `integrate` has no source and DOES (triage step 4). | read |
| F17 | Client retirement is coverage-of-basis: `overlay-destination.ts:853-928` (`#sweep`; floor :880-885; retire when `watermark >= floor` :902-910). Frames apply atomically per session per flush (protocol §3 landed note, `protocol.md:576-587`) and the watermark doc rides the same derived commit as the wave's values (`protocol.md:598-608`). | read |
| F18 | LT6's send site reads `context.acting` mid-run (`cell.ts:1697-1708`); the foreign-write accept gate reads it at seal (`wave.ts:984-1022`); `#delegatedFor` at :2078-2090; `runtime.homeSpacePrincipalFor(tx)` reads `scopeKeyIdentity.principal ?? acting.user` (`runtime.ts:2593-2601`), throwing on none (:2602-2617). | read |
| F19 | The OW29 extensions are NOT on any ref (`git log --all` has no space-root-demander/demand-arrival commit; only the build report and register describe them: `p7-build-report.md:77-90`, `verification-coverage.md:978-1012, 2329-2357`). | git |
| F20 | The OW32 loop is client-side and is the consequence of F1: the store holds the per-user instances under `user:<serviceDID>` and NO user principal (triage §Mechanism step 1, sqlite dump R2); the arrival-gate prototype removes the loop but exposes R7 (F7) (`nonsettle-triage.md:13-37, 95-160, 258-281`). | triage |

Every mechanism claim below cites one of these.

---

## 1. The gap, drawn

```
client (Alice, session s1)            memory server               SpaceServer / scheduler
─────────────────────────             ────────────────            ───────────────────────
watch piece ROOT @space  ──────────►  watchedRootsForSpace        #loadDemandedStructure
                                        space root: {id}  ─────►    key = "space\0id"
                                        (identity DROPPED,          #demandedIdentities: ∅   ← GAP 1 (F1/F2)
                                         server.ts:4050-4056)       demand sink runs AS SERVICE (F13)
watch computed:X @user   ──────────►    scoped root: {id, identity}   key = "user:alice\0computed:X"
   (after following the redirect)         (server.ts:4058-4082)      → identity recorded, but computed:
                                                                        is neverAPieceRootId → never maps
                                                                        to an action's demand roots (F1)
                                                                    #runInstancesFor(piece roots) → []
                                                                    run.ts:402-405 → ONE run, service identity
                                                                    → engine rows: space (redirect) +
                                                                      user:<serviceDID> (F20)
Alice's speculation ⟶ W covers basis ⟶ retire ⟶ store has nothing ⟶ flip ⟶ re-run … (OW32)

AND, if the supply DID fan out (OW29 as built):
  run(alice), run(bob) both read/write local doc "user\0X" (F4)  ← GAP 2 (OW17)
  wire cannot even carry both instances (F5) · scheduler keys against the service (F8/F9)
  → wrong values + patch-vs-wrong-base rejections + no fixpoint → 4,427 waves (F7)
```

Two gaps, in dependency order: **OW17 (gap 2) is a prerequisite of the
supply fix (gap 1)**, because the moment gap 1 is closed at cardinality
≥ 2 the fanned runs meet the collapsed replica — that is exactly what
happened to OW29. OW29's DIRECTION (space-root demanders + arrival
re-runs) is right; its failure was sequencing (§D names the cycle).

---

## A. Demand semantics — how identity-bearing demand on a space-scoped root reaches the run supply

### The rule the spec already implies

scopes.md §2 (:133-141) says siblings "materialize on THEIR OWN demand,
like any other undemanded derivation (… a subscription or an event is
the demand)"; §2 (:153-160) says the SpaceServer "computes EVERYONE'S —
demand-paced"; protocol §4 says W covers DEMANDED derivations. What no
sentence says is *whose* demand a space-scoped subscription is once the
node beneath it narrows. The mechanism sentence this design adds:

> **A principal's demand expressed at a broad (space-scoped) address is
> demand for THAT principal's instance of every node that narrows
> beneath it.** The demand registry therefore records the demanding
> (user, session) on space-scoped roots too; a node's instance set is
> derived from its DISCOVERED scope × its demand roots' demanders.

### Options weighed (not pre-picked; recommendation follows)

| Option | Mechanism | Cost / failure mode |
|---|---|---|
| **(i) identity on space-root demand rows** | `watchedRootsForSpace` returns `{id, identity}` per (identity, root) for space roots as well (the pair is in hand, F2); the SpaceServer keeps ONE demand key per root for structure loading/sinks (`space\0id`) plus a demander set per root; the resolver returns the demanders; the scheduler derives instances = f(node's known scope, demanders). | + Uses the one watch every client holds (the piece root); no dependence on the client speculating or following redirects; instance sets are clean products over principals (monotonicity, scopes §2 :162-171). − A CLEAN node never re-runs for a demander who arrives after it ran → needs an arrival re-arm (below). − Coarse: every node reachable from the root is a candidate for every demander (bounded by the known-scope pruning in §B — space nodes run once). |
| **(ii) narrowing-discovery-time fan-out** | When a run discovers narrowing, the node re-arms for the root's demanders in the same wave. | Not an alternative to (i) but its in-wave completion: (i) supplies WHO, (ii) supplies WHEN the siblings materialize (the same wave that discovered — scopes §2 :150-152 already says the redirect write dirties broad-slot readers in the same wave). Alone it has no demander set to fan to. |
| **(iii) lazy arrival via the redirect** | A principal's first read of the redirect (its client following `computed:X/space` → `computed:X/user`) registers a scoped watch on `computed:X` (this ALREADY happens — F2 second row, triage step 1); map that doc to its writer via the write index and treat it as demand for that instance. | + Precise per doc; the signal exists in `#demandedIdentities` today. − Depends on the client seeing the redirect FIRST (one extra round trip per narrowing hop; a non-speculating client only follows server-written redirects); the first, discovering run is then a service run that writes a service instance nobody wants (the "garbage instance" — §B); needs a writer-of-doc lookup the resolver does not have (`computed:` is `neverAPieceRootId`, `space-server.ts:248-256`); nodes whose OUTPUT the client never reads directly but whose per-user VALUE feeds a rendered subtree are still reached only through the walk (§B demand walk). |

**Recommendation: (i) + (ii), with the arrival re-arm; (iii) is not
required.** Rationale: (i) is the only option whose input is present for
every client posture; (ii) is what makes "the SpaceServer computes
everyone's" true within the discovering wave; the arrival re-arm covers
late demanders. (iii) can be added later as a precision refinement if a
posture without a root watch appears (a `cf` CLI reading one `computed:`
doc) — flagged, not built.

### Cardinality over time (each option, and the recommended one)

- **New principal after narrowing.** (i)+(ii): the registry gains the
  pair on her first watch → `noteDemandChanged` (F15) → the next cycle's
  `#loadDemandedStructure` sees a NEW pair for the root → **arrival
  re-arm**: `Scheduler.invalidateActionsForDemandRoots(rootIds)` marks
  every action whose `demandRootIds` intersect and whose known scope is
  narrower than `space` invalid + queued (space nodes need nothing: their
  one output is shared). Her instances materialize in that wave; W was
  not held back before (protocol §4 :612-615 "a fresh subscription
  arriving after W may still trigger a recompute, whose results land in a
  later derived commit"). (iii) alone: materializes only after her client
  follows each redirect — one hop per level, later.
- **Principal leaves.** The pair retires with its watches (`space-server.ts:2083-2094` prune loop) → the instance set shrinks on the node's next run; stored rows stay (durable; retirement is scopes §8 item 2's GC design, unchanged).
- **A second session of an existing user.** User-scoped nodes: no new instance (dedupe by principal); session-scoped nodes: one more instance; the demand walk (§B) runs once more per wave for that session.
- **Discovery deepens (user → session).** (ii) again, one level down; bounded by the lattice depth (≤ 2 re-arms per node per activation).

---

## B. Instance-set computation — exact

### B1. Inputs

- `D(node)` = the set of demanding identities of the node's demand roots (`schedulerObservationIdentity.demandRootIds`, `scheduler/types.ts:35-47`; resolved by the SpaceServer as today plus space-root pairs — §A). Each element is a FULL pair `{principal, sessionId}` (deduped by pair; sorted by (principal, sessionId) for determinism). Argument-doc demanders fold in via `#pieceRootByDemandKey` (`space-server.ts:370-376`, set at :2163-2169/:2184-2188) unchanged.
- `k(node)` = the node's **known scope**: a per-node ratchet in the scheduler's node record (`node-record.ts` `SchedulerNode`), `"space"` initially and after (re)registration, only ever narrowing (scopes §2 Permanence :173-186), set from the run's effective output scope after every run (F11: the tx ratchet, plus §F's two additional ratchet sources). Forgotten on park/activation → re-learned by the probe run (one extra run per narrowed node per activation; an optional seed from `selectStaleBasisInstances`' `action_scope_key`s is a later optimization).

### B2. The function

```
instances(k, D):
  k = space   → ONE run.  identity = min(D) if D ≠ ∅ (the "probe" demander,
                deterministic), else NONE (wave-level fallback = the
                service identity, as today).  actionScopeKey = "space".
  k = user    → one run per distinct principal p in D;
                identity = {p, sessionId: min session of p in D}   (the
                REPRESENTATIVE session — used for RESOLUTION only, §F);
                actionScopeKey = user:p.
  k = session → one run per distinct pair in D; actionScopeKey = session:p:s.
  D = ∅ and k ≠ space → no demanded instances → NO run (undemanded work;
                pull-based laziness) — except eager/idle-scheduled actions,
                which keep the wave-level fallback (residual, §B5).
```

The resolver seam changes shape: today `runInstanceResolver(pieceRootIds)
→ {scopeKeyIdentity, actionScopeKey}[]` (`runtime.ts:1945-1947`,
`:2002-2006`) decides the instance FROM THE DEMAND's scope; the design
returns DEMANDERS (`demandersFor(rootIds): ScopeKeyIdentity[]`) and lets
the scheduler derive instances from `k` — the scheduler owns `k`. This
also fixes F10's over-keying (a session watch no longer stamps
`session:alice:s1` on a user-scoped node).

### B3. Discovery re-arm (option (ii), the mechanism)

After each instance run, at finalize (`run.ts:594-694` — where the log is
in hand), read `d = tx`'s output-scope ratchet (F11 + §F). If `d` is
narrower than `k(node)`:

1. `k(node) := d` (ratchet).
2. The run that discovered already WROTE ITS OWN INSTANCE at `d` — its
   identity is a full pair, so `resolveScopeKey(d, identity)` resolves
   (`memory/v2.ts:144-171`) and the write path already addressed the
   value at `{...ref, scope: d}` (F12) — this IS scopes §2's "the
   discovering run writes the redirect AND its own instance", and under
   the probe rule that instance is a DEMANDED one, not the service's.
3. The seal re-derives `actionScopeKey := resolveScopeKey(d, identity)`
   for the basis rows (today stamped at start, F10) and issues the S4
   narrowing-delete for the stranded broader key by adding an EMPTY
   replacement for `(action, oldKey)` to `basisInstances` (`wave.ts:1889-1892`; the engine writer already replaces per instance, `scheduler-basis.ts:68-95`) — serving-loop §3b :451-459 becomes true.
4. If `|instances(d, D)| > 1` (siblings exist): `markInvalid(node)` +
   `pending.add` + `queueExecution()` — the SAME wave runs the remaining
   instances (idle() awaits them → W waits on them, §D). The re-run's set
   includes the discovering instance again; its re-run is a no-op by
   equality cutoff (same inputs, same output, `diffAndUpdate` writes
   nothing). Optional refinement: skip instances already run at scope `d`
   in this pass.

Bounded: `k` moves at most twice (space→user→session) per node per
activation.

### B4. The demand walk must be per demander (or per-user subtrees are never demanded)

F13: the walk runs once as the service. Today it descends into the
service's per-user subtree because the collapsed local doc holds the
fallback run's value; after A (per-instance local docs) and B (the
service never runs demanded pieces) there is nothing behind a redirect
for the service walk to read, so it stops there. Everything reachable
only THROUGH a per-user value (a per-user `ifElse` branch's computeds, a
per-user child piece link) would then be live for nobody server-side —
the exact residual §E asks about, and it would keep OW32 alive for those
nodes. This is a consequence of the design, not a pre-existing bug, and
it is why the walk changes WITH the supply, in stage B.

Mechanism (C11b-clean — one node, N runs): the demand sink action carries
`schedulerObservationIdentity = { demandRootIds: [root.id] }` (or the
SpaceServer registers its own effect action per demanded root through
`scheduler.subscribe(action, log, {isEffect:true})` and runs it via
`scheduler.run(action)` so its FIRST run already goes through
`runSchedulerAction`, F13). The existing run supply then runs the walk
once per demanding pair, each run's tx stamped with that pair, so (after
§C) the walk resolves that demander's redirects and pulls that
demander's subtree. Instances for the walk: per SESSION pair (finest —
it must follow session redirects; it writes nothing, so its
`actionScopeKey` is irrelevant). Cost: N × walk per wave for changed
roots — the same work each client tab does today.

### B5. The service identity's role — decided

- **For demanded work: never an instance.** Every run of an action whose
  roots have ≥ 1 identity-bearing demander runs as a demander (probe or
  instance). The silent-empty-instance trap for demanded pieces closes.
- **Wave-level fallback survives ONLY for:** bookkeeping (`kind:
  "bookkeeping"`), effect completions (`space-server.ts:1158-1180`),
  and eager/idle-scheduled actions of pieces NOBODY demands with an
  identity. If such an eager run narrows, it writes `user:<serviceDID>`
  (the residual garbage instance, bounded: one per such node). Counted
  (a new `servingLoop.undemandedNarrowingRuns` counter — §G) and
  flagged: OWNER-RULING-lite (§I item 4): accept-and-count (recommended
  for this train) vs refuse (error like the sessionless rule, scopes §5
  :256-262) vs defer-until-demanded.
- **Handler runs are unchanged** (`firedAt`, LD1). One edge, flagged:
  preflight recomputes a dirty computed input before the handler runs
  (serving-loop §3 :207-214); with per-demander instances, an actor who
  fires an event WITHOUT watching the piece has no instance recomputed
  for her → the handler reads a stale/missing `user:<actor>` instance.
  Recommended: the dispatching wave treats the event's `firedAt` pair as
  a transient demander of the event's target piece for that wave (the
  SpaceServer knows the current event's actor at `#stampRun`; the
  resolver consults a "current event actor" slot). Alternative: accept
  (actors normally watch). OWNER-RULING-lite (§I item 5).

### B6. Attribution of the redirect (spec-consistency)

protocol §1 :108-115 says the broad-slot redirect is "the SpaceServer's
OWN write … NO acting principal". Under this design the redirect is
written inside a DEMANDER's run tx (F12), so its write annotation carries
that run's acting pair (`wave.ts:1860-1878`). Attribution is "recorded,
not read" (protocol §1 :249-255). Recommend amending the sentence (the
redirect written by a discovering run carries that run's attribution;
nothing decides from it) over stripping it per-op at seal. OWNER-RULING-
lite (§I item 3).

---

## C. The read seam (OW17) — verdict, scope, sequencing

### Verdict: per-user runs CANNOT be correct without it, for the class that matters.

A node narrows because it READ scoped state (scopes §2 :89-94). To compute
Alice's instance the run must read Alice's instance of that state; the
serving replica holds only the service's (F4/F6), the wire cannot deliver
two (F5), and the scheduler would not wake the node on Bob's change even
if it did (F8/F9). Every narrowing derivation and every served handler
that reads per-user state is in this class (R7, F7).

Paths that "work" without it, honestly: (a) blind per-user WRITES (a
handler that writes user state without reading it) already land in the
right row (F7a); (b) a DECLARED-scope (schema) user output over pure
space inputs (`data-updating.ts:701-707`) computes the right value per
instance — but its patch is still diffed against the collapsed local doc
(F7c → the "missing path" rejections OW29 hit), so it needs the whole-doc
hack to land. Neither is a testable foundation for the fan-out. **OW17 is
a hard prerequisite of stage B; it is also independently valuable (R7,
the served handler) — which is why it is stage A.**

### Scope, precisely (the class verdict's four items, sharpened by F3-F9)

Pattern: stage F/M2's `entityKey` re-key — instance keys built from an
explicitly supplied identity, partition unchanged at cardinality 1
(key-vocabulary §2) — applied to the last name-keyed layer. The unifying
device: **an optional explicit instance on the address type** —
`IMemorySpaceAddress.scopeKey?: ScopeKey` (or an equivalent per-change
identity), set by every constructor that KNOWS the instance (the tx from
its run context; the differential from the record it snapshots; the wire
from the entry) and preferred by every consumer (`entityKey`, `docKey`,
`WatchView`). Derived from a resolved identity at construction, so
key-vocabulary §4's tripwires hold; §5's boundary list is updated in the
same change (its first tripwire requires it).

A1 — **Wire (memory)**: `SessionSyncUpsert`/`SessionSyncRemove` gain
`scopeKey?: ScopeKey`, populated ONLY for sessions with
`leaseHolderReads === true` (the loopback session that named an
instance; every other session's frames stay byte-identical — the OFF
arm never sees the field); `toWireUpsert` keeps the key for those
sessions; the collapse guard (`server.ts:4198-4241`) is skipped for
them and kept for everyone else; `WatchView` (`client.ts:1490-1518`)
keys by `scopeKey ?? name`; `#deliveredFrameEntries` rollback already
holds true entries (`server.ts:3819-3825`). Runner side: watch roots
carry `entityScopeKey` when the read's identity ≠ the manager's own
(`storage/v2.ts:3520-3530`; the fast path for own-identity reads is
untouched — F3's admission scan short-circuits on no key,
`server.ts:4198-4200`); the foreign-scoped refusal (`storage/v2.ts:3505-3517`)
stays.

A2 — **Replica**: `docKey(id, scopeKey)` at the 16 sites (F4) with
`scopeKey = canResolveScopeKey(scope, identity ?? own) ? resolveScopeKey(...) : name`
(the fallback keeps an anonymous session's user-scoped read keyed as
today — a danger pin, §G); `getDocument(id, scope, identity?)`,
`sealNative(native, source, verdict, {identity})` → `applyPending` per
instance; `applySessionSync` (`:4628`, `:4678`) keys by the upsert's
`scopeKey ?? own`; sinks/notifications carry the instance (site 8
`storage/transaction/address.ts:17-20` per-change identity;
`Differential.checkout/compare` :3249-3268); pending loads issue
instance-named queries for non-own identities (site 7 already keys per
identity, `storage/v2.ts:1396`; the load must NAME the instance on the
wire); `SelectorTracker.toKey` (`selector-tracker.ts:87-94`) takes the
address's instance when present.

A3 — **tx → replica**: `v2-transaction.ts:2549`, `:2571` pass
`waveRunContextOf(tx)?.scopeKeyIdentity ?? own` (the tx's own doc cache
stays name-keyed — one identity per tx, assert it); commit ops carry the
resolved key into `sealNative`; reactivity-log entries carry `scopeKey`.
Plus the **nine-site identity audit** (key-vocabulary §1): every site
that today keys from `runtime.scopeKeyIdentity` while a run context is
in hand must take the RUN's identity — verified drift: site 4
`seedMemoKey(seedTarget, runtime.scopeKeyIdentity)`
(`data-updating.ts:850`, `:860`; the eager scoped-property seed at
:837-870 — post-A this makes Alice's seed suppress Bob's, "one USER's
presence must not suppress another's" broken), site 2's `getDocKey`
(`runner.ts:3874-3879`), the wake-shaper pieceId buckets
(`runner.ts:3956`, `:6182`). Site 3 (`runner.ts:5809-5812`) and site 8
already thread the run context; sites 5/6 (`traverse.ts:1742` via
`TraversalContext.scopeKeyIdentity`) need the traversal context built
from the tx's run identity on the serving path.

A4 — **Scheduler**: `entityKey` prefers `address.scopeKey` (F8 fixed for
reads/notifications — the trigger index and dependency log key per
instance); the N-run loop UNIONS the instance runs' logs and resubscribes
once (F9) — collect in `runSchedulerAction`'s loop (`run.ts:485-491`),
resubscribe after the last instance (retry paths in
`watchReactiveActionCommit` keep per-run behavior). **The writer index
becomes instance-AGNOSTIC** (`writersByEntity`, `scheduling-writes.ts:81-84`,
keyed by `${space}/${scope NAME}/${id}`, and `forEachOverlappingWriter`
looks reads up by name): the reader→writer (liveness/topology) relation
is a NODE-level relation — under C11b one node writes ALL instances of
its declared surface — so an instance-keyed lookup would DROP the edge
between a user-scoped-declared writer and a reader running as Alice the
moment reads carry instances (today both sides collapse to
`user:<runtime>` and match by accident). Broad-slot pull edges (F14) are
unaffected either way. This is a deliberate fan-in on ONE structure,
recorded in key-vocabulary §1 (site 1 splits: dependency/trigger keys per
instance, writer index per name); instance-precise DIRTINESS is §D's
optimization, not a correctness need. Pin: a user-declared writer + an
Alice-run reader keep their dependent edge (mutation: instance-keyed
writer index → edge lost).

A5 — **Wave**: `actionScopeKey`/S4 from the discovered scope (§B3 item 3)
and the seal passes the run identity to the replica (A2). Basis rows stop
lying (`entity_scope_key` today claims the run identity's instance while
the value came from the service's, `wave.ts:2162-2185`).

A6 — **OFF-arm neutrality**: identity == own at every seat → the re-keyed
strings partition exactly as before (key-vocabulary §2's argument,
restated per site in the PR). Byte-identity pins (§G).

Size: P2-F-to-stage-F shaped, mechanical but cross-cutting (memory wire
+ client + runner replica + tx + scheduler + wave); two PRs (A-wire+
replica; A-tx+scheduler+wave) is the natural cut, or one if the build
agent keeps the neutrality pins green throughout.

---

## D. Wave / watermark semantics, budget, and the storm

### The W rule (exact)

W(space) advances past input seq n only when every DEMANDED instance of
every DEMANDED node is current through n (protocol §4 :593-597). Under
fan-out "demanded instances" = `instances(k, D)` of §B2 for every live
node — including the siblings a discovery re-armed in the same wave
(§B3.4 marks them pending; `idle()` awaits pending work, serving-loop §3
:215-222). Instances that were NOT demanded when W advanced (a later
arrival) are ordinary later demand (protocol §4 :612-615). One integer,
no per-instance watermark (scopes §9).

### Budget

N users × M narrowed nodes = N·M instance runs per full recompute; each
`runOnce` counts as a run for the pass budget (`markActionHasRun` per
instance, `run.ts:526`) → MAX_ITERS/PASS_RUN_BUDGET bound the wave;
exhaustion commits and holds W (serving-loop §3 :229-243) — the priced
"exactly what is demanded". The T_flush deadline already cuts MID-loop
(F15), so no new yield point. Cost model to state honestly: with the
singular node and instance-imprecise dirtiness, ONE user's input change
re-runs ALL N instances of every downstream narrowed node (siblings are
absorbed by equality cutoffs but still execute) — O(N) per keystroke,
O(N²) for N concurrent typers. **Optional B7 — instance-precise
dirtiness**: with instance-keyed causes (A4), record `dirtyInstanceKeys(node)` from `addInvalidCause` and run only instances whose key is dirty (a
`space` cause, a demand/discovery/arrival re-arm, or a never-ran node ⇒
all). Trigger: the honest benchmark or the two-user gate's
`wavesBudgetExhausted` share; correctness never depends on it.

### The OW29 storm — the cycle, named, and the cut

Name: **the collapsed-local-doc ping-pong.** With (4)+(5) applied on the
collapsed replica, N instance runs of a node — and of every OTHER node
that seeds or writes the same scoped doc (eager scoped-property seeding,
`data-updating.ts:837-870`, whose write lands at the run identity's
address but whose local doc is the collapsed one) — write ONE local doc
`user\0X` (F4). Each seal changes that shared doc under a
different identity's value; every other reader NODE of that doc is
invalidated (own-source skip protects only the writer, F16); those
readers' instance runs write it back; there is no fixpoint. Layered on
it: each instance's patch is diffed against the SIBLING's collapsed
value (F7c) so the engine rejects the wave ("missing path …"), the whole
wave withdraws (rollback notifications re-dirty everything), and the next
cycle repeats at the deadline cadence — 4,427 waves / 5 min ≈ one per
68 ms ≈ the exhausted-wave cadence. Not a demand bug: a KEYING bug fed by
correct demand.

Cut: A2/A3 (per-instance local docs — a run's write invalidates only
readers of THAT instance; a run's diff base is ITS instance, so patches
apply) + §B3's bounded re-arm. Pin: at cardinality 2 with divergent
per-user inputs, waves after quiescence ≤ small constant and zero
`wave-commit-rejected … missing path` (§G B-tests g). Second-order loop
to watch: two nodes that legitimately write each other's per-user inputs
— unchanged from OFF (a real cycle is a real cycle).

---

## E. The client half

### Why the ruled rule now works

Coverage-of-basis (speculation §4 :101-113, F17): the entry retires when
`W ≥ floor` where floor ≥ the seq of the authored input it consumed. W
advances past that seq only in a wave in which Alice's instance is
demanded and current (§D) — and that wave's ONE derived commit carries
BOTH her instance value and the watermark advance (protocol §4 :598-608),
delivered to her in one atomically-applied frame (F17). So the value is
in her replica when the sweep fires: the retirement flips speculated →
authoritative (usually equal → no notification), never → nothing. The
ruled rule holds because its premise ("the demanded derivation exists and
lands") becomes true.

### Residuals — stated, with dispositions

1. **The first-demand transient.** A node whose basis W ALREADY covers
   at speculation time (boot; old inputs) retires immediately while the
   server has not yet run the first demanded wave → flip → re-run until
   the server's value lands (the "31× on `__cfLift_1`" boot form, triage
   :80-84). Bounded by server first-wave latency; ugly (flicker, ~80 ms
   cycles). Not fixed by this design; the shelved arrival-gate would
   close it. Disposition: measure at both two-browser gates after stage
   B (`scheduler-non-settling` count, client action runs in the first
   3 s); if visible, land the arrival gate as the follow-up the owner
   left open ("revisit if necessary").
2. **Persistent client/server divergence.** If Alice's speculated value
   ≠ the server's (nondeterministic derivations — `Date.now`, random —
   or a stale replica), retirement emits `integrate` (no source, F16) →
   the writer (a reader of its own output: redirect slot + diff base,
   triage step 4) re-runs → re-speculates → retires → flips … forever.
   Rider (small, ships with B): treat the `integrate` produced by
   retiring an action's OWN entry as own-commit-source (skip) — the
   triage's "divergence guard". Without it, ON turns every
   nondeterministic per-user derivation into a loop.
3. **Redirect representation.** The client-written and server-written
   redirect links differ in representation (triage §6, `link@1/scope`
   flip); with the server's redirect now landing, that flip is one-shot
   (the client's next `writeRedirect` resolves through the stored
   redirect, `pattern-binding.ts:274-281`). Rider: make the speculative
   redirect write byte-identical to the served one so no flip occurs.
4. **Nodes no principal demands server-side that the client still
   speculates.** With the per-demander walk (§B4) the server's demand
   covers what each demander's root VALUE reaches. Left over: nodes a
   client reaches only through its OWN sinks off the root's value graph
   (a component subscribing to an argument-doc path the root value never
   links) — arg-doc watches DO enter the registry (`#pieceRootByDemandKey`),
   but a per-user computed reachable only from such a doc and not from
   the root value is walked by nobody. Small; the arrival gate is the
   backstop. Flagged, not filled.

---

## F. Identity fidelity — which (user, session) a fanned run carries

Ruled already, and the code drifts from it: a user-instance run's actor is
the user with `session = "server"`, a space-scope run's is neither
(events.md :96-102; protocol §1 :244-247 "a space-scope derivation
before any narrowing — carries none"). Today (F10) a demanded run is
attributed to the demand key's FULL first-seen pair regardless of the
node's scope.

The rule this design fixes: **a run's RESOLUTION identity and its
ATTRIBUTION are two things.**

- **Resolution identity** = the full pair §B2 chose (`scopeKeyIdentity`
  on the run context). A user-instance run carries a REPRESENTATIVE
  session so that a session-scoped read it discovers resolves to a REAL
  demanded instance (`resolveScopeKey("session", {principal})` throws
  otherwise, `memory/v2.ts:158-169`) — the discovering run then writes
  its own SESSION instance and re-arms siblings (§B3). Space probe runs
  carry the probe demander's pair for the same reason.
- **Attribution** (`acting`, write annotations, LT6 event actor,
  `capabilityRef`) = the identity components implied by the run's
  **effective OUTPUT scope**, evaluated at the point of use: space → none;
  user → `{user}` (event `firedAt.session = "server"`); session →
  `{user, session}`. Point of use: the LT6 send site derives from the tx
  ratchet-so-far (`cell.ts:1697-1708` reads `context.acting` today →
  `actingOf(context, tx)`); the seal/foreign gate/`#delegatedFor`
  (`wave.ts:984-1022`, `:1860-1878`, `:2078-2090`) derive from the FINAL
  ratchet; `#stampRun` (`space-server.ts:1022-1080`) stops eagerly
  deriving `acting`/`capabilityRef` for derivation runs (handlers keep
  the explicit `firedAt` acting, `:1052-1053`).
- **The output-scope ratchet has three sources**, all "learned by running"
  (D11-clean, no static analysis): logged reads (F11); the write path's
  declared-scope redirect (`runner.ts:5799` `effectiveOutputScope` — the
  runner ratchets the tx with it before the seal); and IDENTITY
  CONSUMPTION — `runtime.homeSpacePrincipalFor(tx)` (F18) ratchets to
  `user` (reading who you are is a user-scoped read; this is what makes
  the served `#profile` wish — per-demanding-identity by construction,
  builtins §5 — a user-scoped node with a user-attributed provisioning
  carriage). Without the third source, a wish that reads no scoped doc
  but provisions `.inSpace(home)` would carry no acting → refused at the
  foreign gate.
- **Which session for a user-scoped instance value?** None (attribution)
  — the value belongs to all of the user's sessions; the representative
  session was resolution scaffolding. Pin: two sessions of one user →
  one `user:` instance, annotation `actingUser` only.
- Handler runs (`firedAt`, both components server-stamped) unchanged.

Owner-facing choice (§I item 2): the alternative is to KEEP P2-F's rule
(full pair always) and amend events.md/protocol §1 to match — cheaper
(zero code) but attributes space values to a user and user values to an
arbitrary session, and LT6 events from user-instance runs would land
session-scoped consequences in one arbitrary session.

---

## G. Sequencing + PR shape

Three stages; A before B is a HARD order (§C); C is closeout. Sizes are
honest: A ≈ stage-F/P2-F sized (cross-cutting, mechanical), B ≈ P2-F
sized (registry + scheduler + walk + attribution), C small. Expect 4-5
PRs (A in two, B in one or two, C in one).

### Stage A — OW17: instance-keyed serving replica + tx→replica identity seam

Scope: §C A1-A6.

Red-first tests (each red at the P7 head, green after; mutation-checked):

- A-a (memory) two instances of one (id, scope) delivered to a
  `leaseHolderReads` session in ONE frame with distinct `scopeKey`s; the
  collapse guard still refuses a non-holder naming two; a non-holder's
  frames carry NO `scopeKey` (byte-identical wire).
- A-b (replica) `getDocument(id,"user",alice) ≠ getDocument(id,"user",bob)`;
  a seal as Alice leaves Bob's local doc untouched; an anonymous session's
  user-scoped read keys as today (danger pin).
- A-c (serving loop, cardinality 2 via a SCOPED-root demand — P2-F's
  existing supply) two per-user runs read their OWN inputs (divergent)
  and land divergent engine rows with truthful basis rows — the VALUE
  half (register OW17 :933-940) closed.
- A-d (**R7 arbitration**) Alice's authored `user:alice` draft + her save
  event → the served handler writes her profile under `user:alice` with
  the typed value (today: `consequenced:true`, zero writes).
- A-e (scheduler) after two instance runs, Bob's input change wakes the
  node (mutation: last-wins resubscribe → red); node count in
  `getGraphSnapshot()` independent of instance count (C11b pin); a
  user-scoped-DECLARED writer and a reader running as Alice keep their
  dependent edge and topological order (mutation: instance-keyed writer
  index → red).
- A-f OFF byte-identity: existing OFF suites + the sink-level fold test
  updated to assert the un-collapsed shape ON and the old shape OFF.

Spec edits (ride with A): key-vocabulary §5 (SpaceReplica docKey,
WatchView, wire upserts move from "boundary" to re-keyed; the address
instance field named); protocol §3 (+1 sentence: lease-holder frames
carry `scope_key`), protocol §2 read row (the runner now names instances
for non-own reads); verification-coverage OW17 → LANDED (leg 1 of 2).

Danger pins: OFF wire byte-identity; own-identity read fast path
unchanged (no added await, `server.ts:4198-4200`); anonymous-session
keying; amplification budget unchanged (`derivedCommits/authored`).

### Stage B — the fan-out run supply

Scope: §A (registry identity on space roots; demander set per root;
resolver returns demanders), §B (known-scope ratchet; `instances(k,D)`;
probe run; discovery re-arm; arrival re-arm via
`invalidateActionsForDemandRoots` + level wake; the per-demander demand
walk), §F (attribution from output scope; the three ratchet sources;
`capabilityRef` at seal), §D (counter `undemandedNarrowingRuns`; optional
B7 precise dirtiness), §E riders 2-3.

Red-first tests:

- B-a (**arbitration**) two users watching only the SPACE root of a piece
  with a per-user lift → registry holds two demanders; the probe run
  discovers `user`, writes its own instance, re-arms; BOTH instances land
  in ONE wave with correct (divergent) values; W advances only after
  both. Red at stage-A head (one service instance).
- B-b (**arbitration**) Bob's watch arrives AFTER narrowing → his instance
  materializes in the next wave (mutation: no arrival re-arm → never).
- B-c a space-scoped node runs ONCE regardless of demander count (cost
  pin); its writes carry NO acting (§F).
- B-d session narrowing under a user-instance run: the run's own instance
  is `session:alice:s_rep`; the sibling session re-armed; the user slot
  holds the via-user redirect.
- B-e attribution: user-instance run → `actingUser` only, LT6 event
  `firedAt.session="server"`; session-instance → pair; the served wish
  ratchets to user via `homeSpacePrincipalFor` and provisions with
  `demanded-run:<user>` carriage.
- B-f the demand walk reaches a per-user subtree (an `ifElse` on a
  per-user flag guarding a computed): the guarded computed materializes
  for the user whose flag is set and NOT for the other.
- B-g storm pin: two users, divergent per-user inputs, ≥ 20 authored
  edits each → `waves` bounded (≤ inputs + small constant), zero
  `wave-commit-rejected … missing path`, no `scheduler-non-settling`
  server-side.
- B-h (**gates**) `cfc-group-chat-demo-two-browsers` and
  `lunch-poll` two-browser: client action runs bounded (< 500 / 5 min vs
  45-56 k), `runtime:idle` resolves < 3 s, zero non-settling episodes;
  the R7 status assertion GREEN (with A-d); the lunch `#profile` wish
  runs per demander (no identity-less throw).
- B-i OFF byte-identity (skip list must not grow).

Spec edits (ride with B): scopes §2 demand paragraph gains the mechanism
sentence (§A) + the probe/re-arm/arrival sentences; serving-loop §1
("recomputes that value and its upstream" → "for the subscriber's
instances") and §3b's scope-discovery bullet (:355-363, + the demand walk
per demander); protocol §1 attribution paragraph (+ §B6's redirect note
per §I ruling) and §4 (+1 sentence: W waits on demanded instances,
arrival is later demand); events.md unchanged (already rules F);
verification-coverage: OW29 → LANDED (its direction vindicated, storm
attributed to OW17), OW32 → mechanism CLOSED (client-loop root cause =
F1), OW17 → LANDED (leg 2), the register row for §E residual 1.

Danger pins: node count independent of N (C11b); no static scope input
anywhere (grep-able: the ratchet is written only from `recordReadScope`,
the write path's redirect site, and `homeSpacePrincipalFor`); the
service identity never appears as `action_scope_key`/`scopeKey` for a
demanded piece (store-dump assertion in B-a); OFF byte-identity.

### Stage C — closeout

Un-skip the two two-browser gates (`tasks/server-execution-on-skips.ts`);
measure §E residual 1 and decide the arrival gate (a rider PR if needed);
the honest benchmark; register dispositions; the OW31 posture item
travels with the flip PR as already recorded.

---

## H. What NOT to do

- **Per-instance dependency-graph nodes** (violates C11b — instances live
  in keys/basis/stamps; the run is the fan-out unit, `run.ts:376-388`).
  The demand walk is one node with N runs, not N nodes.
- **Client-side fallback execution for undemanded instances** (the v1
  trap the owner rejected; scopes §9 "a client committing ANY scoped
  derived instance"). The client speculates its own instance only
  (scopes §4) and never fills the server's gap.
- **Static scope analysis** (D11; scopes §2 :89-94, §9): no schema/code
  inspection decides instance sets — `k` is learned by running (the
  ratchet's three sources are all run-time events).
- **Unbounded fan-out without demand pacing**: instances come from
  demanders only; no "all known principals", no wildcard-instance watches
  on the loopback session (considered: cheaper wire plumbing, but the
  replica would then hold instances nobody demanded — rejected).
- **Per-instance watermarks** (scopes §9); **a fourth commit class or per-instance commits** (protocol §1).
- **The whole-doc-set write hack (OW29's (5))**: unnecessary once the diff base is the instance's own doc; do not resurrect it as a shortcut.
- **Deriving instance identity from ambient state** ("current user"
  global, the service session) — key-vocabulary §4; the identity always
  arrives with the demand or the event.

---

## I. Owner rulings needed (flagged, not filled)

1. **The mechanism sentence itself** (§A) — a spec change to scopes §2 /
   serving-loop §1/§3b: "a principal's demand at a broad address is
   demand for that principal's instance of every node that narrows
   beneath it". Recommended as written; it is the ruling in mechanism
   form.
2. **Attribution rule** (§F): output-scope-derived acting (recommended;
   matches events.md/protocol §1 as written) vs keep P2-F's full-pair
   stamp and amend the specs.
3. **Redirect attribution** (§B6): amend protocol §1's "the SpaceServer's
   OWN write" sentence for the discovering run's redirect (recommended)
   vs strip per op at seal.
4. **Undemanded eager narrowing** (§B5): accept-and-count (recommended
   for this train) vs refuse vs defer.
5. **Event actor as transient demander for preflight** (§B5): include
   (recommended) vs accept the non-watching-actor edge.
6. **§E residual 1** (first-demand transient): whether the shelved
   arrival gate returns as a follow-up — decide on measured evidence
   after stage B (the owner's own "revisit if necessary").

---

## J. Risks (ranked)

1. **Stage A's blast radius.** The replica re-key touches every local
   read/write/notify path of the runner and the wire's frame identity;
   the OFF arm must not move by a byte. Mitigation: the address-instance
   field is optional and unset off the serving path; neutrality pins per
   site; two PRs.
2. **Coverage of the demand walk.** If a per-user subtree is reachable
   only in ways the per-demander walk misses (§E residual 4), OW32-shaped
   loops persist for those nodes and look like a regression of the fix.
   Mitigation: B-f + the two gates' non-settling counters; the arrival
   gate as backstop.
3. **Cost at cardinality N.** Instance-imprecise dirtiness is O(N) per
   input change per narrowed node; the deadline bounds latency, not work.
   Mitigation: B7 precise dirtiness behind the benchmark; the pass
   budget already counts instance runs.
4. **Attribution timing.** Deriving `acting` at point of use moves
   `capabilityRef` minting from stamp to seal; a path that reads
   `context.acting` before the ratchet has moved (an early `.send()` in a
   run that reads scoped state later) carries a broader actor than the
   run's final scope. Mitigation: B-e; the anti-pattern status of
   derivation-emitted events; the alternative rule in §I.2.
5. **The probe run's determinism.** `min(D)` as the probe/representative
   is stable per registry state but changes when the smallest pair
   leaves; only resolution scaffolding, never attribution — pin that no
   annotation depends on it.

---

## K. Cite index (P7 head 6d18d6998)

Runner: `executor/space-server.ts` :240-256 (`neverAPieceRootId`), :258-264 (double-buffering), :363-376 (`#demandedIdentities`, `#pieceRootByDemandKey`), :711-722 (resolver install), :803-807 (`noteDemandChanged`), :945-1000 (`#openWave` wave-level identity :952-955), :1005-1122 (`#stampRun`; acting :1023-1031; capabilityRef :1069-1076), :1124-1156 (`#runInstancesFor`), :1158-1180 (effect completion), :2035-2261 (`#loadDemandedStructure`; `keyOf` :2062-2081; identities :2118-2130; prune :2083-2094; sink :2229-2253), :2394-2440 (deadline race). `scheduler/run.ts` :376-405 (supply), :407-443 (`runOnce` + stamp), :485-491 (serial loop), :526 (`markActionHasRun`), :594-694 (finalize; resubscribe :687-692). `scheduler/keys.ts` :26-33. `scheduler/facade.ts` :271, :349, :622-641 (`resubscribe`), :1684-1708, :1937, :2126, :2298. `scheduler/scheduling-writes.ts` :81-84, :156-190. `scheduler/dependency-graph.ts` :324-339, :447-472. `scheduler/dependency-updates.ts` :33. `scheduler/invalidation.ts` :160-169. `scheduler/types.ts` :35-47. `scheduler/node-record.ts` :19-40. `runtime.ts` :1923-1966 (`installSealDestination`), :2002-2006, :2022-2035, :2593-2617 (`homeSpacePrincipalFor`). `runner.ts` :5799-5840, :6329, :6439. `pattern-binding.ts` :274-330. `data-updating.ts` :690-785, :837-870 (seed; memo key :850/:860). `runner.ts` :3874-3879, :3956, :6182 (runtime-identity keyed sites). `traverse.ts` :1742. `cell.ts` :1692-1708 (LT6 send), :3486-3567 (sink). `executor/wave.ts` :111-152, :984-1022, :1024-1043, :1655-1668, :1860-1878, :1889-1892, :2078-2090, :2151-2191. `storage/v2.ts` :1358, :1396, :2106-2107, :2112, :2300, :3154-3280, :3505-3530, :4628, :4678 (+ the 16 `docKey(` sites). `storage/v2-transaction.ts` :173-174, :2549, :2571. `storage/extended-storage-transaction.ts` :303, :945-951, :974-979. `storage/selector-tracker.ts` :87-94. `storage/transaction/address.ts` :17-20. `speculation/overlay-destination.ts` :853-928.

Memory: `v2.ts` :144-171 (`resolveScopeKey`), :198-206, :945-960 (`GraphQueryRoot.entityScopeKey`), :1017-1031 (`SessionSyncUpsert/Remove`). `v2/server.ts` :3722-3752 (push filter/exemption), :3819-3825, :3995-4087 (`watchedRootsForSpace`), :4198-4241 (collapse guard), :4286-4313, :4326-4374 (:4340-4342 "the OW17 residual"). `v2/server-sync.ts` :104. `v2/client.ts` :1414, :1490-1518. `v2/scheduler-basis.ts` :39-95. `v2/engine.ts` :2853-2870.

Specs: `scopes.md` :84-186 (§2), :211-223 (§4), :264-279 (§5 run identity), :440-457 (§9). `serving-loop.md` :49-60 (§1 demand), :177-243 (§3), :313-363 (§3b), :451-459 (S4). `protocol.md` :108-115, :133-264 (§1 identity model), :266-282, :437-444, :548-589 (§3), :591-618 (§4). `events.md` :90-113. `speculation.md` :78-113. `key-vocabulary.md` §1-§5. `verification-coverage.md` :900-1049 (OW17), :2329-2357 (OW29), :2402-2430 (OW32).

Evidence: `/Users/berni/labs-worktrees/nonsettle-triage.md` (:13-37 verdict, :95-160 mechanism, :175-191 class statement, :258-281 R7), `/Users/berni/labs-worktrees/p7-build-report.md` :77-90.
