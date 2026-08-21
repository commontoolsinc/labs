---
status: historical
created: 2026-08-21
archived: 2026-08-21
reason: "Optimize-phase build report: the OW31 ruled write+read identity posture — genesis under the space's own keys naming the acting user OWNER, service-principal writes into user home spaces refused, ACL-only service reads with every other served read under the acting user, and the S-A compile-cache carriage arm. Incremental; carries the FLAGGED questions."
---

# OW31 build report — the ruled write+read identity posture

Builder: OW31 BUILD agent. Worktree `/Users/berni/labs-worktrees/ow31-identity`,
branch `claude/server-exec-v2-ow31-identity` off `origin/main` @ `ce92b445f`.
Started 2026-08-21. Status: **IN PROGRESS** (this file is written incrementally).

Authoritative inputs (read in full before building):

- Register row: `docs/specs/server-side-execution/verification-coverage.md`
  "OW31 — the service-principal READ-AUTHORITY grant" (the ruling verbatim,
  findings i–iv, build pins, acceptance gates; WRITE ruled 2026-08-18,
  READ ruled 2026-08-19 — ACL-only service reads, superseding the scope
  report's read-only-service-class recommendation).
- Work order: `docs/history/plans/server-execution-v2/stage-c/stage-c-ow31-scope-report.md`
  (B0–B7, flags F1–F10) — read against the READ-side supersession.
- Specs: `docs/specs/server-side-execution/protocol.md` §2/§2b,
  `docs/specs/server-side-execution/serving-loop.md` §3b/§3d.
- S-A seat evidence: `docs/history/plans/server-execution-v2/stage-c/on-render-stall-rootcause.md`
  §1 (17 `seal-space-commit-failed` compile-cache writeback refusals per
  profile space).

## Plan of record

1. **B0/B3 — genesis owner = acting user** (`registerSpaceIdentity(identity, { owner })`,
   threaded from serving-side `resolveSpaceName`; serving runtime with no
   actor REFUSES; client shape byte-identical).
2. **B4 — ordering + INV-13 mirror at the sink** (genesis forced before a
   creation-granted foreign batch; sink refuses a foreign batch into a
   seq-0/no-ACL engine; kill/replay convergence).
3. **READ posture (ruled 2026-08-19)** — remove the OWNER blanket; service
   identity reads a space's ACL ONLY; every other served read under the
   acting USER's identity. Escape hatch: cases user-identity routing cannot
   cover are FLAGGED, not blanket-kept.
4. **B5 — "the service principal cannot write into a user home space"** pins.
5. **S-A — §2b delegated carriage for `compile-cache/writeback/<patternIdentity>`**
   into the piece's own space; if no acting user is attributable at
   writeback time, FLAG with the system-class alternative (do not choose it).
6. **B6 — acceptance gates** (served-wish + lunch live gates; observe-mode
   canary; store dump).
7. **B7 — spec/register edits** (protocol.md §2b mechanism sentence;
   OW31 row RULED → BUILT with evidence).

## Design of record (settled after the code read, before building)

### READ posture — the mechanism for "every other served read runs under
### the acting USER's identity"

The naive mechanism — open the loopback session AS the user — is
impossible (loopback sessions present REAL signed `session.open`; the
serving runtime holds no user keys) and would dismantle the read-row
machinery (`#denyExplicitInstanceReads` / `#currentLeaseHolderExemption`
key on `executionLeaseHolder(session.principal)`; the scoped-read
resolution keys on `#sessionScopeIdentity(session)` = the envelope).
The built mechanism is a SESSION-LEVEL delegated binding, mirroring the
write posture's carriage exactly as the register row words it:

- `session.open` gains an optional `actingAs: "space-owner"` marker in
  the session descriptor (signed into the invocation like the rest of
  the descriptor). Only the serving StorageManager sends it (gated on
  `servingHomeSpace !== undefined` — the serving-manager marker that
  already gates the foreign-scoped-read refusal). The bootstrap session
  (signs as the SPACE) never sends it.
- The memory server admits the marker only for an envelope principal in
  a NEW flag-gated class `acl.delegatingDids` (ON: the process
  identity; OFF: empty) — the LT5 trust footing (the co-hosted process
  is already trusted for carried actor claims on the write plane). A
  non-delegating envelope sending the marker is refused loudly. In
  `off` ACL mode the marker is inert (off preserves historical
  behavior).
- The server then resolves the binding ITSELF from the space's ACL —
  THIS is the ruled "ACL can be read with service identity", exercised
  server-side on the delegating principal's behalf: a valid ACL with a
  concrete OWNER binds `session.actingPrincipal` := that owner (the
  space DID itself when self-owned — every home space; else the sorted
  first concrete owner). Missing/fresh/invalid ACL → no binding; the
  envelope's own (blanket-free) capability applies (fresh → READ,
  legacy-populated → WRITE, malformed → deny — today's rules).
- READ-class requirements (session.open, queries, watches, sqlite
  reads) resolve capability for `actingPrincipal ?? principal`.
  WRITE/OWNER-class requirements (transact, ACL-doc writes,
  disk-source registration) resolve against the ENVELOPE principal
  only — the serving identity gains NO write path from the binding
  (conservative composition of the two rulings; see FLAG-2).
- Revocation (`#revokeDeauthorizedSessions`) judges the effective READ
  principal, so an ownership change revokes the bound session and the
  next mount re-resolves the new owner.
- Everything keyed on `session.principal` for lease/wire/scope purposes
  is untouched: the read row, the lease exemption, the wire vocabulary,
  `#sessionScopeIdentity`.

Why this is the ruling and not a re-minted blanket: the binding grants
READ exactly where SOME user's ACL grant covers it, attributes those
reads to that user, and is refused everywhere else (owner-only spaces
whose owner is not resolvable stay denied — the escape-hatch surface).
The old blanket (implicit OWNER everywhere for the process identity's
sessions) is REMOVED: `memoryServiceDidsFor` becomes
`memoryAclPrincipalsFor` returning `{serviceDids: configured verbatim,
delegatingDids: flag-gated}`; the operator OWNER-class list keeps its
semantics (F1), and the process identity is no longer in it by default
under ON.

### WRITE posture — B3 genesis + B4 ordering, as scoped

- B3: `registerSpaceIdentity(identity, { owner? })`; the bootstrap ACL
  non-home arm becomes `{ [owner ?? signer.did()]: "OWNER", "*":
  "WRITE" }` (home arm untouched). `Runtime.resolveSpaceName(name,
  { owner? })`; `resolvePendingSpaceNamesAndRetry` reads the acting
  principal from the frame tx's wave-run context WITHOUT the
  read-scope-ratchet side effect (scope report F8) and REFUSES on a
  serving runtime with no actor. Clients pass no owner → byte-identical
  (the client's `as` IS the user, which is why the client shape was
  already right).
- B4: the wave retains the grant probe's `via` per (space, acting) —
  `foreignWriteGrant` now returns the full verdict — and the commit
  step, after `#resolveForeignEngines`, forces
  `storageManager.ensureSpaceInitialized(P)` for every
  creation-granted foreign target BEFORE the sink applies. The sink
  refuses a foreign batch into an engine with `serverSeq === 0` and no
  ACL doc (INV-13 mirrored on the engine-direct plane,
  `WaveCommitRejected` → foreign failure ⇒ home withheld ⇒ replay).
  Replay converges (actor and keys are functions of the creation
  event; the re-probe resolves `acl` via the owner once the genesis
  exists).

### S-A — compile-cache writeback carriage

The observed defect (render-stall §1): `compile-cache/writeback/<id>`
runs in the HOME space's wave stamped `bookkeeping` (no acting, no
carriage) and its writes into the provisioned space P are refused at
accumulation — 17 refusals per profile space (= 1 + the 16-retry
budget of `writeBackCompileCache`). The carriage arm IS buildable: the
trigger (`instantiatePatternNode` → `replicatePatternToSpace`, CT-1687)
has the provisioning run's tx in scope, whose wave-run context carries
the acting user + capabilityRef — the SAME carriage the `.inSpace()`
data batch (W3) rides. The client precedent is exact: on the client the
program materialization is committed by the USER's own session (the
Grace store dump, seq 4). Built shape:

- `ServerRunInfo` gains `delegated?: { acting, capabilityRef }` — an
  explicit §2b carriage for a bookkeeping-kind internal write
  sanctioned to cross (the compile-cache/program materialization
  family). `#stampRun` applies it verbatim for bookkeeping runs; the
  wave's conflict machinery keeps treating the contribution as
  bookkeeping (rebase-or-drop; editWithRetry re-issues).
- The carriage is attached ONLY when the writeback target is FOREIGN
  to the serving manager's home space (a new readonly
  `servingHomeSpace` accessor); home-space writebacks and every client
  writeback are byte-identical.
- Threaded through `replicatePatternToSpace` →
  `replicateClosures` → `persistCompileCacheTracked` →
  `writeBack{Source,Compile}Cache`. The `loadPatternByIdentity`
  repair path and `compilePattern` main persist attach it where a
  wave-run context is reachable at their triggers; where none is, the
  foreign write stays refused (fail-closed) and any live-gate residual
  is FLAGGED rather than blanket-exempted.

### Adjacent work, checked

- PR #6074 (writer-fit residency: a document's own space principal) —
  CFC `prepare.ts` + CFC specs only; disjoint from every file this
  build touches (memory server ACL, storage v2 bootstrap, wave/sink/
  space-server, toolshed flag, pattern-manager). Conceptually parallel
  (space-as-container audience), no code conflict. Same for #6077 and
  #6095 (cfc/prepare.ts family).
- #6121 FabricKeyPair (landed): a fabric PRIMITIVE for carrying key
  material as a value. The genesis work stores no key material and
  mints no new key-pair shape — it threads an owner DID beside the
  existing in-memory `Signer` registration. Not applicable; no parallel
  shape minted.
- #5744 (lunch-poll identity by profile cell): pattern-level; no code
  overlap; noted for the lunch acceptance gate's semantics.

## Progress log

- 2026-08-21: worktree verified clean at ce92b445f; register row, scope
  report, protocol §2/§2b, serving-loop §3b, render-stall §1 read in full.
  Report skeleton committed. Code reading next.
- 2026-08-21: full code read done (memory server ACL + session registry +
  read row; storage v2 bootstrap + provider model; loopback factory;
  wave accept gate + delegatedFor + batch builder; sink; space-server
  stamper + commit step; runner resolvePendingSpaceNames;
  pattern-manager writeback chain; toolshed flag + bootstrap). Design of
  record written (above). Adjacent PRs checked. Building slice 1 next.
- 2026-08-21, slice 1 (B0+B3) LANDED (4c4b0a9f2): genesis owner = the
  acting user. RED WITNESSED: the new bootstrap pin failed with
  `{ [service]: "OWNER", "*": "WRITE" }` before the fix (the B0
  observation, run logged in the test comment). `registerSpaceIdentity`
  gains `{ owner }`; the bootstrap's non-home arm names it; the serving
  runtime with no actor refuses `resolveSpaceName`; the acting principal
  is read from the frame tx's wave context acting-first (matching the
  write carriage — the grant probe keys on `acting.user`, so the genesis
  owner MUST be the same principal or replay's acl arm would probe a
  stranger), without the ratchet side effect (F8). Client byte-identical
  (its `as` IS the user — why the client shape was already right).
- 2026-08-21, slice 2 (B4) LANDED (8c71b7725): genesis-before-data. RED
  WITNESSED: the INV-13 sink pin watched a delegated foreign batch land
  in a fresh (seq-0, no-ACL) store before the fix. The wave retains the
  grant `via` per (space, acting); the commit step forces
  `ensureSpaceInitialized` (the provider mount's own bootstrap — an
  in-process round trip, idempotent) for creation-granted targets; the
  sink refuses seq-0/no-ACL foreign batches. Kill/replay pins converge
  on ONE user-owned ACL; the executor pin also carries the
  actor-=-space / owner-=-acting-user / service-nowhere /
  commit-#1-is-the-ACL shape. Three pre-existing wave/outbox tests that
  committed foreign batches into fresh engines now seed the genesis the
  production ordering provides (an honest contract update — the old
  behavior WAS the INV-13 bypass).
- 2026-08-21, slice 3 (READ posture) LANDED (17df0a6a7): the OWNER
  blanket is retired. `memoryServiceDidsFor` → `memoryAclPrincipalsFor`
  ({serviceDids: operator verbatim BOTH arms; delegatingDids: ON →
  process identity, OFF → empty}; the absolute not-OWNER-class pin).
  Session-open carries `actingAs: "space-owner"` (typed into
  SessionDescriptor + MountOptions, signed via the descriptor,
  compared by `sameSessionDescriptor`, parsed by the wire whitelist,
  carried across reopen); the server admits it for delegating-class
  envelopes only, resolves the space's concrete ACL owner itself, binds
  `SessionState.actingPrincipal`; READ-class requirements resolve as
  acting ?? envelope, WRITE/OWNER stay envelope-only; revocation judges
  the acting user; delegating principals cannot initialize genesis;
  the lease/read-row/scoped machinery (all keyed on `session.principal`)
  untouched. Six new memory ACL pins + the executor-level R2 acceptance
  (a serving manager reads an owner-only home space under enforce; the
  same identity without the marker is denied). RED WITNESSED by
  mutation: disabling `#resolveSpaceOwnerBinding` fails the owner-read
  and revocation pins (2 red / restored 36 green).
- 2026-08-21, slice 4 (seat S-A) LANDED (f0dc3e261): the cross-space
  compile-cache writeback rides the TRIGGERING run's delegated carriage.
  `ServerRunInfo.delegated` (explicit carriage for the bookkeeping-kind
  materialization family), applied verbatim by `#stampRun`; threaded
  `replicatePatternToSpace` → `replicateClosures` → persist → writeback,
  attached only for targets FOREIGN to the serving home space (new
  `servingHomeSpace` accessor); the trigger (`instantiatePatternNode`,
  CT-1687) supplies it from the run tx's wave context. End-to-end pin
  through a REAL activated SpaceServer: carriage-less replication
  refused (the render-stall 17-refusal class, kept as the fail-closed
  pin) and delegated replication lands in the provisioned space with
  `acting_principal` = the user. RED WITNESSED by mutation: disabling
  the stamper's delegated arm fails the pin.
- 2026-08-21, slice 5: spec/register edits (protocol.md §2b mechanism →
  the BUILT posture; serving-loop.md §3b bullet; builtins.md §5
  read-authority paragraph; verification-coverage.md OW31 row → BUILT
  with evidence + the closeout bullet re-tensed + OW45's S-A seat marked
  built-on-the-carriage-arm); the two ON-skip reason texts updated
  (entries NOT removed — joint lift with OW45/OW47 stands). Suites run:
  memory full (558), runner executor family (wave 43, cross-space 11,
  serving-loop+outbox+no-op 43+18, space-server/events/watermark/settle
  39, fan-out/run-supply/instance-keyed/dprime 39, effect-channel/
  cooperative-yield/outbox-budget 23), storage bootstrap+mutation 26,
  toolshed flag+serving 11. Lint + fmt clean on all 91 changed files.
  (toolshed lib's build-info/clone-banner/configure-open-api/clientKey
  failures are pre-existing local-env dependences — ENV=test + .env.test
  — unrelated to this diff; CI's lanes carry them.)
- 2026-08-21: **PR #6156 opened** (3bd0f41a4 head at open). Adversarial
  self-review of the merge-base diff done as the reviewer: verified the
  true change set is the 27 intended files (the two-dot diff against the
  moved main misleadingly showed main-side test-records churn — three-dot
  is clean); walked the memory-server hunks (challenge-consumption order
  matches the existing deny path; the binding is per-open and never
  inherited on resume; the capability cache keys the acting principal;
  hard refusal under observe is precedented by the genesis-invariant
  posture); the wave's `via` retention may force genesis for a withdrawn
  crossing (idempotent, converges on replay — noted); the sink's INV-13
  check sits behind the sqlite refusal and ahead of the carriage check
  (either refusal is fail-closed; the ordering keeps the existing
  carriage pin meaningful). The full runner suite runs locally under its
  canonical task (clock preload) in parallel with CI; CI's ON lanes are
  the live acceptance carrier. MEMORY_ACL_MODE defaults to `enforce`, so
  the ON lanes exercise the binding for real; the OFF lanes' session
  plane was always blanket-less, which bounds the W7 regression class to
  flows that differ under ON (the serving loop's own, wave-carried).

## FLAGGED questions (running list)

- **FLAG-1 (design decision recorded, conservative reading): the
  "ACL-only read" allowance is implemented as the server-side owner
  resolution at `session.open`, not as a separate ACL-doc-only query
  surface for the service identity.** The ruling permits service-identity
  ACL reads; the build exercises that permission exactly where the
  serving plane needs it (learning who a space's owner is, to bind the
  acting user). No runner flow needs a raw ACL-doc query surface, so
  none was built (smaller surface; permissive clause, not a mandate).
  If a later need appears (diagnostics on malformed-ACL spaces), it is
  a follow-up, not a silent widening.
- **FLAG-2 (design decision recorded, conservative composition): an
  acting-bound serving session resolves READ-class requirements as the
  user and WRITE/OWNER-class requirements as the envelope (the service —
  i.e. refused).** The READ ruling covers reads only; the WRITE ruling
  routes every served write through the wave's delegated carriage. A
  session-plane write admitted "as the user" via the binding would
  bypass the wave's accept gate — neither ruling sanctions that, so it
  stays closed and the observe canary keeps counting any residual.
- **FLAG-3 (for the owner's eye, carried from the scope report's F2,
  now pinned live): the `"*": WRITE` wildcard on minted spaces still
  means "the service cannot write P" does NOT follow from this build.**
  The executor mutation pin shows it concretely: a genesis whose owner
  is mis-threaded to bob still GRANTS alice's replay via the wildcard's
  acl arm. "The user is OWNER, the service is not" holds everywhere;
  narrowing the wildcard is the separate policy question the register
  row already carries.
- **FLAG-4 (residual, fail-closed, named follow-up): the
  `loadPatternByIdentity` repair writeback and `compilePattern`'s own
  persist do not carry the S-A carriage** — no wave-run context is
  reachable at those triggers today (they run in detached async compile
  flows fanned from many callers). Their FOREIGN-target case stays
  refused exactly as before this build; the observed defect class (the
  create-flow replication, 17 refusals per profile space) is the
  replicate trigger, which is covered. If the live gates surface
  residual `compile-cache/*` foreign refusals from the repair path,
  thread the demanding run's context there — do not exempt.
- **FLAG-5 (residual discovered during the build; NOT closable by this
  build's rulings): CFC authorship labels on served rows still carry
  the SERVICE signer.** cfc-group-chat-demo's CI shape
  (`authored-by`/`represents-principal` naming the service DID) comes
  from the runtime-level CFC trust snapshot —
  `Runtime.trustSnapshotProvider` defaults to
  `storageManager.as.did()`, attached per tx at `edit()` — NOT from the
  memory-plane commit carriage this build landed. Making CFC
  attribution per-run (the acting user) touches trust-revision keying
  and prepared-digest invalidation — a CFC-owner seam (the OW34 family),
  flagged rather than filled. The group-chat skip entry's reason now
  says so; that skip does NOT lift on this build alone.
- **FLAG-6 (transient, converges): the compile-cache write slot dedup
  can coalesce a carriage-bearing replication into an in-flight
  carriage-less one** for the same (space, entry, runtimeVersion); the
  predecessor's refusal rejects, the caller logs
  `closure-replication-failed`, and the next child-creation retry
  re-runs with the carriage (the slot cleared on settle). Noted, not
  wired around: the retry semantics are the existing CT-1687 contract.
- **Escape-hatch status (the READ ruling's own provision): NOT
  exercised.** No case surfaced during the build where user-identity
  routing could not cover a legitimately-needed serving read: home
  spaces bind their owner (== the demanding user in every sanctioned
  flow), provisioned spaces carry the wildcard, fresh/legacy spaces
  keep today's arms. The one structurally-unreachable class — an
  owner-only space whose ACL was hand-narrowed away from any resolvable
  owner while the serving loop must derive it — would deny loudly and
  is exactly the flag-for-follow-up shape, none observed.
