# v2 detail: protocol — commit classes, admission, push, watermark

Normative. Assumes [README.md](README.md); details Phases 1–4 surface
between client, memory server, and SpaceServer.

## Anchors (verified on main, 2026-08-02 — re-verify before coding)

- Memory server: `packages/memory/v2.ts`, toolshed mount
  `/api/storage/memory` (`packages/toolshed/routes/storage/memory/`).
- Client storage stack: `packages/runner/src/storage/` (`interface.ts`,
  `extended-storage-transaction.ts`, `query.ts`, `reactivity-log.ts`).
- Store tables: `commit`, `revision`, `head`, `branch` (engine-v3).
  `execution_lease` does not exist on main — it is created in Phase 1
  (serving-loop.md §2; v1-branch shape as prior art).

## 1. Commit classes

Every commit carries a `class` in its metadata. Three values, closed set:

| class | producer | contents |
| --- | --- | --- |
| `authored` | any authorized session; server-produced only via delegated capability (§2) | doc writes (UI bindings, widget edits — and, until Phase 3 lands, client handler writes: the plan's stated interim posture) or event appends (events.md §1) |
| `derived` | the space's SpaceServer (lease holder) | derivation results, watermark advance, `consequenceOf` |
| `system` | memory server itself | space bootstrap, authorization changes — pre-existing, unchanged |

FORBIDDEN: a fourth class; per-class subtypes that alter admission;
clients producing `derived` (there must be no client code path that can
even construct one).

**Both arms carry a class; only the ON arm enforces one.** `class`
metadata is WRITTEN in every arm from stage A onward and ENFORCED
(the §2 admission rows) only under the flag. In the OFF arm the
client still commits derivation results (plan §Interim postures, OFF
baseline) — those commits are `authored`, exactly like every other
client commit today. `derived` names the single-deriver posture, so
nothing outside the flag may claim it; the OFF arm therefore has no
unclassed commit and no third answer.

**The SpaceServer's own writes.** Not every write inside a derived
commit belongs to a user. The watermark advance (§4), the
narrowing redirect written at a broad slot (scopes.md §2), and the
retirement of acked effect entries (§5) are the SpaceServer's OWN
writes under its SERVICE identity — the same identity before any
per-user delegation exists and after it does. They carry addressing
(a `scope_key` where the target is scoped) and NO acting principal;
nothing is being attributed to a user, so nothing is missing.

Threat model, stated honestly (RULED, owner 2026-08-02): the
single-deriver invariant is by construction against HONEST clients —
no client code path constructs a `derived` commit. It is NOT new ACL
protection: derived-output docs get none in v2, so a malicious client
holding today's write authority on a doc can still author into it,
docs the SpaceServer derives into and the watermark doc included
(watermark forgery is possible and accepted for now). v2 defines the
outcome, not a defense: such a write is an ordinary authored input,
and the next wave recomputes the derivation over it. v2 adds no
security guarantees beyond today's unless trivial (owner,
2026-08-02); tightening is future work.

**The transaction identity model (RULED, owner 2026-08-03 — the
modeling that closes ledger LD3 and LD5).** In the owner's words
(lightly edited):

> In the current state a transaction comes from one client, so one
> session id and one user principal. Inside the transaction, scopes
> are named by kind — `scope: "user"` — and it is in memory where
> that gets mapped to the actual user/session keys, derived from
> the session that had the commit. In this proposal, execution for
> all clients — at once, so acting as multiple users — moves to the
> server, and every derived data step combines into one
> transaction. That transaction comes from the server itself; it no
> longer carries user principals and session ids. Those become
> annotations on the actual changes inside, grouped by action — the
> scheduling information and CFC enforcement are by action, and so
> are the user and session keys. So yes, clients can't send keys —
> or rather they do, but as part of the session overall, not per
> commit — and we introduce a variant of server-driven commits that
> do contain those inside. — owner, 2026-08-03

(One sharpening where the quote meets the letter of this spec: "by
action" is normatively BY ACTION RUN — `action × instance` — per
the attribution bullet below and serving-loop.md §3c; under fan-out
one action acts as N principals in one wave, and action granularity
would merge them.)

Stated normatively, with anchors. Today every transaction
comes from ONE client, so identity rides the ENVELOPE: the session
carries the user principal and session id — established once, at
session open, never sent per commit — and scoped writes inside the
transaction name only the scope KIND (`scope: "user"`). It is the
memory server that maps kind → concrete `scope_key` at admission,
derived from the session that had the commit (`resolveScopeKey`,
`packages/memory/v2/engine.ts:98-126`). That model is UNCHANGED for
every `authored` commit: clients never name keys, per commit or
otherwise; their keys keep deriving from the authenticated session.

The wave breaks that model's premise. The server executes for ALL
clients at once — acting as many users and sessions in one pass —
and combines every derived step into ONE transaction
(serving-loop.md §3). No single user principal or session id exists
for that transaction's envelope to carry, so it carries none: the
envelope principal is the SpaceServer's service identity, exactly
the lease holder §2 checks. The identity the envelope can no longer
express moves INSIDE the transaction, as ANNOTATIONS on the changes
themselves — at the grouping the commit already tracks per action
run, the same granularity as scheduling basis rows and CFC
provenance (serving-loop.md §3b–§3c). `derived` is therefore the
ONE sanctioned commit variant that carries explicit user/session
keys inside; §2's read row is the same variant's read half (ledger
LD5), and the shared key vocabulary the annotations force is ledger
LD3 (key-vocabulary.md §3).

**Implementer disorientation guide.** Every intuition today's code
teaches is the ENVELOPE model, so mid-implementation several v2
shapes look like bugs. If one of these feels wrong, re-read the
quote above before "fixing" it:

- *"This commit's envelope has no user principal or session id —
  where does identity come from?"* From inside: the per-action-run
  annotations. Only `authored` commits still carry identity at the
  envelope.
- *"`resolveScopeKey` throws without a principal / would resolve
  `user:<serviceDID>` here."* The function itself is a pure
  constructor; it is its admission-side CALLERS that feed it
  identity derived from the authenticated session (`applyCommit`,
  `packages/memory/v2/server.ts:2128-2132` →
  `engine.ts:5374-5375`) — the client-commit model. Server-side
  runs never derive identity from their own session: identity
  arrives WITH the work (the demand, or the stamped `firedAt`) and
  is carried into keys, not resolved from ambient state (scopes.md
  §5; key-vocabulary.md §3).
- *"One transaction writes as MANY different users at once — is
  that a bug?"* It is the point of the variant: the server acts for
  every client in one pass, which is exactly why its envelope
  cannot name one principal.
- *"Clients get rejected for naming a `scope_key` but the server
  does not — inconsistent?"* Two halves of one model: a client's
  keys derive from its session (sent as part of the session
  overall, never per commit); the lease holder names keys
  explicitly because no session of its own could supply them (§2's
  derived and read rows).

Identity at the derived envelope (R-Q6b, RULED, owner 2026-08-02):
`derived` is a DIFFERENT TRUST CLASS from `authored`. An authored
commit crosses a trust boundary — a session did work the server
never saw, so the envelope identity is the check. A derived commit
does not: the server admitting it also DID the work, so producer
and admitter share one trust environment at the envelope, and
envelope identity verifies nothing there. The SpaceServer therefore
commits under its own service identity — the envelope principal IS
the lease holder §2 checks — and TWO DISTINCT things ride WITHIN
the commit. Conflating them is the error this paragraph exists to
prevent:

- **ADDRESSING — the explicit `scope_key`, one per scoped write.**
  It names WHICH INSTANCE the row is. The engine keys rows by it
  (`(branch, id, scope_key)`, scopes.md §Anchors), and memo and
  clearance identity read it (builtins.md §2, scopes.md §6). It
  attributes nothing to anybody: an address is not a claim about
  who acted.
- **ATTRIBUTION — the acting identity, one per action RUN.** The
  user principal plus, where the run has one, the session — the
  same pair the envelope carries for an authored commit (and the
  pair the stamped `firedAt` supplies for handler runs), relocated
  to the granularity where it is true. The unit is the RUN,
  `action × instance`, NEVER the action: under
  fan-out one action runs N times as N principals inside ONE wave
  commit (scopes.md §2), so per-ACTION attribution would merge N
  principals' provenance inside the load-bearing enforcement
  (serving-loop.md §3c). CFC labels evaluate per instance run for
  the same reason. A run with no acting identity — a space-scope
  derivation before any narrowing — carries none, like the
  SpaceServer's own writes above.

Attributed, not signed, today. The considered alternative — N
commits per wave, one per session, each attributed at its
envelope — is recorded and rejected as the other extreme of the
same axis: the wave stays ONE
commit (§7's amplification budget). Anticipated, not built:
per-user server-generated keys under user-delegated authority; when
delegation exists, attribution graduates to acting-key signatures
without changing the envelope model. CFC labels remain the
load-bearing enforcement; commit-level identity is not load-bearing
(owner).

## 2. Admission, the whole table

| commit class | checks, in order |
| --- | --- |
| `authored` doc write | session authenticated → write authority on doc/path (existing ACL) → CAS on base revision |
| `authored` event append | session authenticated → append authority on stream doc → `eventId` unique among stream entries above the stream's `eventWatermark` (CAS — the dedupe horizon, events.md §4) → the memory server STAMPS `firedAt` from the commit envelope (authenticated principal + session); a client-supplied `firedAt` that disagrees is REJECTED, never corrected |
| `authored`, server-produced (outbox event append, `.inSpace` provisioning) | commit metadata carries `actingPrincipal` + `capabilityRef` → admission validates that capability grant against the target doc/stream (a delegated-capability check, NEVER session-identity impersonation) → CAS |
| `derived` | producer holds the live `execution_lease` for the space (one equality check) → CAS |
| `system` | unchanged from today |
| READ naming an explicit `entity_scope_key` (not a commit — the read side of R-Q6b; S1) | requester holds the live `execution_lease` for the space (the SAME one equality check) → the named instance is read. A non-holder naming a `scope_key` is REJECTED (today the wire cannot even express one); a request naming none resolves from the authenticated session as today (`resolveScopeKey`, `packages/memory/v2/engine.ts:98-126`) |

That is the ENTIRE admission surface — the last row is the one
READ-side check; every row above it is commit admission. No scope
reasoning, no read-set
validation, no certificates: no commit ever asserts that an execution
happened elsewhere. If an admission question cannot be answered by
(target, principal, lease, CAS), the design is drifting — stop.

**`firedAt` is SERVER-STAMPED, never client-minted (T1 + S6).** It
carries BOTH the acting user and the session —
`{ user, session, clientSeq }` — because scopes.md §5 resolves a
handler's scoped reads and writes against the user, not the session
alone. It steers consequences: which scope INSTANCES a handler's
writes land in (scopes.md §5), and which session an effect intent is
addressed to (§5, builtins.md §4). Nothing else in the append binds
it. STAMPING beats checking: the memory server writes `user` and
`session` from the authenticated commit envelope at admission, so a
forged actor is UNREPRESENTABLE rather than merely validated, and a
disagreeing client value is rejected rather than silently overwritten.
`clientSeq` stays client-minted — it orders one session's own appends
and steers nothing.
Delegated appends (the server-produced authored row above) stamp
from the DELEGATION, never the delegating envelope:
`firedAt.user` := the validated `actingPrincipal`,
`firedAt.session` := `"server"` (events.md §2) — stamping from the
outbox's own envelope would run the target handler as
`user:<serviceDID>`, the silent-empty-instance trap this section
exists to prevent.
This PRESERVES a guarantee the store gives today rather than adding
one: `resolveScopeKey` binds scope to the authenticated session
(scopes.md §7 M3), so cross-principal scoped writes are impossible on
main. It is the trivial case README §1's no-new-guarantees rule
exempts — one equality check at one site.

**Read addressing, and why it needed a row.** Writes name their
instance explicitly (R-Q6b); reads did not, and the asymmetry was a
hole, not a simplification. A SpaceServer reading under its service
envelope would resolve `user:<serviceDID>` — `resolveScopeKey` throws
only on a MISSING principal, never on a wrong one, so the failure
mode is a SILENT read of an empty instance, not an error. The row
above closes it by extending Q6b's own trust argument symmetrically:
the lease holder is the party the server already trusts to derive
every instance, so it may NAME an instance to read. RATIFIED
(owner, 2026-08-03; was ledger LD5): this row is the read half of
§1's transaction identity model — the server-driven variant names
keys on both sides of the wire, while the client-facing protocol is
untouched: a non-holder naming a `scope_key` is rejected (today the
wire cannot even express one — the field is new), and client reads
keep resolving from the session.

**Run identity for a derivation (S1).** A derivation runs PER
DEMANDED INSTANCE and the DEMAND supplies the identity — a
subscribing client demands its own instance, and that instance is
what the run reads and writes as. Before any narrowing, a node runs
at space scope and needs NO principal at all. Handlers are the other
case and keep the event's actor (scopes.md §5, server-stamped
`firedAt` above). There is no third source of run identity, and
"whatever the SpaceServer's own envelope resolves to" is never one.

Note what the table does NOT do: `authored` admission checks write
authority on the TARGET only — nothing marks a doc as derived-output,
so admission protects derived docs no more than today does (§1's
threat model; the next wave recomputes over an intruding write).

## 2b. Cross-space writes

The storage layer already enforces the load-bearing rule: **one
transaction writes one space — by DEFAULT, with one explicit opt-in.**
A transaction FAILS if a writer for a different space was already
opened on it (anchor: `packages/runner/src/storage/interface.ts`
`writer(space)`) unless it opted in through `enableMultiSpaceWrites`
(`interface.ts:786`), reachable only via the `.inSpace()` chain below —
which is what makes an UNMARKED crossing always a bug. Reads cross
freely (serving-loop.md §3b; cross-space label metadata flows with
them). v2 keeps that invariant and adds the class discipline:

| crossing | mechanism |
| --- | --- |
| read a foreign doc | free — logged read + server-internal wake (§3b) |
| derive FROM foreign state | home derivation reading foreign inputs; result commits HOME |
| mutate a foreign space | **an event append to a foreign stream — the ONLY cross-space mutation** |
| `derived` commit into a foreign space | FORBIDDEN — SpaceServer(B) is B's only deriver; A never derives into B |
| provision a foreign/new space (`.inSpace`) | authored-class, foreign-first split at the wave commit step — see below |
| client authored writes to several spaces | unchanged from today: separate per-space commits, per-space ACL + CAS |

The event append crosses as an ordinary `authored` commit under the
piece's append capability, carried by the OUTBOX (serving-loop.md §5):
at-least-once, deduped by `eventId` at the target's admission, FIFO per
(source wave → target stream). The commit carries
`actingPrincipal` + `capabilityRef` metadata and the target's admission
validates that grant (§2) — delegation, never impersonation. The
target's SpaceServer processes it like any event. This matches the
codebase's own convention — patterns already mutate cross-space through
exported streams — and it is now the rule, not a style: a server action
tx that opens a foreign-space writer is a runtime error naming this
section.

**Provisioning writes — the second sanctioned crossing
(`.inSpace(...)`)**: the profile-system patterns create foreign spaces —
even mint new ones — from a handler (`profile-create.tsx`,
`ProfileHome.inSpace()`). The real chain is an explicit opt-in
end to end: `.inSpace()` → `optIntoInSpaceMultiSpaceCommit`
(`builder/pattern.ts:1084`) → `enableCrossSpaceChildCommit`
(`runner.ts:4733`, commit order `[children..., parent]`) →
`enableMultiSpaceWrites` (`interface.ts:786`) →
`commitMultiSpace`/`runSplitCommits` (`v2-transaction.ts:2077/2156` —
sequential, stop at first failure): today already foreign-first,
home-after-success. v2 keeps the API, the split, and the order,
relocated into the wave's commit step:

- Provisioning writes seal as AUTHORED-class commits into the
  destination space, under the **acting principal of the event** whose
  handler produced them (creating THEIR space — RULED; the only
  effect-authority residual is quota attribution, README §3.8),
  carried as `actingPrincipal` + `capabilityRef` commit metadata
  for the target's admission (§2). Never derived-class: single-deriver
  per space is untouched, and the minted space's own SpaceServer
  activates later (first session or event) as its only deriver.
- Sequencing at the wave commit step: foreign provisioning commits land
  FIRST (per destination space), then the home derived commit carrying
  the links and the `eventWatermark` advance. Same host, same process —
  this is store sequencing, not a network await.
- Failure: foreign fails ⇒ home never commits ⇒ the event stays
  unconsequenced and replays; persistent failure falls to the
  error-is-the-consequence rule (events.md §5).
- Replay safety: destination DIDs/ids derive from the creation event
  (CT-1650 — anonymous `inSpace()`, DID unique per user + creation
  event), so a replayed handler re-derives the SAME ids and the
  re-provisioning is a CAS no-op. The today-orphan window (foreign
  landed, home did not) becomes convergent instead of dangling.
  Provisioning handlers MUST therefore be deterministic given
  payload + cells — no clock, no randomness (events.md §3); replay
  convergence depends on it. A transformer lint can trail.
- The foreign-writer runtime error therefore narrows to ACCIDENTAL
  crossings: a server action tx may write a foreign space exactly
  where the API opted in (the `.inSpace()` chain above). Unmarked
  foreign writes remain an error naming this section — one tx, one
  space is the default, so an unmarked crossing is always a bug.
- Sharded future (spaces not co-hosted): provisioning becomes
  outbox-carried and the home commit defers a wave. Out of v2 scope.

**Atomicity, stated plainly:** nothing spanning two spaces is atomic —
not today, not in v2. A wave is per-space; cross-space influence is
asynchronous (reads/wakes inward, events outward). What v2 adds is that
the non-atomic boundary is EXPLICIT and carries defined failure
semantics: the outbox retries the append, the eventId dedupes it, and
the target's `eventWatermark` makes processing exactly-once.

## 3. Subscription and push

- Clients subscribe to docs/queries as today
  (`packages/runner/src/storage/query.ts` path). The SpaceServer
  subscribes to the whole space's accepted-commit feed from a seq.
- **Push is FILTERED PER RECIPIENT by `scope_key`** (T4). One derived
  commit legitimately carries several principals' instances (§1's
  fan-out); pushing it whole would replicate other principals'
  scoped state to every subscriber and break scopes.md §4's promise
  that a client never holds a foreign instance. A subscriber
  therefore receives ONLY the rows whose `scope_key` is in its
  APPLICABLE SET — `space`, `user:me`, `session:me:<sid>` — the
  shape main already computes for the observation path
  (`packages/memory/v2/server.ts:185-201`,
  `schedulerApplicableContextKeys`). The commit's remaining rows are
  invisible to that subscriber: not redacted, not empty — absent.
  This pairs with scopes.md §7 M4's re-keying: the push path must
  key dirtiness by `scope_key`, and the same key decides delivery.
- **Basis-index rows are NOT part of the pushed commit** (T2). They
  ride the loopback store TRANSACTION only (serving-loop.md §1 plane
  (a), §3b); nothing about them crosses the wire to a subscriber,
  and admission never reads them.
- **Push priority** (Phase 6 hardening, but the contract is fixed now):
  when flushing a batch to a client socket, `derived` commits touching
  docs that client subscribes to go first; everything else follows.
  Bookkeeping MUST NOT ride the commit stream at all (lease renewals are
  table updates; watermarks piggyback on derived commits), so in practice
  priority is about big authored blobs vs small derived values.
- Self-echo: SpaceServer skips its own `derived` commits on receipt
  (serving-loop.md §3).

## 4. The watermark

- Definition (sharpened by the 2026-08-02 demand ruling): `W(space)` =
  highest seq such that every authored commit ≤ W has all handler
  consequences committed AND all DEMANDED derivations current through
  W (demand per serving-loop.md §1/§3b — undemanded derivations stay
  dirty-unmaterialized without holding W back).
- Carried: in every `derived` commit's metadata (`derivedThrough: W`) and
  in one well-known doc per space (updated in the same transaction; never
  its own commit).
- Client use: "settled" for a client = `W ≥ seq(my last authored
  commit)`. Integration tests MUST wait on this instead of text-polling
  (testing.md §3). Sync indicators read the same signal.
- W covers DEMANDED derivations (pull-based laziness, serving-loop.md
  §3b). Client subscriptions are demand, so a fresh subscription
  arriving after W may still trigger a recompute, whose results land in
  a later derived commit.
- The watermark is ONE integer per space. Not per-doc, not per-piece, not
  vectorized. If a consumer seems to need a finer watermark, escalate
  before building it.

## 5. The client-effect channel (Phase 4)

Session-scoped, server-computed, client-enacted effects (README §3.7).

- One doc per session, addressed as a SESSION-SCOPED INSTANCE — not
  a path convention (T9, RULED here; owner-notable, it changes this
  section's addressing). The effects doc is one well-known doc id
  whose per-session instances are keyed by `scope_key`
  (`session:<principal>:<sessionId>`) exactly like every other
  session-scoped instance (scopes.md §Anchors). A path form
  (`session/<id>/effects`) was the earlier draft and is REJECTED: it
  would make the effects doc the one session-lifetime thing NOT
  instanced by `scope_key`, and scopes.md §3 promises ONE retirement
  rule for both. One doc id constant, exported once; the instance
  comes from the key, never from the path.
- **Write authority for the ack** is the owning session's own scope
  instance: the session writes its `{ ackedNonce }` into the
  instance its authenticated `scope_key` resolves to, so no session
  can ack another's intents and no new ACL is needed. The
  SpaceServer writes the intents into the same instance by naming
  the `scope_key` explicitly (§1 addressing).
- Shape: append-list of
  `{ nonce, kind, args, issuedIn: <derived commit seq> }`;
  v2 ships exactly one kind: `navigate` with
  `args = { target: <entity link> }`.
- The SpaceServer writes intents as part of ordinary derived commits
  (navigateTo's output). The session's client subscribes to its own
  effects doc, enacts, then commits an authored ack write
  `{ ackedNonce }`; the next wave retires acked entries.
- Exactly-once enactment per nonce is the CLIENT's duty (it may enact
  optimistically from speculation, then reconcile by nonce — navigation
  is reversible). Reload between intent and ack: on resubscribe the
  client sees unacked intents and enacts them; nonces make re-enactment
  detectable.
- Session lifecycle: `sessionId` is minted at client connect, persisted
  client-side across reloads, and retired explicitly on logout or by
  TTL. Effects docs are session-lifetime: a dead session's unacked
  intents retire with its effects doc — which, being a session-scoped
  instance, is retired by the SAME session-data GC as every other
  session instance (scopes.md §3, §8 item 2). One mechanism, as
  scopes.md §3 already claims.

FORBIDDEN: new kinds without a spec edit here; a push channel outside the
doc/subscription model; server-side retries of enactment.

## 6. Streaming (deferred, boundary fixed)

Settled-result-only commits are the v2 baseline; the interim loss of
LLM token streaming under the flag is ACCEPTED (owner, 2026-08-02).
If/when LLM partials ship, they use an ephemeral session channel
OUTSIDE the commit stream — partials never become commits, never touch
the watermark, never wake the serving loop. `stream-data` stays
disabled (README §3.5).

## 7. Wire-shape discipline

- Commit metadata additions in v2, complete list: `class`, `holder`
  (derived only), `derivedThrough` (derived only), `consequenceOf`
  (derived only), `eventId`/`firedAt` (event appends),
  `actingPrincipal`/`capabilityRef` (server-produced authored commits
  only — §2); plus, WITHIN a derived commit's body, the ADDRESSING
  and ATTRIBUTION pair §1 defines — never envelope identity (R-Q6b):
  the explicit `scope_key` on every scoped write (addressing) and
  the acting identity on every action RUN's writes, where the run
  has one — §1 (attribution,
  `action × instance`). Anything further needs a spec edit here
  first.
- **`scope_key` is thereby PROTOCOL vocabulary**, no longer
  engine-internal vocabulary: it appears inside derived commit
  bodies and on lease-holder reads, so its format is defined ONCE
  in the wire-shape module (`packages/memory/v2.ts`, beside
  `CellScope` and `SessionId`) and imported by engine and runner
  alike — the LD3 ruling, key-vocabulary.md §3.
- **`eventId` and `firedAt` are ENVELOPE fields for admission** (T8),
  not payload: admission reads them (`eventId` for the uniqueness
  CAS above the dedupe horizon, `firedAt` because the server STAMPS
  it from the authenticated envelope — §2). events.md §1 states the
  same classification; if the two ever disagree, this section and
  events.md §1 are the pair to reconcile, and neither is a payload
  claim.
- **A read may name an `entity_scope_key`** (S1, §2's read row;
  ledger LD5 ratified 2026-08-03 — the read half of §1's
  transaction identity model). That is the only read-side addition
  to the wire: one optional field on the read, admissible only for
  the space's live lease holder. Reads that name nothing are
  unchanged.
- Basis-index rows (serving-loop.md §3b) ride INSIDE the derived
  commit's store TRANSACTION as engine table rows — sanctioned
  carriage, NOT metadata and NOT part of the commit representation:
  nothing about them crosses the wire (§3 excludes them from push),
  admission never reads them, and the closed list above is not
  breached by them.
- All metadata is small and fixed-shape, with one bounded carve-out:
  `consequenceOf` scales with the wave's INPUT (the events drained that
  wave), never with graph size. The v1 failure mode — 130 KB of
  serialized read links per record — is structurally impossible if this
  list is respected. A metadata field that scales with GRAPH size is
  FORBIDDEN.
- Writes inside a `derived` commit keep PER-ACTION-RUN provenance for
  CFC label purposes (serving-loop.md §3c), carried in the write
  PAYLOAD, never as commit metadata: the commit is a transport batch,
  never a label boundary. R-Q6b's attribution (§1) rides at the same
  granularity — acting identity per action RUN (`action ×
  instance`), with the `scope_key` per scoped write doing the
  separate ADDRESSING job — attributed, not signed, today; when
  per-user delegated keys exist (anticipated, not built),
  attribution graduates to acting-key signatures without changing the
  envelope model.
