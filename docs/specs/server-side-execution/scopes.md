# v2 detail: cell scopes — instances, never authority

Normative spec for scope semantics wherever scoped state appears
(plan Phases 1–5; the Phase 0 scopes review owns this doc and is in
progress). Drafted from the owner rulings of 2026-08-02, batch 3
(S1–S5 below). Read [README.md](README.md) §3.8 and §6 Q7 first;
assumes [serving-loop.md](serving-loop.md) vocabulary. MUST/NEVER
language is binding on implementers.

## Anchors (PENDING SCOUT — do not code against this section yet)

A scope-mechanics inventory scout is verifying today's code surface
in parallel with this draft. Until its pass lands here, every anchor
below is a placeholder; runtime-mapping.md rows 49/56/57/60 carry
the pre-draft anchors. The scout must pin:

- the scope enum and the output-narrowing site in the runner
  (declared vs discovered output scope) — PENDING SCOUT;
- the scoped-slot write path that bypasses declared-surface checks
  today — PENDING SCOUT;
- session-scoped result cells (`navigateTo`'s) — PENDING SCOUT;
- the link/redirect primitive the narrowing write reuses, if any —
  PENDING SCOUT (its exact on-disk shape is also an owner open, §7).

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
ban its identifiers; §8 below adds the scope-specific ones.

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
link to follow).

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
- **A narrowing discovery FANS OUT, in the discovering wave.** The
  wave that discovers the narrowing writes the redirect AND the
  instances — one per principal at the new scope — as part of that
  same wave.
- **This is NEW complexity, and v2 owns it.** Today's client
  scheduler never faced fan-out: per client runtime, scoped
  cardinality is exactly 1 — each client computes only its own
  user's/session's instance. The SpaceServer computes EVERYONE'S,
  so the full fan-out lands on the serving loop with no prior art
  in the client scheduler. Do NOT port client-era cardinality
  assumptions into the fan-out path.

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
the authenticated append is a shape detail for the scout pass. The
wider served-effect identity surface stays with the Phase 0 review
— runtime-mapping.md N57.)

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

## 7. Open — scout + owner (what the Phase 0 review still owes)

1. **Widen-back.** Whether a narrowing can ever widen back, or a
   written redirect is permanent.
2. **Redirect shape on disk.** The exact durable form of the
   redirect and its chain (link kind, doc shape, where chain nodes
   live) — PENDING SCOUT inventory of today's narrowing writes
   first.
3. **Basis-index keying per instance.** serving-loop.md §3b's rows
   are `(action, entity, seq)`; under fan-out one action yields
   many instances — how the index keys them, and what "overwritten
   in place" means then.
4. **Watermark × fan-out.** W is one integer per space (protocol.md
   §4); how a fan-out wave's multiplied work reports settledness
   through W.

## 8. Tripwires

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
  protocol.md §4; §7 item 4 escalates, it does not fork W);
- reviving the persisted-state context ladder or rehydration ranks
  for instance sharing (runtime-mapping.md row 60).
