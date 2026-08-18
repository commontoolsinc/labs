# v2 detail: built-in contracts

Normative expansion of [README.md](README.md) §3.5. One entry per
built-in family; an implementer should be able to port a built-in to the
serving loop from its row plus the referenced sections.

## Anchors (verified on main, 2026-08-02 — re-verify before coding)

- Inventory: `packages/runner/src/builtins/` (registered via
  `registerBuiltins(runtime)` in `index.ts`).
- Raw builtin shape (from `navigate-to.ts`): a factory
  `(inputsCell, sendResult, addCancel, cause, parentCell, runtime) =>
  RawBuiltinResult` whose `action(tx)` runs under the scheduler. Served
  built-ins keep this shape — the serving loop hosts the same runtime.

## 1. Pure structural — serve as-is, speculable

`map`, `filter`, `flatmap`, `if-else`, `when`, `unless`,
`inspect-conf-label`, `wish`. (`list-element-link`,
`list-op-argument-usage`, `list-result-schema`, `op-pattern-ref` and
`scope-policy` are helper modules, not registered built-ins — nothing
to place.)

Contract: deterministic functions of their resolved inputs; no memo, no
authority, no outbox. They run wherever the graph runs (server
authoritatively, client speculatively) with zero code difference. Port
cost: none beyond running the existing registration server-side.

`wish` note: destination-fixedness (v1 task) is subsumed — a wish
resolves to data; any enactment goes through the client-effect channel
if it ever needs one.

## 2. Effectful — server-only, memoized, outbox-driven

Common contract (serving-loop.md §4–5): memo key from resolved request;
hit ⇒ stored result is the value; miss ⇒ outbox; result + key in one
derived commit; error results advance the same way; in-flight dedupe by
key; client speculation reads through (speculation.md §2).

| built-in | request inputs (memo key basis) | result cell | authority | notes |
| --- | --- | --- | --- | --- |
| `fetch` (`fetchData`) | url, method, headers (allowlisted), body, response schema | `{ result?, error?, pending, requestHash }` — today the hash lives in an internal cell `{requestId, lastActivity, inputHash}` (`fetch.ts:427-472`); the "migrate it onto the result doc" move was DEFERRED at stage G (deliberate): the internal-cell hash is functionally equivalent committed state (T10.Q1 — §4's memo rule reads it the same), and the migration is an OFF-arm cell-shape change, so it waits for an OFF-arm ruling batch that wants it (plausibly never) | capability handle bound at wiring (README §3.8) | redirects/deadlines per existing `fetch-request-deadlines` doc; today's outbox id `` `${kind.name}:${inputHash}` `` is the memo+outbox-dedupe precedent |
| `fetch-program` | program source ref + integrity | compiled program ref | same | feeds `compile-and-run` |
| `llm` (`generateText` / `generateObject`) | model, messages/prompt, schema, params | settled result only (protocol.md §6 — no partial commits in v2); `requestHash` already sits on the result cell today (`llm.ts:716-822`) — the precedent §4 generalizes | broker-held provider keys; grant from handle | temperature etc. are inputs, so nondeterminism is memo-stable by construction |
| `llm-dialog` | dialog state + params | settled turns | same | multi-turn = new key per turn |
| `sqlite*` | database link, statement, params, reader principal | one cleared result cell per (query, reader) | read served under the reader's clearance | clearance = per-reader materialization (RULED 2026-08-02) — see below |

`sqlite*` row clearance — RULED 2026-08-02: **per-reader
materialization**, today's shape. The reader principal is part of
the memo key, and each (query, reader) pair materializes its own
cleared result cell, cleared where the read is served — no two
readers ever share a result cell.

FORBIDDEN: any of these executing in a client runtime under the flag;
result caches outside the cell (no process LRU that survives the memo
rule); streaming partial commits.

## 3. Compile / instantiate — server-side, sandboxed

`compile-and-run`: compiles + instantiates patterns (piece creation),
including when invoked from a handler's consequences. Runs in the
SpaceServer's runtime; compilation itself already happens server-side in
toolshed — reuse that path. Async work stays on the post-commit outbox
(the v1 lesson that ported: never block the loop on compilation).
Instantiated pieces join the space's graph and are served like any other.

**Served shape — LANDED (OW28, stage C 2026-08-17).** The COMPILE is the
outbox effect (kind `compile-and-run`), memoized on the program hash (a
`{ requestHash, resolvedHash, compiledHash }` memo cell — the §4 shape):
a served derivation MISS enqueues it, the SpaceOutbox performs it
post-wave-commit, and it lands a marked COMPLETION commit
(`markEffectCompletion`, §4 — its own derived-class commit, never through
§3d's sealing, never unstamped). The completion does NOT instantiate; it
RE-ARMS the derivation (`compiledHash`). The INSTANTIATION is then an
ordinary consequence of the served graph run — the derivation reads the
compiled pattern from the process cache and instantiates the child IN-RUN
(the result-as-pattern shape below; derivation-class setup, correctly
scoped per demander, the child's own body served as ordinary
derivations). The re-arm is ONE of two instantiate triggers, not the
only one: any run that finds the pattern in the process cache — an
incidental re-run after the effect cached it, a fresh closure over a warm
process — instantiates without waiting for it, and the completion then
re-arms nothing (a completion NEVER overwrites a landed resolution). This
split is deliberate: a post-commit flush that instantiated would RACE the
serving loop's own resume of the prior child (the loop re-runs a demanded
piece from its stored `patternIdentity` pointer, and a flush's
`run`/`runSynced` loses the re-instantiation to it), so a program change
would keep serving the OLD child. The §4 HIT rule keys on `resolvedHash`
(set on every TERMINAL outcome — a landed piece, an error-shaped result,
or a synchronous invalid-inputs/ main-not-found), NOT on `pending`: the
builtin's cell-init writes `pending=false` on a fresh closure's first
run, so a pending-based hit would FALSELY fire for a durable mid-compile
request on recovery — the piece would render empty forever (the
recovery-mid-flight wedge). A compile FAILURE lands an error-shaped
result keyed by the program hash (retry input-driven — never a timer,
T14).

**Supersession (the OW28 independent review's MAJOR-A).** The ON arm has
NO abort signal: an issued compile effect always runs to its completion,
and the COMPLETION decides by re-reading the node's CURRENT request hash
through its own transaction (§4's FP6 re-read at writeback) — current
again → it lands; superseded → it writes nothing, reports itself
(§7's `outbox.superseded`), and its retirement RELEASES the outbox key.
This is the discipline the outbox's in-flight attach relies on: an
A→B→A′ sequence within A's compile duration attaches A′ to A's
still-running effect (same key), so an effect that returned on "aborted
at B's issue" would drop A′'s only completion and the node would stay
`pending=true` forever, no counter naming it (the wedge, live-reproduced
and pinned red-first). A same-hash re-run mid-flight reads the
issue-time `requestHash` and WAITS — never re-issues into the in-flight
key.

**Instances (the review's MAJOR-B; scopes.md §6).** A scoped
compile-and-run node fans out once per demanded instance through ONE
closure, so every per-instance fact lives outside the closure: the
cells resolve their instance through the run's transaction, the effect
key carries the run's instance (`effectTargetKey` with the run identity —
memo keys INCLUDE the instance key), and the completion transaction is
STAMPED with the issuing run's identity so its request re-read and its
writes address the instance the effect was issued for. The rule: ONE
compile per program per process (the pattern cache is shared and
single-flights); ONE effect completion + ONE instantiation per demanded
instance (pinned live at cardinality 2 — a per-user program, the same
text for two demanders: two effects, one real compile, both instances
land). Recovery re-uses a LANDED piece when the memo cell is synced by
the fresh runtime's first evaluation: the loop resumes the child from
its pointer, and the hit rule reads through. When it is NOT (the memo
cell is unlinked and only `.sync()`ed at init — T10.Q4's at-least-once),
that first evaluation RE-MISSES: it re-issues, which WIPES the landed
child client-visibly (`result` cleared, `pending=true`) until the re-arm
re-instantiates it — a re-compile (cold cache) plus a brief
re-instantiation on that restart, correctness held by `resolvedHash`. A
mid-flight request (issued, never resolved) re-misses and re-fires the
compile the same way (§6 step 3) — every park / crash /
dropped-or-refused completion ends the serving runtime, and the fresh
one's first evaluation re-fires (pinned live: a park mid-compile
resolves on re-activation). A re-arm that landed but whose process
compile-cache entry was since evicted also re-fires rather than wedging.
Posture, stated (the request-hash builtins' identical one — fetch's
in-memory claim blocks re-issue the same way): a completion commit that
FAILS on a LIVE runtime that did not park (an infrastructure failure the
outbox counts as `outbox.failed`) stays pending until the space
re-activates or the inputs change; no dirtiness- or timer-driven retry
is invented. The CLIENT reads through (speculation.md §2) for EVERY
outcome: a flag-ON non-serving run never compiles and writes nothing
request-bearing speculatively — not even the synchronous invalid-inputs
/ main-not-found outcomes, which the server decides identically and
lands as committed cells — so the served `pending`/`result`/`error`
render directly (a speculative echo only delayed the read-through); the
two writes the claim excepts are the shared cell-init's
`pending.send(false)` loading default and the `sendResult` links, both
request-free. Content-cache note: the served path normalizes the program
to a PLAIN object before keying the compile cache — `createRef({ src })`
is insensitive to nested `contents` on the `asSchema` query-result
proxy, which would collapse distinct programs to one cache key; the
underlying defect is pre-existing and stays live in the OFF arm
(verification-coverage.md's OW28-createRef row).

Result-as-pattern instantiation — a lift or handler RETURNING a
pattern, instantiated into a deterministic result cell — is a RUNNER
path distinct from `compile-and-run` (no compilation step), and it runs
server-side as an ordinary consequence of the graph run: the child
joins the space's graph the same way (runtime-mapping.md N37/N38).
Client speculation MAY instantiate result-as-pattern children
overlay-locally (owner, 2026-08-02 — REVERSING the earlier
no-speculative-children rule): child ids derive from cause, so the
speculative child converges with the authoritative one by identity;
overlay containment applies — nothing commits (speculation.md §2).
`compile-and-run` children stay unspeculated: compilation is an
effectful step, so the branch reads through until the authoritative
child arrives.

## 4. Client-enacted — `navigate-to`

Split contract (protocol.md §5): the SERVED half computes the target
(existing `navigate-to.ts` logic minus any client assumption) and writes
the §5 entry — `{ nonce, kind: "navigate", args: { target },
issuedIn }`; protocol.md §5 is normative for the shape — into the firing
session's effects INSTANCE — the effects doc addressed by that
session's `scope_key` (protocol.md §5, T9) — as part of the wave's
derived commit. The CLIENT half
subscribes to its effects doc, enacts, acks by nonce. Optimistic
enactment from the speculative handler run is allowed; the nonce
reconciles it.

Implementation note: the served half needs the firing session's
identity — it comes from the event's `firedAt`, which is
SERVER-STAMPED (from the authenticated commit envelope, or from the
validated carried actor for delegated appends — protocol.md §2) and
carries
both user and session (events.md §1, protocol.md §2). The served half
CONSUMES that value; it never re-derives, defaults, or trusts a
client-supplied one. Actor inheritance (events.md §2, owner
2026-08-03) is what makes this compose across chains: an event
emitted by a handler run carries that run's acting identity, so a
navigateTo computed several hops from the click — cascades and
cross-space appends included — still addresses the SESSION THAT
CLICKED. "Consequences of a client-fired event" below means the
whole inheritance chain, not just the first hop. A
navigation computed outside any event context (pure derivation) has no
session, and a sessionless event (`firedAt.session = "server"`,
events.md §2 — no acting session anywhere in its chain) has no
client to enact — both are the SAME runtime
ERROR: navigateTo MUST be reachable only from the consequences of a
client-fired event. Enforce with a runtime check, not a type dance.

**Cross-space navigateTo is DEFERRED (LT3, RULED 2026-08-03).** The
intent write additionally requires the acting session to be a
CONNECTED session of the COMPUTING space: sessions are valid across
spaces (protocol.md §5, LT2), but a space the client holds no
connection to has no channel to deliver the intent on — it would
compute an intent nobody enacts. A cross-space chain that computes
navigateTo is therefore the same runtime error, naming this
section. In practice this bites rarely: the navigateTo-producing
handler is an immediate consequence of a click, so the CONTEXT is
same-space even when the navigation TARGET is a cross-space link.
Anticipated redesign, out of v2 scope, recorded so the deferral has
a direction (owner, 2026-08-03): the client VENDS its own stream
target for effects — reversing the flow, the client's connected
stream is passed to other spaces, which then append intents to it.

## 5. Deferred / excluded

- `stream-data`: disabled under the flag (owner, 2026-08-02 — unused;
  low-latency UI wants a different mechanism). A pattern using it under
  the flag gets a clear runtime error naming this section.
- `resume-republish`: re-evaluate under v2 recovery — it is currently
  LOAD-BEARING on main in `filter.ts`/`flatmap.ts` (#4367, #4438), so
  "do not port" is not on the table; decide its end state against
  serving-loop.md §6 when Phase 1 lands the list coordinators.
- `wish` home-space materialization under serving — LIFTED by Phase 5
  as **per-demanding-identity wish resolution** (RULED 2026-08-14;
  supersedes the (c)-ruled interim refusal): on a serving runtime the
  wish's home-space targets (`#favorites`/`#journal`/`#profile`
  family) resolve against the RUN's demanding identity — the
  demand-supplied instance identity (P2-F's run supply) or the
  event's stamped actor, read from the stamped run context — NEVER
  the service identity (`Runtime.homeSpacePrincipalFor`); a
  home-space wish with NO demanding identity refuses loudly (a
  WishError at the resolution guards; a hard error at the cell
  resolution backstop). Its home-space bootstrap writes ride
  protocol.md §2b's `.inSpace` sanctioned crossing — authored-class,
  foreign-first, under the demanding principal's acting identity +
  grant, ADMITTED at the wave's accept gate because the target IS the
  demander's own home space (the gate's owner-by-identity structural
  grant, serving-loop.md §3d — carriage alone admits nothing). A
  carriage-less or UNGRANTED foreign write — the lunch-wall class,
  and an actor reaching beyond its authority — still refuses at
  accumulation, action-scoped and counted (`foreignWriteRefusals`).
  The serving side's sidecar compile-cache context is the SERVED
  space, never the service identity's own (the same class of
  ambient-identity leak, closed with the same lift), and the sidecar
  SURFACES key per demanding identity — the result/ready cells AND
  the builtin's per-node closure caches alike (one wish node serves
  every demander; a shared cache slot would hand demander #2
  demander #1's create surface and clobber the pending input).
  Client wishes are byte-identical to before (cardinality 1: the
  runtime's own user; the client suggestion-cell cause carries no
  user key, exactly as before). *Phase 7: on a flag-ON NON-serving
  runtime the sidecar surfaces (create/picker/suggestion) are the
  SpaceServer's compile-instantiate steps (§3) — the client's
  speculative wish run REFERENCES the served sidecar cell
  (cause-derived, so both sides name one doc) and never fetches,
  instantiates or writes it (pre-Phase-7 a flag-ON client's
  bookkeeping-stamped instantiation raced the server's on the same
  docs). The OFF arm and the serving runtime are unchanged.*
  *Read authority for the demanding user's home space (Phase 7):
  the served wish's foreign reads ride the serving runtime's loopback
  plane, whose sessions are admitted by the memory ACL as the process
  identity — under the flag the toolshed process's identity is a
  memory service principal (protocol.md §2b's free-read row;
  `memoryServiceDidsFor`), the posture every deployment checklist
  already requires of the operator DID. Honestly (P7 independent review
  finding 6): a service principal is implicit OWNER for its sessions on
  every space, so this WIDENS the process identity's ORDINARY session
  traffic to OWNER everywhere; it is not widened at the wave's §2b
  accept gate (which checks the ACTING identity's grant). The narrower
  read-only shape is a ruled item — verification-coverage.md OW31.*

## 6. Adding a new built-in under v2 (checklist for future work)

1. Classify: pure / effectful / compile-instantiate / client-enacted /
   deferred — README §3.5's five classes. There is no sixth.
2. Pure ⇒ nothing else. Effectful ⇒ define the memo-key basis in §2's
   table via spec edit, wire the outbox, never the loop.
   Compile-instantiate ⇒ §3's contract (async on the outbox; the result
   joins the graph). Client-enacted ⇒ new `kind` in protocol.md §5 via
   spec edit. Deferred ⇒ disabled under the flag with a runtime error
   naming §5.
3. If the built-in seems to need per-run persisted provenance, a claim,
   or its own commit class — it does not; re-read README §2.
