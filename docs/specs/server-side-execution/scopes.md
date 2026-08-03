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

## Anchors (verified 2026-08-02, scout pass)

Today's scope machinery, pinned read-only by the scout. Paths are
relative to `packages/runner/src/` unless another package is named;
runtime-mapping.md rows 49/56/57/60 remain the mapping rows.

- **Lattice and enum**: `scope.ts:11`; `narrowestScope` picks the
  narrowest by rank (`scope.ts:129-139`).
- **Discovered output scope**: a per-transaction ratchet,
  `narrowestReadScope`
  (`storage/extended-storage-transaction.ts:273`, `827-847`) — every
  read, link hops included, ratchets it. The runner resets it before
  reading inputs (`runner.ts:5515`), reads the floor after the fn
  returns (`runner.ts:5598`), and derives `effectiveOutputScope`
  from it (`runner.ts:5062-5066`).
- **The narrowing redirect write**: `pattern-binding.ts:281-307` —
  when the discovered scope is narrower than the resolved binding,
  the runtime writes the value at `{...ref, scope: outputScope}`
  (same space, same doc id, same path — only the scope differs) and
  a sigil link to that scoped ref at the broader slot. On-disk
  shape: a sigil link at the broader address resolving to
  `{scope: "user"|"session", id: <same doc id>}` (asserted by
  `packages/runner/test/pattern-scope.test.ts:2837-2848`).
- **Declared-scope redirects** (schema `asCell: [{kind, scope}]`):
  `data-updating.ts:646-692`; eager redirects for omitted scoped
  properties `data-updating.ts:1478-1517`.
- **Scoped-slot writes outside the declared surface**: warn-only
  diagnostics, with per-user/per-session writes exempted
  (`scheduler/run.ts:616-654`, exemption `631-638`).
- **Session-scoped result cells**: the runner keeps result cells per
  scope, `previousResultCellRef.byScope` (`runner.ts:5068-5092`);
  `navigateTo`'s result cell is session-scoped
  (`builtins/navigate-to.ts:46`).
- **Instance addressing**: scope never changes the doc id. Storage
  rows are keyed `(branch, id, scope_key)`
  (`packages/memory/v2/engine.ts:368-403`), with scope keys
  `'space'`, `'user:<principal>'`,
  `'session:<principal>:<sessionId>'`, resolved by `resolveScopeKey`
  (`engine.ts:98-126`) from the authenticated session.
- **Dirtiness**: storage-side reader matching is by exact
  `scope_key` (`packages/memory/v2/engine.ts:3024-3066`); the
  client dependency graph is keyed by scope NAME only —
  `${space}/${scope}/${id}` (`scheduler/keys.ts:6-8`).

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
- **A narrowing discovery writes ONLY the redirect (RULED
  2026-08-02, batch 4).** Fan-out is a cardinality fact, not a wave
  event: the discovering wave writes the broad-slot redirect and
  nothing more; instances MATERIALIZE ON DEMAND, like any other
  undemanded derivation (demand-driven materialization,
  serving-loop.md §1/§3b — a subscription or an event is the
  demand). This also closes watermark × fan-out by composition: W
  covers DEMANDED derivations only (protocol.md §4), so it never
  waits on undemanded instances — a narrowing multiplies ADDRESSES,
  never a wave's work.
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

The lifecycle MIRRORS the client-effect doc's (protocol.md §5): a
session is minted at connect, persists across reloads, and retires
explicitly on logout or by TTL; a retired session's scoped
instances retire with it, exactly as its effects doc does. **ONE
retirement rule for both** — session-scoped derived state and the
effects doc retire together, under the same rule.

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
instances. The event names its actor — `firedAt` gives user +
session — so the server-side handler run resolves scoped reads and
writes against THAT principal, never against a SpaceServer-ambient
identity. (events.md §1's sketched shape spells only the session;
whether `firedAt` carries the user explicitly or derives it from
the authenticated append is a shape detail the 2026-08-02 scout
pass did not settle; it stays with the Phase 0 review. The wider
served-effect identity surface is RULED — R-Q6b: attribution within
the derived commit, never a SpaceServer-ambient identity
(protocol.md §1/§7; runtime-mapping.md N57).)

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
Phases 1–5 meet them wherever scoped state appears.

- **M1 — Scope is discovered by running AS (principal, session).**
  Discovery is ambient per-transaction state
  (`storage/extended-storage-transaction.ts:273`): a run's scope is
  learned by BEING the principal+session whose reads ratchet it,
  and the floor ratchet assumes monotone evidence per fingerprint
  (`packages/memory/v2/engine.ts:3990-4004`). → v2: the server must
  evaluate per-instance just to DISCOVER per-instance scope — N
  runs under N identities, with N time-varying (§2).
- **M2 — Every in-memory identity key uses the scope NAME, never
  the scope_key.** `getDocKey` (`runner.ts:3201-3204`), `entityKey`
  (`scheduler/keys.ts:6-8`), `byScope` (`runner.ts:5068`) — all
  `${space}/${scope}/${id}`, sound only at cardinality 1;
  per-instance keying exists only in storage columns. → v2: the
  scheduler, the dependency graph, and the basis index must re-key
  per instance — the single biggest scope cost of the arc.
- **M3 — There is no all-principals write path.** `resolveScopeKey`
  binds to the authenticated session
  (`packages/memory/v2/server.ts:1577-1580`), and mirrors refuse to
  re-derive scope context (`engine.ts:2580-2596`): a scoped write
  requires that instance's principal. → v2, RESOLVED (R-Q6b,
  2026-08-02): derived commits carry an explicit `scope_key` on
  every scoped write WITHIN the commit (protocol.md §1, §7), so
  `resolveScopeKey`'s session binding narrows to AUTHORED commits
  only. Admission for derived stays the lease equality check,
  unchanged — no per-principal admission, no delegated-capability
  extension to scoped derived writes.
- **M4 — Wake/sync dirties by scope NAME.** Storage-side reader
  matching is exact-scope_key
  (`packages/memory/v2/engine.ts:3024-3066`), but the wake/sync
  path keys dirtiness by `(id, scope-name)` (`server.ts:3233-3239`)
  — fine while each session re-evaluates only itself, quadratic
  waste once one server hosts every instance. → v2: the push path
  must key by scope_key.
- **M5 — Retention assumes instances are cheap to re-derive per
  owner.** Session EXECUTION CONTEXTS are capped at 32 per action
  (`packages/memory/v2/engine.ts:55`); session DATA rows are never
  GC'd — nothing retires session data today. → v2: §3's
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
discovering wave writes only the redirect; instances materialize on
demand, and the demanded-only W never waits on them),
`scheduler_context_floor` (§7 — deletes whole with the observation
machinery), and the M3 write path (§7 M3 — R-Q6b: explicit
`scope_key` per scoped write WITHIN the derived commit; admission
stays the lease check). Still open:

1. **Basis-index DDL authoring.** Per-instance keying is the
   settled shape — the §7 closures lean on it (the index shares
   nothing across principals) — so serving-loop.md §3b's
   `(action, entity, seq)` rows key by INSTANCE (id + scope_key),
   overwritten in place per (action, instance). What remains is
   authoring the engine-v3 DDL that Phase 1 stage C reduces the
   observation tables to (M2 names the re-keying cost).
2. **Session-data GC (M5).** The mechanism that actually retires a
   retired session's scoped instances — none exists today, so §3's
   ONE retirement rule needs it designed, not assumed.

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
