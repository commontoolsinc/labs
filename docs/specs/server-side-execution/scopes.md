# v2 detail: cell scopes — instances, never authority

Normative spec for scope semantics wherever scoped state appears
(plan Phases 1–5; the Phase 0 scopes review owns this doc and is in
progress). Drafted from the owner rulings of 2026-08-02, batch 3
(S1–S5 below), with the batch-4 closures folded in (§2 fan-out
composition; §7 M3 and floor); anchors verified by the
scope-mechanics scout pass of 2026-08-02 (§Anchors, §7). Read
[README.md](README.md) §3.8 and §6 Q7 first; assumes
[serving-loop.md](serving-loop.md) vocabulary.
MUST/NEVER language is binding on implementers.

## Anchors (scout pass 2026-08-02; re-verified 2026-08-05)

Today's scope machinery, pinned read-only by the scout. Paths are
relative to `packages/runner/src/` unless another package is named;
runtime-mapping.md rows 49/56/57/60 remain the mapping rows. Line
anchors resolve against THIS branch's tree; §7's inventory of main's
machinery marks the cites that resolve only against main.

- **Lattice and enum**: `scope.ts:11`; `narrowestScope` picks the
  narrowest by rank (`scope.ts:129-139`).
- **Discovered output scope**: a per-transaction ratchet,
  `narrowestReadScope`
  (`storage/extended-storage-transaction.ts:275`, `858-871`) — every
  read, link hops included, ratchets it. The runner resets it before
  reading inputs (`runner.ts:5572`), reads the floor after the fn
  returns (`runner.ts:5655`), and derives `effectiveOutputScope`
  from it (`runner.ts:5074-5084`).
- **The narrowing redirect write**: `pattern-binding.ts:279-305` —
  when the discovered scope is narrower than the resolved binding,
  the runtime writes the value at `{...ref, scope: outputScope}`
  (same space, same doc id, same path — only the scope differs) and
  a sigil link to that scoped ref at the broader slot. On-disk
  shape: a sigil link at the broader address resolving to
  `{scope: "user"|"session", id: <same doc id>}` (asserted by
  `packages/runner/test/pattern-scope.test.ts:2837-2848`).
- **Declared-scope redirects** (schema `asCell: [{kind, scope}]`):
  `data-updating.ts:681-727`; eager redirects for omitted scoped
  properties `data-updating.ts:1516-1583`.
- **Scoped-slot writes outside the declared surface**: warn-only
  diagnostics, with per-user/per-session writes exempted
  (`scheduler/run.ts:619-657`, exemption `633-640`).
- **Session-scoped result cells**: the runner keeps result cells per
  scope, `previousResultCellRef.byScope` (`runner.ts:5086-5110`);
  `navigateTo`'s result cell is session-scoped
  (`builtins/navigate-to.ts:45`).
- **Instance addressing**: scope never changes the doc id. Storage
  rows are keyed `(branch, id, scope_key)`
  (`packages/memory/v2/engine.ts:160`, `:177`), with scope keys
  `'space'`, `'user:<principal>'`,
  `'session:<principal>:<sessionId>'` — the shared vocabulary
  `resolveScopeKey` in the wire-shape module
  (`packages/memory/v2.ts:120-147`; LD3, key-vocabulary.md §3) —
  resolved from the authenticated session at admission for
  `authored` traffic.
- **Dirtiness**: the server's query/watch tracking and the client
  dependency graph are keyed per scope INSTANCE via the shared
  vocabulary (`entityKey`, `scheduler/keys.ts:26-33`;
  `packages/memory/v2/query.ts`'s `toDocKey` — stage E, §7 M2), and
  since stage F the wake/sync path keys dirtiness AND delivery per
  instance too (`toDirtyKey` = `${scope_key}\0${id}` — §7 M4,
  landed). The full inventory of instance-keyed construction sites
  is [key-vocabulary.md](key-vocabulary.md).

## 1. North star

**Scope keys INSTANCES; it NEVER keys authority.**

A scoped node is one node with many value instances — one per
principal at its scope. Who computes and commits them does not vary
by scope: the space's SpaceServer derives EVERY instance of EVERY
scoped node, under the same lease and the same single-deriver
invariant (README §1, serving-loop.md §2). No per-scope executor, no
per-scope lease, no scope-conditional commit right — a session
instance is committed by the SpaceServer exactly as a space value
is.

v1's contrary framing — scope as execution RANK (lanes, per-rank
claims, the context ladder) — stays dead (README §5;
runtime-mapping.md row 60). serving-loop.md §8's tripwires already
ban its identifiers; §9 below adds the scope-specific ones.

## 2. The lattice, and scope discovered by running (S1)

The lattice: `space < user < session`, ordered broad to narrow.
`space` is the broadest and the default.

**A derivation's scope is DISCOVERED at run time**: it is the
narrowest scope of any data the run read. Reads follow links, so
what a run reads — and therefore how narrow it is — is unknowable
ahead of time. This is D11 extended one notch: no static read
analysis (serving-loop.md §3b) also means NO static scope analysis,
anywhere, ever.

**Narrowing is written as a redirect.** When a run discovers that
its output is narrower than the declared output address:

- the runtime writes a REDIRECT at the declared (broader) address,
  pointing to the same doc at the narrower scope, and
- writes the value at the narrower-scope address — one address per
  principal at that scope; those addresses are the INSTANCES.

A space→session narrowing writes CHAINED redirects,
space→user→session — ALWAYS via user, even when discovery jumps
straight to session, so every chain has the one uniform shape
("just in case": a later user-level reader finds a well-formed user
link to follow). **The eager double-hop is a v2 CHOICE, and it
DIFFERS from main** — flag for implementation. Today each narrowing
EVENT writes exactly ONE hop (`pattern-binding.ts:286-306`,
`data-updating.ts:664-691`); chains only ACCUMULATE across
successive events, because the write-redirect resolution starts
from the current chain end (a later session-narrowing lands its
redirect inside the user instance). No code on main emits both hops
for a single space→session discovery; v2 implementations MUST add
the eager via-user hop.

```
outDoc@space ─redirect─► outDoc@user(u) ─redirect─► outDoc@sess(u,s)
one, shared              one per user u             one per session s
                         (value lives here          (value lives here
                         when user-scoped)          when session-scoped)
```

Consequences, stated hard because nothing in v1 or today's client
faced them:

- **Cardinality is unknown ahead of time AND time-varying.** How
  many instances a node has depends on the scope its runs discover
  and on how many principals exist at that scope — and principals
  keep arriving (a new session, a new user) after the narrowing.
- **A narrowing discovery writes the redirect AND the discovering
  run's OWN instance (RULED 2026-08-02, batch 4; corrected S3).**
  Fan-out is a cardinality fact, not a wave event — but the
  discovering run is itself a run at some instance, and it has a
  value to write. So the discovering wave writes exactly two things:
  the broad-slot redirect, and the value at the discovering run's own
  instance address. SIBLING instances (every other principal at that
  scope) materialize on THEIR OWN demand, like any other undemanded
  derivation (demand-driven materialization, serving-loop.md §1/§3b
  — a subscription or an event is the demand).
  Watermark × fan-out closes by composition, but state the bound
  exactly: W covers DEMANDED derivations (protocol.md §4), so a wave
  DOES wait on demanded siblings — several subscribers demanding
  several instances is ordinary demanded work, bounded like all wave
  work by serving-loop.md §3's budget-exhaustion rule (an
  unquiescing cascade commits and does not advance W). Only
  UNDEMANDED siblings are free. A narrowing multiplies ADDRESSES;
  what it costs a wave is exactly what is demanded of it.
  Note also that the redirect write is an ordinary write: it dirties
  the broad slot's readers IN THE SAME WAVE, so those readers
  recompute against the redirect before the wave quiesces.
- **This is NEW complexity, and v2 owns it.** Today's client
  scheduler never faced fan-out: per client runtime, scoped
  cardinality is exactly 1 — each client computes only its own
  user's/session's instance. The SpaceServer computes EVERYONE'S —
  demand-paced, per the bullet above — so the full instance set
  lands on the serving loop with no prior art in the client
  scheduler. Do NOT port client-era cardinality assumptions into
  the fan-out path.

**Monotonicity (owner-ruled): narrowing is for everyone or no one.**
User-scoped for one user means user-scoped for ALL users; within a
user, session-scoped for one session means session-scoped for all
of that user's sessions. The reason is structural, not policy: the
link INTO the narrower scope is itself shared state AT the broader
scope — all of a user's sessions read the same user-level doc, all
users read the same space-level doc — so one written redirect
narrows the node for every reader of that address at once. Instance
sets are therefore CLEAN PRODUCTS over principals, NEVER ragged
(narrow for some principals, broad for others).

**Permanence (ruled by code): narrowing NEVER widens back.** A
written redirect is permanent. Rewrites MUST NOT strip stored
redirects — today's write path already preserves them
(`data-updating.ts:1470-1474`) — and the narrowing branch fires
only strictly-narrower, so a later broader-scoped run writes
THROUGH the sticky redirect into the narrow instance instead of
un-narrowing the slot; the server-side context floor narrows
monotonically by SQL construction
(`packages/memory/v2/engine.ts:3828-3832`; the floor itself deletes
in Phase 1 — §7). Per-scope
result cells (`byScope`, §Anchors) let a node's output LINKS point
broader again, but the slot redirect stays. No un-narrowing code
exists anywhere on main, and v2 keeps it that way: the widen-back
question (formerly open) is closed NO.

## 3. Lifecycle: durable, with retirement (S2)

Session-scoped DERIVED state is durable-with-retirement. It is
committed state like any other derivation — reload persistence
stays — and it retires when its session retires. "Session" does NOT
mean "short": a mobile app may be one very long session; nothing
may treat session instances as ephemeral or cache-like.

The lifecycle IS the client-effect doc's, not a mirror of it
(protocol.md §5, T9: the effects doc is itself a session-SCOPED
instance keyed by `scope_key`, not a path convention). A session is
minted at connect, persists across reloads, and retires explicitly
on logout or by TTL; a retired session's scoped instances retire
with it, its effects instance among them. Sessions are
CLIENT-GLOBAL (protocol.md §5, LT2 — one `sessionId` across every
space it touches), so retirement sweeps the session's instances in
EVERY space holding one; the §8-item-2 GC design must reach them
all. **ONE retirement rule for
both** — because there are not two mechanisms to reconcile, only
one kind of session-scoped instance.

FORBIDDEN: a second session-lifecycle mechanism.

## 4. Speculation: own instances only (S3)

A client speculates ONLY its own user's and its own session's
instances. This is physics before it is policy: the client lacks
the other principals' inputs anyway — their scoped state is not
replicated to it — so speculation.md §2's unreplicated-inputs rule
already renders every foreign instance PENDING. Stated as the rule
it also is: a client NEVER speculates another principal's instance,
and the overlay never holds one.

Nothing else changes: an instance is just an address (§2), so the
overlay's (doc, path) keying, read-through, and reconciliation
apply as written (speculation.md §1–§4).

## 5. Events: consequences land in the actor's instances (S4)

Handler consequences land in the ACTING principal's scoped
instances. The event names its actor — `firedAt` carries BOTH user
and session, SERVER-STAMPED from the authenticated commit envelope
at admission (events.md §1, protocol.md §2; a disagreeing
client-supplied value is rejected, never corrected) — so the
server-side handler run resolves scoped reads and writes against
THAT principal, never against a SpaceServer-ambient identity. This
is settled, not a shape detail: the earlier "whether `firedAt`
carries the user explicitly" hedge is CLOSED — it does, and it is
stamped. The wider served-effect identity surface is RULED —
R-Q6b: attribution within the derived commit, never a
SpaceServer-ambient identity (protocol.md §1/§7;
runtime-mapping.md N57).

**Consequence events INHERIT the actor (owner, 2026-08-03).** An
event emitted by ANY run carries that run's acting identity —
events run as the session they originated from — uniformly across
run kinds (LT6, RULED 2026-08-03): a handler run's event actor, or
a demanded derivation run's demand-supplied instance identity. So a
chain rooted
in a client event preserves the ROOT (user, session) across
cascades and across spaces (events.md §2; protocol.md §2/§2b
carriage), and session-scoped consequences land in the ORIGINATING
session's instances, navigateTo's intent above all (builtins.md
§4). "Sessionless" below therefore means an event with NO acting
session anywhere in its chain — a space- or user-instance
derivation's send, a timer — not
merely one fired server-side.

**A sessionless actor has no session instance.** A sessionless
event (`firedAt.session = "server"`, events.md §2) whose handler
attempts a SESSION-SCOPED write is a runtime ERROR — there is no
instance to write, and neither falling back to the space instance
nor minting a session is permitted. Same for a user-scoped write
with no acting user. This is the same rule as the sessionless
`navigateTo` error (builtins.md §4), stated on the scope side.

**Run identity, for runs that are NOT handlers (S1).** A derivation
has no `firedAt` to read, and the SpaceServer's own envelope is not
an answer (it would resolve `user:<serviceDID>` and silently read an
empty instance — protocol.md §2). The rule: a derivation runs PER
DEMANDED INSTANCE, and the DEMAND supplies the identity — a
subscribing client demands its own instance, and the run reads and
writes as that instance. When a space demand and a scoped demand
coexist on one root, the run set is exactly the identity-bearing
demand entries: the space demand rides those runs (the space
consumer reads the run's value) and mints no separate userless run,
so the root's derived writes carry the scoped demander's acting
annotation — recorded, not read (protocol.md §1; its "a space-scope
derivation carries none" is the NO-identity-bearing-demand case).
Before any narrowing, a node runs at SPACE
scope and needs no principal at all. Handlers are the other case and
take the event's actor, above. Those are the only two sources.

An event MAY operate ENTIRELY within user or session scope: when
the state a handler modifies is user- or session-scoped, its
consequences are too, and a purely session-local interaction (this
session's UI state) never escapes its scope by accident.

## 6. Effectful built-ins: once per scope instance (S5)

An effectful node (README §3.5) runs ONCE PER SCOPE INSTANCE: a
user-scoped effectful node runs once per user (README §3.8, ruled
earlier), a session-scoped one once per session. Memo keys
(builtins.md §2) therefore INCLUDE the instance key — two instances
NEVER share a memoized result, and one instance's refresh never
invalidates another's. builtins.md §2's sqlite rule (reader
principal in the memo key; per-reader materialization) is the
already-ruled precedent, generalized to every effectful built-in.

Quota attribution for per-instance runs stays DEFERRED (README
§3.8, §6 item 1); nothing in this doc decides whose quota a served
instance run is charged against.

## 7. What main's machinery assumes that a SpaceServer breaks

The scout inventory (2026-08-02) surfaced five load-bearing
assumptions in today's scope machinery. All five hold for a client
that computes ONLY ITS OWN instance and break for a SpaceServer
deriving EVERY instance (§1). Each is live code, not spec debt;
Phases 1–5 meet them wherever scoped state appears. Cites resolve
against this branch's tree except where marked `main`: those name
machinery the landed stages have already deleted or replaced here,
kept because the assumption they document is main's.

- **M1 — Scope is discovered by running AS (principal, session).**
  Discovery is ambient per-transaction state
  (`storage/extended-storage-transaction.ts:275`): a run's scope is
  learned by BEING the principal+session whose reads ratchet it,
  and the floor ratchet assumes monotone evidence per fingerprint
  (main `packages/memory/v2/engine.ts:3990-4004` — the floor
  machinery is deleted on this branch with the observation
  reduction; closing note, migration drop at `engine.ts:1221`).
  → v2: the server must
  evaluate per-instance just to DISCOVER per-instance scope — N
  runs under N identities, with N time-varying (§2).
  The READ side is the half R-Q6b did not cover, and it is now
  RULED (S1; ledger LD5 ratified by the owner 2026-08-03 as the
  read half of the transaction identity model, protocol.md §1):
  reads may name an explicit
  `entity_scope_key`, admissible only for a live lease holder on
  the co-hosted memory server — its own space's lease; FP2 (RULED
  2026-08-03) widened the original this-space-only condition so
  cross-space scoped reads can name their foreign instance
  (protocol.md §2's read row) — the same trust argument and
  the same one equality check as derived writes. Without it a
  SpaceServer read under its service envelope resolves
  `user:<serviceDID>` and returns an EMPTY instance silently:
  `resolveScopeKey` (`packages/memory/v2.ts:120-147`) throws
  on a MISSING principal, never on a wrong one. Which identity a
  run assumes is §5's run-identity rule.
- **M2 — Every in-memory identity key used the scope NAME, never
  the scope_key** — sound only at cardinality 1; per-instance
  keying existed only in storage columns. Three subsystems was an
  UNDERCOUNT: the closure of storage-row-aligned identity
  construction is NINE construction sites, inventoried with their
  required instance dimension in
  [key-vocabulary.md](key-vocabulary.md). → v2, RESOLVED for the
  storage-row-aligned closure (stage E, landed dark): the nine
  sites key per instance via the shared scope_key vocabulary,
  built from an explicitly supplied identity — the runtime's own
  authenticated session at OFF-arm cardinality 1, so the partition
  is unchanged until stage F supplies per-run identities
  (key-vocabulary.md §1–§2). The remainder — the name-keyed
  boundary surface, key-vocabulary.md §5 — re-keys with stage F:
  wire-coupled sites with M4's push re-key, serving-identity sites
  with M1's per-run identities (key-vocabulary.md §4's tripwires
  police both inventories).
- **M3 — There is no all-principals write path.** `resolveScopeKey`
  is fed from the authenticated session at admission (`applyCommit`
  threads principal + sessionId,
  `packages/memory/v2/server.ts:2060-2063`, into
  `engine.ts:2031-2032`), and mirrors refuse to
  re-derive scope context (main `engine.ts:2580-2596`,
  `upsertMirroredSchedulerObservation` — mirror machinery deleted
  on this branch with the observation reduction): a scoped write
  requires that instance's principal. → v2, RESOLVED (R-Q6b,
  2026-08-02): derived commits carry an explicit `scope_key` on
  every scoped write WITHIN the commit (protocol.md §1, §7), so
  `resolveScopeKey`'s session binding narrows to AUTHORED commits
  only. Admission for derived stays the lease equality check,
  unchanged — no per-principal admission, no delegated-capability
  extension to scoped derived writes.
- **M4 — Wake/sync dirtied by scope NAME — RESOLVED (stage F,
  landed dark).** Storage-side reader matching is exact-scope_key
  (main `packages/memory/v2/engine.ts:3024-3066`,
  `findSchedulerReadersForWrite` — deleted on this branch with the
  observation reduction; the branch's query/watch tracking is
  scope_key-keyed, M2), and the wake/sync path now keys dirtiness
  AND delivery by scope INSTANCE (`toDirtyKey` =
  `${scope_key}\0${id}`, `packages/memory/v2/query.ts`; the session
  cache and tracked-id sets carry instance keys, and the wire frames
  are stripped back to scope names — key-vocabulary.md §5's
  re-keyed list). The name-keyed form was fine while each session
  re-evaluated only itself and collapsed instances once one server
  hosts them all; with the re-key, one principal's commit touches
  only the sessions tracking THAT instance (protocol.md §3's
  applicable set falls out structurally, since a session's graph
  evaluates under its own identity).
- **M5 — Retention assumes instances are cheap to re-derive per
  owner.** Session EXECUTION CONTEXTS are capped at 32 per action
  (main `packages/memory/v2/engine.ts:55`,
  `MAX_RETAINED_SCHEDULER_SESSION_CONTEXTS_PER_ACTION` — the
  machinery it bounds is deleted on this branch); session DATA rows
  are never GC'd — nothing retires session data today. → v2: §3's
  durable-with-retirement needs an actual GC design (§8 item 2),
  and a server owning ALL instances cannot have its working set
  silently evicted.

Ruled with the batch-4 closures (owner-accepted derivation,
2026-08-02): `scheduler_context_floor` DELETES with the observation
machinery in the Phase-1 reduction (runtime-mapping.md N59–N61;
plan Phase 1 stage C). Its only job was gating SHARED observation
snapshots across principals; the v2 basis index is per-instance and
shares nothing across principals, so nothing is left to floor.
Nothing of the floor survives as per-instance keying evidence.

## 8. Open — scout + owner (what the Phase 0 review still owes)

Closed by the scout pass, 2026-08-02: widen-back (NO — §2
Permanence) and the redirect's on-disk shape (§Anchors). Closed by
the batch-4 rulings, 2026-08-02: watermark × fan-out (§2 — the
discovering wave writes the redirect and its own run's instance;
siblings materialize on their own demand, and W waits on the
DEMANDED ones only, bounded by serving-loop.md §3's budget rule),
`scheduler_context_floor` (§7 — deletes whole with the observation
machinery), and the M3 write path (§7 M3 — R-Q6b: explicit
`scope_key` per scoped write WITHIN the derived commit; admission
stays the lease check). Closed 2026-08-02 by S1, ratified by the
owner 2026-08-03 (ledger LD5; the transaction identity model,
protocol.md §1): the
READ side — reads may name an explicit `entity_scope_key`, lease
holder only (§7 M1, protocol.md §2) — and run identity for
non-handler runs (§5). Still open (numbering stable — external
citations use it):

1. **Basis-index DDL authoring — CLOSED.** serving-loop.md §3b now
   carries the authored engine-v3 DDL, keyed per INSTANCE
   (id + scope_key), overwritten in place per (action, instance),
   exactly as the §7 closures assumed. The slot stays so item 2's
   citations elsewhere keep resolving.
2. **Session-data GC (M5).** The mechanism that actually retires a
   retired session's scoped instances — none exists today, so §3's
   ONE retirement rule needs it designed, not assumed. It MUST also
   cover NON-SESSION keys (S8): narrowing strands basis rows at
   `space` and `user:<p>` keys that no session retirement ever
   touches, and main's 32-per-action execution-context cap
   (main `packages/memory/v2/engine.ts:55`) dies with the dropped tables
   while `scheduler_basis` specifies no bound of its own. The
   deletion rule in serving-loop.md §3b keeps the stranding from
   growing without bound in the narrowing case; a retirement design
   still owes the general one.

## 9. Tripwires

FORBIDDEN in v2 scope code (additive to serving-loop.md §8):

- any mechanism where scope selects WHO runs or commits — per-scope
  executors, scope lanes, per-rank claims, scope-conditional
  leases;
- a client committing ANY scoped derived instance, its own included
  (the overlay is a scoped instance's only client-side home);
- ragged instance sets as a steady state — a node narrow for some
  principals and broad for others;
- static scope inference (compile-time or load-time) feeding
  placement, admission, or fan-out;
- per-scope or per-instance watermarks (W stays one integer —
  protocol.md §4; watermark × fan-out is closed by composition in
  §2 — nothing forks W);
- reviving the persisted-state context ladder or rehydration ranks
  for instance sharing (runtime-mapping.md row 60).
