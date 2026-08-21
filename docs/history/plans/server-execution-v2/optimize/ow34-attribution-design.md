---
status: historical
created: 2026-08-21
archived: 2026-08-21
reason: "OW34-family DESIGN (for owner ruling; no implementation in this PR): per-run CFC trust attribution for served execution — the FLAG-5 seam where served rows' authored-by / represents-principal labels name the SERVICE signer because the runtime-level trust snapshot (storageManager.as) is attached per-transaction at edit(). Mechanism verified against code with anchors; options per section; ONE recommended design (stamper-attached per-run snapshots, label semantics = the acting user, OFF byte-identical, fresh-store migration); invariants as testable pins; acceptance = the cfc-group-chat-demo ON lift + store-dump label audit. Gates the ON flip (the skip list must be EMPTY)."
---

# OW34 attribution design — per-run CFC trust for served execution

Author: OW34 DESIGN agent. Worktree `/Users/berni/labs-worktrees/ow34-design`,
branch `claude/server-exec-v2-ow34-design` off `origin/main` @ `59cde49ef`.
Date: 2026-08-21. Status: **design for ruling** — the owner rules on this
document before any implementation train starts. This is a design pass; the
branch carries this document and nothing else.

Register anchors: OW31's residual (iii) (verification-coverage.md §3 — "CFC
AUTHORSHIP LABELS on served rows still carry the SERVICE signer … per-run CFC
attribution is a CFC-owner seam (OW34's family), flagged rather than filled"),
the OW31 build report's FLAG-5
(`optimize/ow31-build-report.md`), and the `cfc-group-chat-demo` ON-skip
entry (`tasks/server-execution-on-skips.ts`), whose lift condition names
exactly this seam. Evidence base:
`stage-c/on-render-stall-rootcause.md` §2a (the store dump: authored-by ×4,
represents-principal ×2, all the service DID) and
`stage-c/first-on-ci-gate.md` row 2.

## Why

Under ON, a served run's durable consequences carry CFC authorship labels
naming the SERVICE signer, not the acting user. The observable defect:
`cfc-group-chat-demo`'s authorship verification stays `"unverified"` forever
on served rows (the first-ON-CI-gate row-2 shape), so the file is ON-skipped
— and the flip PR requires the skip list EMPTY, which makes this seam a
lift-blocker for the flip.

The deeper defect is worse than one red test: with every trusted row and
every profile labeled by the one service DID, the authorship-verification
security property collapses to a tautology. The demo exists to prove that a
forged authorship claim does NOT verify; on an all-service-labeled store,
any trusted-sent message pairs with any profile — both carry the same
subject — so the verifier would certify a lie whenever the durable copies
happen to line up, and reject honest rows whenever the client's speculative
(user-labeled) copy and the durable (service-labeled) copy are compared
across the seam. The labels must carry the acting user for the verification
to MEAN anything.

The authorization plane is already per-run correct: OW31 (merged 2026-08-21,
`9d989c0c1`) landed genesis-names-the-user, ACL-only service reads, served
reads under the acting-as-owner binding, and §2b delegated carriage on
served writes (`ServerRunInfo.delegated`). The identity IS at the seam —
`ServerRunInfo.acting` for handler runs, `scopeKeyIdentity` for demanded
derivations, `delegated.acting` for the sanctioned bookkeeping crossings.
What was never plumbed is the CFC **label/trust** mechanism: the trust
snapshot that resolves `__ctCurrentPrincipal` placeholders at commit-prep is
still the runtime-level ambient default, and on a serving runtime the
ambient identity is the service. On a client, ambient identity == the user,
which is why labels were correct for free before ON. This document designs
the plumbing — and only the plumbing — that closes FLAG-5.

## 1. The mechanism, as verified (all anchors re-read on `59cde49ef`)

Every claim below was verified against code in this worktree, not carried
from the build report.

### 1a. The snapshot: one shape, one writer, attached per-tx

- `TrustSnapshot = { id: string; actingPrincipal?: string; revision?: string }`
  — `packages/runner/src/cfc/types.ts:380-384`.
- The DEFAULT provider closes over the runtime's ambient identity:
  `actingPrincipal = options.storageManager.as.did()`, `id =
  "principal:<did>"`, `revision = <runtime id>` or
  `<runtime id>/trust:<cfcTrustConfig.digest>` — `runtime.ts:1318-1326`.
  The runtime id is `storageManager.id` (`runtime.ts:1261`), which is
  `options.id ?? crypto.randomUUID()` (`storage/v2.ts:892`) — a per-process
  value.
- The snapshot is attached to every transaction at `edit()`:
  `wrapped.setCfcTrustSnapshot(this.trustSnapshotProvider())` —
  `runtime.ts:1945`. That call is the snapshot's ONLY production writer;
  `setCfcTrustSnapshot` (`storage/extended-storage-transaction.ts:1212-1217`)
  stores it on the tx's CFC state and, if the tx were already prepared,
  invalidates with reason `"trust-snapshot-changed"`. Tests already vary
  the snapshot per-tx through this public setter
  (`runner/test/profile-owner-cfc.test.ts:134-149` — `setTrustedProfileWriter`
  sets a per-tx `{id, actingPrincipal}`), so per-tx snapshots are an
  exercised, supported shape today; what does not exist is a production
  path that sets a NON-ambient one.
- The serving runtimes are constructed with NO `trustSnapshotProvider` and
  NO `cfcTrustConfig` (`toolshed/lib/server-execution.ts:144-183`), so every
  serving-side transaction carries `actingPrincipal = <service DID>`. The
  presets classify `trustSnapshotProvider` as a delta for `remoteClient` and
  `browserWorker` only (`runtime-presets.ts:92,163`); the browser worker's
  provider serves the WORKER'S OWN USER from `InitializationData`
  (`runtime-client/backends/runtime-processor.ts:300-302`) — every custom
  provider in the tree is a client-side user identity, never a per-run one.

### 1b. Where labels mint: placeholder resolution at commit-prep

- The authoring vocabulary: `CurrentPrincipal = { __ctCurrentPrincipal:
  true }`, `AuthoredByCurrentUser<T>` = `addIntegrity [{kind: "authored-by",
  subject: CurrentPrincipal}]`, `RepresentsCurrentUser<T>` likewise —
  `packages/api/cfc.ts:826-841`. The group-chat pattern uses exactly these
  (`patterns/cfc-group-chat-demo/trusted.tsx:48-55,83-90`), and the SYSTEM
  profile pattern layers `ownerPrincipal: CurrentPrincipal` on top
  (`patterns/system/profile-home.tsx:29-37`).
- Resolution happens inside `prepareBoundaryCommit` (reached via
  `prepareCfc()`, ext-tx:1710-1801): `derivePersistedLabel`
  (`cfc/prepare.ts:3881-3937`) reads
  `tx.getCfcState().trustSnapshot?.actingPrincipal` (line 3889) and
  `resolveCurrentPrincipalLabelValues` (prepare.ts:396-412) substitutes the
  placeholder with that principal. The resolved atoms persist into the
  written doc's `["cfc"]` label map inside the SAME transaction (privileged
  persistence; ext-tx:1717-1721). With an UNDEFINED acting principal a
  placeholder-carrying label value is DROPPED (prepare.ts:403-410) — and the
  gated families separately refuse: `currentPrincipalIntegrityReason`
  (prepare.ts:2371-2469) fail-closes any placeholder mint that lacks a
  snapshot, an acting principal, `writeAuthorizedBy`, or `uiContract`, and
  REJECTS literal-DID current-principal claims outright ("current-principal
  integrity subject must be runtime resolved", prepare.ts:2433-2437).
- Consequence (verified against the store evidence in rootcause §2a): a
  served trusted-send handler run resolves `authored-by` /
  `represents-principal` with the SERVING runtime's snapshot — the service
  DID — which is precisely the observed `did:key:z6MksHnZ…` ×6 on Alice's
  message commit and on the profile entity's labelMap.
- Structural note that bounds the blast radius: because the non-owner
  placeholder arm requires BOTH `writeAuthorizedBy` and `uiContract`
  (prepare.ts:2458-2467), and `uiContract` satisfaction requires a
  renderer-trusted EVENT (the OW34 sister-mark carriage, events.md §2),
  **current-principal labels can only ever mint inside trusted-event
  handler transactions and builtin-authored owner writes** — never from a
  plain derivation. This is what makes the derivation arm of this design
  behaviorally inert today (§2, §10 Q2).

### 1c. Other consumers of the tx snapshot (the full set)

`tx.getCfcState().trustSnapshot` is consumed at exactly these sites, all
inside the runner:

- `derivePersistedLabel` — the mint (1b).
- `currentPrincipalIntegrityReason` — the gate, including the
  `ownerPrincipal` arm which requires `actingPrincipal === ownerPrincipal`
  after placeholder resolution (prepare.ts:2400-2427).
- `writeAuthorizedByReason` — requires snapshot presence (id +
  actingPrincipal) before any writeAuthorizedBy claim verifies
  (prepare.ts:534-537). Note the verification itself binds the
  IMPLEMENTATION identity, not the principal — the snapshot is a
  present-and-authenticated floor here.
- `cfcFloorTrustContext` — concept-valued `requiredIntegrity` floors
  evaluate under the acting principal's trust closure (prepare.ts:3347-3355,
  observation.ts:179-235).
- Exchange-rule evaluation — `actingPrincipal` in the evaluator context
  (prepare.ts:4712-4720, exchange-eval.ts:164).
- `writeCfcGrant` — the grant's release-authority owner is the tx's acting
  principal, read MID-RUN at the write call (ext-tx:1354-1357), and grant
  revocation authority compares against it (grants.ts:391-461).
- The prepared-digest input — the snapshot is bound VERBATIM
  (ext-tx:1558 → `canonicalizePreparedDigestInput`, cfc/canonical.ts:437).

Separate from the tx snapshot, two builtin families call the RUNTIME-level
provider directly, mid-run: the sqlite builtins (db-owner mint at handle
creation, clearance-reader keying, ceiling placeholder resolution —
`builtins/sqlite-builtins.ts:555-557,753-756,858-882`) and llm-dialog
(`builtins/llm-dialog.ts:2371`). These are OW53's adjacent territory and are
NOT in this design's scope (§7), but the design's substrate — a per-run
snapshot on the tx — is exactly what a future OW53 fix would re-point them
at.

### 1d. The serving seam: what identity each run carries, and when

- The scheduler mints one tx per action run via `runtime.edit()` and
  IMMEDIATELY stamps it — before the run body executes a single read — at
  its two choke points: event dispatch (`scheduler/events.ts:1187-1268`;
  `served.firedAt.user` → `info.acting`) and reactive actions
  (`scheduler/run.ts:508-542`; a fanned-out instance carries
  `scopeKeyIdentity` + `actionScopeKey`). `Runtime.stampServerRun`
  (runtime.ts:2091-2104) forwards to the SpaceServer's `#stampRun`
  (`executor/space-server.ts:1422-1499`) when a stamper is installed — i.e.
  exactly on a serving runtime with a live wave — and to the speculation
  stamp on flag-ON clients; the OFF arm is one undefined check.
- `ServerRunInfo` (runtime.ts:353-425) carries, per run: `acting` (the
  event's server-stamped `firedAt` actor — handler runs), `scopeKeyIdentity`
  (the demand-supplied principal — derivation runs), and `delegated` (the
  OW31 S-A §2b carriage — the sanctioned bookkeeping crossings). The
  bookkeeping writeback stamps happen INSIDE `editWithRetry`'s fn
  (`pattern-manager.ts:2074-2098,2183-2200`), so every retry attempt
  re-stamps its fresh tx — a per-run snapshot attached at the stamp seam
  inherits retry-safety for free.
- Timing, which forces the seam choice: `writeCfcGrant` reads the snapshot
  MID-RUN (1c), so the snapshot must be attached BEFORE the run body — a
  prepare-time-only fix is structurally insufficient. CFC prepare runs at
  commit kickoff (`Runtime.prepareTxForCommit`, runtime.ts:2345-2390) and
  at the commit chokepoint (ext-tx:2270-2371), both BEFORE the wave seal;
  `settleScopeAttribution` — which derives a derivation's memory-plane
  acting from its DISCOVERED scope — runs inside `seal()` (wave.ts:898-989,
  settle at 938), AFTER prepare. So a derivation's settled-at-seal actor
  can never feed label minting; only stamp-time identity can. (Why this is
  harmless: 1b's structural note — derivations cannot mint
  current-principal labels at all.)
- Per-run CFC granularity is already normative: serving-loop.md §3c —
  "CFC evaluates at the END OF EACH ACTION RUN … the unit is the RUN, and a
  run is action × instance … a server-side handler run gets per-run CFC
  exactly as its client run did." The trust snapshot is the one input of
  that per-run evaluation that today ignores the run and reads the process.

### 1e. The verification contract (what the group-chat check compares)

`cf-cfc-authorship` (`ui/src/v2/components/cf-cfc-authorship/`):

- The VALUE side reads the message body's resolved label view over label
  IPC and looks for a root-entry integrity atom `{kind: "authored-by",
  subject: <id>}` (or `"authored-by:<id>"` string form) —
  `authorshipStateForLabel`, cf-cfc-authorship.ts:351-374.
- The CLAIM side resolves the bound author-profile cell's label view and
  extracts the `represents-principal` atom's SUBJECT
  (`representsPrincipalSubjectForLabel`, :268-290;
  `refreshAuthorClaim`, :752-792). Display names are untrusted decoration.
- `authorshipState === "verified"` iff some authored-by subject equals the
  claim subject (and descendant text integrity is not blocked, :610-624).
  The test (`patterns/integration/cfc-group-chat-demo.test.ts:154,174,210,
  245` + `waitForAuthorshipState`, :253-346) asserts exactly this element
  state; the sibling `-two-browsers` file asserts NO authorship state,
  which is why it already passes ON while this file cannot.

So the verification contract is: **authored-by.subject on the content must
equal represents-principal.subject on the claimed author's profile, both
from durable labels.** Any design in which the two families resolve to the
same principal for the same acting user satisfies the check; only the
acting-user semantics (§4) also makes the check MEAN authorship.

### 1f. What protocol.md §2 already says, and does not say

The `authored`, server-produced admission row (protocol.md:306) rules the
MEMORY-plane identity: carriage (`actingPrincipal` + `capabilityRef`),
delegation-never-impersonation, `firedAt` stamped from the carried actor,
genesis names the acting user. S1 (protocol.md:471-478) rules run identity:
"a derivation runs per demanded instance and the DEMAND supplies the
identity … there is no third source of run identity, and 'whatever the
SpaceServer's own envelope resolves to' is never one." Protocol.md says
NOTHING about CFC value-plane labels — the label plane has no spec sentence
for served execution at all. That absence is the gap this design fills with
one binding sentence (§8, Q4): today the implementation's ambient default
is exactly the "third source of run identity" S1 forbids, one plane up.

### 1g. Adjacent work, checked against this design

- OW50 / #6157 (`prepareCfc` totality, merged, in base): a commit-prep
  crash is a modeled refusal (ext-tx:1744-1771). Composes: this design
  changes WHAT the prepare resolves, not the totality/refusal shape. OW54
  (served event whose prep crashes seals no consequence) is unchanged by
  this design and stays its own row.
- OW47 (#6150, merged): the client own-write half of the group-chat file is
  CLOSED; the skip reason names this seam as the only remaining lift
  condition.
- OW31 (#6156, merged): supplies the per-run identity this design consumes
  (`acting`, `delegated`); its FLAG-4 (repair-path writebacks carry no
  carriage) bounds which bookkeeping txs can carry a delegated principal —
  the carriage-less ones stay refused for foreign writes and keep the
  ambient snapshot (§2).
- Open PRs touching cfc/prepare (#6074 writer-fit space principal, #6077
  meta-seam write-policy inputs, #6095 metadata probes, #6094 write-floor
  host dial, #6114 terminal CFC refusals, #6083 content-addressed schemas):
  none reads or writes the trust snapshot; no file-level conflict with the
  seam this design names (stamper + a Runtime helper + prepare untouched).
  #6173 (open, docs) mints OW56 — register numbering in §10 Q7 accounts for
  it.

## 2. Snapshot granularity — options

The question: per-run trust (the acting user) on a runtime whose ambient
identity is the service. Three shapes considered; the invariant cost of
each is stated against §3's digest machinery and §5's OFF-invisibility.

**Option A — stamper-attached per-run snapshot (RECOMMENDED).** The
SpaceServer's `#stampRun` — the seam that already lands every other piece
of per-run identity — additionally calls `tx.setCfcTrustSnapshot(...)` with
a snapshot for the run's acting principal, resolved with the SAME
precedence the stamper already encodes:

  1. `info.delegated.acting.user` (the S-A bookkeeping carriage) —
  2. else `info.acting.user` (a handler's server-stamped `firedAt` actor,
     LT6-inherited pairs included) —
  3. else, for a `derivation` carrying a demand-supplied
     `scopeKeyIdentity`, its `principal` (see Q2 — severable) —
  4. else (actor-less bookkeeping, unnarrowed/wave-fallback derivations):
     leave the tx's ambient snapshot untouched (see Q3).

  The Runtime exposes one helper, e.g.
  `trustSnapshotForPrincipal(principal: string): TrustSnapshot`, returning
  `{ id: "principal:<did>", actingPrincipal: <did>, revision: <the
  runtime's trust revision> }`, and the constructor's default provider
  refactors onto the same revision composition — so the config-digest
  folding (`<id>/trust:<digest>`) lives in exactly one place and the
  trust.ts determinism contract ("hosts must fold their trust versioning
  into revision") holds for per-run snapshots by construction.

  Invariant costs: none new. The stamper runs before the run's first read
  (1d), so the mid-run `writeCfcGrant` read and the prepare-time mint see
  one stable snapshot; the tx is unprepared at stamp, so the
  `trust-snapshot-changed` invalidation never fires; retries re-stamp their
  fresh tx (1d); OFF and client-ON paths never reach the stamper (§5).

**Option B — per-principal snapshot provider (a provider-level cache
keyed by "the current run's principal").** Rejected on mechanism: the
provider is consulted at `edit()` (runtime.ts:1945), and at edit() time no
run context exists — the scheduler stamps AFTER minting the tx (1d). A
provider-based design would need ambient current-run state mutated around
every dispatch, i.e. a hidden global where option A uses the explicit
per-tx seam that already exists (`setCfcTrustSnapshot` is a supported,
test-exercised per-tx surface — 1a). The legitimate kernel of B — not
allocating a fresh 3-field object per run — is a memoization detail INSIDE
option A's helper (a `Map<did, TrustSnapshot>` on the runtime, frozen
values), worth doing only if profiling ever says so.

**Option C — delegation-aware snapshot (service + represents-principal
carried distinctly).** Extend `TrustSnapshot` with the delegating service
identity, e.g. `{ actingPrincipal: <user>, delegatedBy: <service> }`, so
label minting (or auditing) can distinguish "the service executed this as
X" from "X wrote this directly". The snapshot extension itself is cheap
(the digest binds the snapshot verbatim, so a new field flows into
invalidation for free), but it only MEANS something if some consumer reads
it — which is label-semantics option (b) in §4, with that option's costs.
Not needed for the lift; kept as the natural extension point if the owner
wants the served-provenance mark later (§4b, Q1). Note the memory plane
already durably records the delegation (the commit's `acting_principal` +
`capabilityRef` + the derived-class producer identity), so the audit trail
option C would duplicate exists one plane down.

## 3. Trust-revision keying + prepared-digest invalidation (load-bearing)

What the current machinery actually assumes — verified by reading, not
inherited from the report:

- **The prepared digest is per-transaction and binds the snapshot
  VERBATIM.** `buildPreparedDigestInput` copies
  `this.#cfcState.trustSnapshot` into the input (ext-tx:1558);
  `canonicalizePreparedDigestInput` passes it through untouched
  (canonical.ts:437); `preparedDigestFor` hashes the whole
  (canonical.ts:499-500). `id`, `actingPrincipal`, and `revision` are all
  decision content. There is no digest cache outside the tx: prepare state
  (`status`/`digest`/`input`) lives on the tx (ext-tx:1782-1795), digests
  are never persisted, never compared across transactions, and never leave
  the process. **"One snapshot per runtime" was never a digest-machinery
  assumption — it is purely a property of the default provider closure.**
  Per-tx variance is therefore supported BY CONSTRUCTION: two runs in one
  wave with different acting users produce two independent digests, each
  bound to its own snapshot; the wave is transport (serving-loop.md §3c),
  and no wave-level label or digest union exists to contaminate.
- **The invalidation triggers already exist.** `setCfcTrustSnapshot` on a
  prepared tx invalidates with `trust-snapshot-changed` (ext-tx:1212-1217)
  — under option A this trigger is provably dead (stamp precedes first
  read, which precedes prepare), but it stays as the tripwire against a
  future mis-ordered caller. The commit-time recheck (ext-tx:2354-2371)
  rebuilds the input from CURRENT tx state; since nothing re-sets the
  snapshot after the single stamp, prepare and recheck see the same value.
  A NEW pin makes this contractual (§9 pin 2).
- **`revision`'s one job is config identity.** `trustConfig` is
  deliberately NOT a digest input; `TrustSnapshot.revision` covers it
  (types.ts:726-731; trust.ts:24-31). So the design's single hard
  requirement here: per-run snapshots MUST carry the same
  `<runtime id>[/trust:<digest>]` revision composition as the default
  provider, or a trust-config change would stop invalidating exactly the
  served runs. Option A's shared helper makes divergence structurally
  impossible (one composition site). Serving runtimes today configure no
  trust config (1a), so revision = the runtime id — but the helper must
  not bake that accident in.
- **How each rejected shape would have handled this, for the record.**
  Keying a digest CACHE by principal: nothing to key — no such cache
  exists. Extending digest inputs: not needed — the snapshot (with the
  acting principal inside) is already an input. Partitioning: the only
  partitionable state adjacent to trust is the snapshot OBJECT itself,
  which option A memoizes per principal at most.
- **The one real keying rule this design adds** (stated as an invariant,
  pinned in §9): a transaction's snapshot is set at most ONCE after
  `edit()`, before the run's first read; every consumer within the tx —
  the mid-run grant write, the gate, the mint, prepare, the recheck —
  reads that one value. Mirrors `stampWaveRunContext`'s
  set-exactly-once posture for the wave context (wave.ts:285-301). A
  second stamp on one tx is a bug, not a hand-over.

## 4. Label semantics — what a served row's labels SHOULD say

The constraint set, from 1e: the verifier compares authored-by.subject
(content) against represents-principal.subject (claimed author's profile),
both durable. From 1b: literal-DID current-principal claims are rejected at
authoring — the ONLY path to a subject is runtime resolution against the
tx's acting principal. From protocol.md §2: the memory plane already
carries the acting user on the same commit, under LT5's ruled trust
footing (servers are trusted for carried actor claims, as if the principal
had written directly).

**(a) authored-by = the acting user, indistinguishable from a
client-authored row (RECOMMENDED).** The served mint resolves
`__ctCurrentPrincipal` to the run's carried acting principal, producing
byte-identical labels to what the same handler run mints on the user's own
client under OFF.

  - Soundness: this does not manufacture authority. The label plane's
    forge-resistance is unchanged — a client still cannot self-attach a
    literal DID (prepare.ts:2433), and the serving runtime resolving the
    placeholder to the CARRIED actor asserts exactly what the memory plane
    already asserts one row down (`firedAt.user`, `acting_principal`) on
    the SAME durable commit, under the SAME LT5 ruling. A malicious
    co-hosted server needs no label tricks — it holds the ambient write
    path; this design narrows what an HONEST server writes.
  - Verification: authored-by(user) vs represents-principal(user) —
    the check regains its meaning: rows verify iff the profile's
    represented principal actually fired the send. The demo's negative
    arm (imported claims) is untouched: those rows carry no authored-by
    at all (no `AuthoredByCurrentUser` wrapper), so they stay
    unverified regardless of who acted.
  - Client/durable agreement: the acting user's own speculative copy
    (minted client-side with the user snapshot) and the durable served
    copy now carry the SAME subjects, retiring the local-pass/CI-fail
    flap of rootcause §2a (the speculative Alice-labeled copy vs the
    durable service-labeled truth).

**(b) = (a) plus a distinct served-provenance mark** (a runtime-minted
atom on served rows, e.g. `{type: ServedExecution, service: <did>}`, fed
by option C's snapshot). Auditable "the service executed this as X" at the
value plane. Costs, why it is NOT recommended for this lift: a new atom
family means registering it in `RUNTIME_MINTED_INTEGRITY_ATOM_TYPES`
(prepare.ts:4082+), atom-classes, field classification, and every label
diffing surface; it re-introduces a PERMANENT client-speculative vs
durable label divergence (the client echo cannot honestly carry the mark),
which is the §2a flap in new clothes and would keep authorship state
churning across arrival; and the audit fact it records is already durable
on the memory plane per-commit (acting_principal + capabilityRef +
derived-class producer). If a product surface later needs value-plane
audit of served execution, mint it THEN with its own spec sentence — the
option-C snapshot field is the prepared extension point.

**(c) authored-by = service + represents-principal = user (closest to
today's accident).** Rejected on the verification contract: the check
compares the two subjects for EQUALITY (1e), so (c) is permanently
"unverified" — it is the CI red, restated as a design. It also corrupts
the vocabulary: represents-principal on a PROFILE means "this profile
represents that user" (the claim-side anchor); making content rows carry a
user they were not authored by while authored-by names an executor is a
semantic the verifier, the demo, and the spec's current-principal family
were never designed for. Teaching the verifier to accept
service-authored-by (a service allowlist in the UI component) would make
every service-executed row verify as ANY user — the collapsed security
property of §Why, institutionalized.

Recommendation: **(a)**, stated as the OFF-equivalence invariant (§8
INV-A). The register's own OW34-family precedent supports the shape: the
renderer-trust carriage (the closed OW34 row) already re-mints a
client-process-local trust attestation server-side at the
injected-keys trust level; resolving the current-principal placeholder
against the carried actor is the same move on the label plane, with the
same explicitly-ruled footing to cite (LT5, owner 2026-08-03).

## 5. Replay / idempotency × (α)

The invariant, stated once: **a served run's trust snapshot is a pure
function of the run's DURABLE inputs — the stream entry's server-stamped
`firedAt` for a handler, the demanded instance identity for a derivation,
the delegated carriage for a sanctioned bookkeeping crossing — never of
process-ambient state.** Everything else follows:

- A re-drain of the same event (the wave IS the retry cadence; kill/replay
  included) resolves the same `firedAt.user` from the same durable entry,
  mints the same snapshot, and `derivePersistedLabel` — deterministic in
  (schema, snapshot, source labels) — produces byte-identical `["cfc"]`
  atoms. The re-applied labelMap write is a CAS no-op against an identical
  prior application, exactly like the consequence writes it rides with.
  This composes with (α) untouched: exactly-once is keyed by `eventId` at
  admission and by the consequenced mark in the run's own tx
  (`ServerRunInfo.streamEntry`); labels are CONTENT of the consequence,
  not part of its identity.
- Labels do NOT enter any consequence's IDENTITY: doc ids are
  creation-derived (CT-1650), never content hashes; the prepared digest
  binds the snapshot but is tx-local and unpersisted (§3). So per-run
  snapshots cannot fork replay identity. What they CAN change is doc
  CONTENT across a VERSION boundary — a store written pre-fix (service
  atoms) re-derived post-fix (user atoms) is a value change, which is §6's
  migration question, not a replay hazard.
- The one ordering fact worth restating (from 1d): retries re-mint the tx
  and re-stamp (both scheduler choke points and the `editWithRetry`
  writeback loops stamp inside the retried fn), so no retry can carry a
  stale snapshot from a previous attempt's tx.
- Today's behavior, for honesty: the SERVICE snapshot is also
  replay-deterministic (a constant is pure too). The purity invariant is
  not what FIXES the bug; it is what the fix must PRESERVE while changing
  which durable input the snapshot is a function of.

## 6. OFF-invisibility + migration

**OFF is byte-identical by construction.** The entire change sits behind
the stamper, which exists only where a wave seal destination is installed —
a serving runtime under `EXPERIMENTAL_SERVER_EXECUTION` (runtime.ts:
1991-2033; `stampServerRun` is one undefined check on the OFF arm,
runtime.ts:2091-2104). Clients — OFF and ON alike — keep the ambient
provider, which on a client IS the user: no client path changes. The §9
acceptance carries the per-site OFF-neutrality pin in the
`storage-instance-keying` style.

**Migration: none owed; fresh stores are the ruling posture's own
evidence.** Production runs the flag OFF and holds no service-labeled rows
(the #6173/OW45 correction: the broken spaces lived in ephemeral test
stores). The ON lanes and local ON repros run fresh stores per run. So
existing service-labeled rows exist only in disposable test stores, and
the disposition is **ignore (fresh stores)** — no relabel pass, no
tolerate-both verifier arm. Two consequences stated so nobody builds them
by reflex: (i) do NOT teach `cf-cfc-authorship` to accept service-authored
rows "for compatibility" — that is §4(c)'s collapse through the back door;
(ii) a long-lived ON dogfood store that predates the fix, should one
exist, is re-created rather than migrated (its labels are wrong about
authorship; keeping them wrong-but-tolerated has negative value). If the
owner later wants heal-on-rewrite (a served re-derivation naturally
replaces the label on the next overwrite of each row), that falls out of
the mechanism for free for rows that get rewritten, and is NOT a
completeness claim for rows that never do.

## 7. Scope discipline — the flip needs exactly the group-chat lift

In scope: the serving runtime's per-run trust snapshot (option A), label
semantics (a), the pins of §9, one binding spec sentence + the SC entry
(Q4), the skip-entry lift, and the register re-tense. Everything below is
NAMED OUT, with its home:

- **OW53 — the sqlite identity pair.** The db-owner mint and
  clearance-reader keying read the RUNTIME provider directly (1c). This
  design's tx-attached snapshot is the substrate a fix would re-point them
  at (`tx.getCfcState().trustSnapshot` instead of
  `runtime.trustSnapshotProvider()`), but WHO owns a db handle under
  served execution is an identity-model decision that row already owns.
  Untouched here; both sqlite ON skips stay.
- **llm-dialog's provider read** (llm-dialog.ts:2371) — same shape, same
  disposition: named, untouched.
- **OW13 / FLAG-7 — per-demander read isolation and grant resolution.**
  The session-level acting-as-owner READ binding stays as OW31 built it;
  nothing here touches the memory plane. FLAG-7's attributed-ambient-
  authority tightening remains future.
- **The space-scoped-derivation trust-closure narrowing** (1b structural
  note's cousin): under per-run snapshots, an actor-less derivation
  evaluates concept floors with no acting principal (deployment-root
  delegations only), where the OFF client evaluated them under its owner.
  Unobservable today — serving runtimes configure no trust config (1a), so
  `conceptSatisfied` is uniformly false there — recorded as a stated
  consequence for whenever a deployment first configures serving-side
  trust, not solved here.
- **Label option (b) — the served-provenance mark** and option C's
  delegation-aware snapshot field: future, on product need, with its own
  spec sentence (§4b).
- **OW49** (divergent-anyOf at /result) — the OTHER CFC-owner seam in this
  phase; separate blocker for `profile-embed`, zero mechanism overlap
  (schema-merge, not trust), separate ruling.
- **OW54/OW56 and the events seal path** — untouched (1g).

## 8. The recommended design, in one piece

1. **Mechanism.** `Runtime` gains
   `trustSnapshotForPrincipal(principal): TrustSnapshot` — `{ id:
   "principal:<did>", actingPrincipal: <did>, revision: <the runtime's
   trust revision> }` — and the constructor's default provider is
   refactored onto the same revision composition (one site folds the
   config digest). The SpaceServer's `#stampRun` attaches a per-run
   snapshot via `tx.setCfcTrustSnapshot(...)` using its existing identity
   precedence: `delegated.acting.user`, else `info.acting.user`, else a
   demanded derivation's `scopeKeyIdentity.principal` (Q2), else it leaves
   the ambient snapshot in place (Q3). No other file's behavior changes;
   prepare.ts is untouched.
2. **Semantics.** Label option (a): a served run's current-principal
   mints name the acting user, indistinguishable from the client-authored
   row — the memory plane's carried actor and the label plane's resolved
   subject are the same principal on the same commit.
3. **Invariants, as testable pins.**
   - **INV-A (OFF-equivalence of the mint):** the `["cfc"]` labels a
     served handler run persists are byte-identical to those the same
     handler run mints on the acting user's own client. (Pinned as §9-1's
     equality against a client-runtime control.)
   - **INV-B (purity/replay):** the served snapshot is a pure function of
     the run's durable inputs; an idempotent re-dispatch mints
     byte-identical labels. (§9-3.)
   - **INV-C (one snapshot per tx):** set at most once, after `edit()`,
     before the run's first read; prepare and the commit-time recheck see
     the same value; the `trust-snapshot-changed` invalidation stays as
     the tripwire and never fires on the sanctioned path. (§9-2.)
   - **INV-D (no service-authored labels under ON):** no durable `["cfc"]`
     labelMap entry carries an authored-by / represents-principal atom
     whose subject is the service DID. (§9-6's store-dump audit.)
   - **INV-E (forge-resistance unchanged):** literal-DID current-principal
     claims stay rejected; the only path to a user-named label remains a
     run actually carrying that user's acting identity. (Existing pins +
     §9-1's negative arm.)
   - **INV-F (OFF byte-identity):** flag OFF, no site changes behavior.
     (§9-5.)
   - **INV-G (revision covers config, per-run included):** a trust-config
     change invalidates served runs' prepared digests exactly as it does
     client ones — the helper composes the same revision. (Unit pin on the
     helper.)

## 9. Acceptance criteria

1. **Red-first executor pin (the FLAG-5 shape as a failing assert).** In
   the runner executor family (real SpaceServer + live wave, the
   OW31-pin style): a served event-handler run whose written docs carry
   `AuthoredByCurrentUser` / `RepresentsCurrentUser` schemas persists
   labelMap atoms whose subject is the entry's `firedAt.user` — WATCHED
   RED at base, where the subject is the service DID (the rootcause §2a
   store shape). Negative arm: a payload-smuggled literal-DID claim still
   refuses (INV-E).
2. **Per-wave multi-principal pin.** Two handler runs for two users in one
   wave: each run's docs carry that run's user; both prepared digests
   recheck clean at commit (INV-C; no cross-run contamination, no
   `cfc-prepared-digest-mismatch`).
3. **Replay pin.** Re-dispatch of the same durable entry (the existing (α)
   idempotency harness) mints byte-identical labels (INV-B).
4. **Delegated-writeback pin.** An S-A carriage bookkeeping writeback tx
   carries the delegated acting's snapshot; a carriage-less foreign
   writeback stays refused exactly as OW31 pinned it (unchanged).
5. **OFF-arm neutrality.** Per-site OFF pins in the
   `storage-instance-keying` style: no stamper ⇒ no snapshot call; client
   ON speculation unchanged (INV-F).
6. **The live lift (the skip entry's own condition).**
   `integration/cfc-group-chat-demo.test.ts` greens under the true ON
   topology (lane-shaped toolshed, fresh store), including both
   authorship checks across the `shell.login` switch — and the ON-skip
   entry is REMOVED in the same train (the flip needs the list EMPTY).
   Store-dump audit on the run's store: zero authored-by /
   represents-principal atoms naming the service DID (INV-D), the §2a
   evidence query inverted.
7. **No digest-keying regression.** The full runner executor + cross-space
   + serving-loop + memory suites green; ON-lane toolshed logs carry no
   new `cfc-prepared-digest-mismatch` / `trust-snapshot-changed`
   occurrences in the gate runs.
8. **OFF untouched at the suite level.** The default-posture lanes run
   byte-identical (no reason text, snapshot shape, or label change
   reachable OFF).

## 10. Open questions for the owner (numbered; each with a recommendation)

1. **Label semantics: (a) acting user only, or (b) acting user + a
   served-provenance mark?** Recommendation: **(a)** for this lift. (b)
   re-opens the client/durable label divergence the fix exists to close,
   costs a new gated atom family, and duplicates an audit trail the memory
   plane already records per-commit; if a product surface later needs
   value-plane served-execution audit, option C's snapshot field is the
   prepared extension point, with its own spec sentence then.
2. **Does the derivation arm ship now?** Attaching the demanded
   `scopeKeyIdentity.principal` to derivation-run snapshots is
   behaviorally inert today (derivations cannot mint current-principal
   labels — 1b's structural note; concept floors are inert on serving
   runtimes — §7), but it is the OFF-faithful direction and the substrate
   OW53 wants. Recommendation: **include it**, explicitly severable to
   handlers+delegated-only if review surfaces a consumer I missed; the
   eager-at-stamp principal knowingly diverges from the seal-settled
   memory-plane attribution for runs that discover a broader scope, and
   §8's design records that divergence as consequence-free for labels
   (prepare precedes seal — 1d).
3. **Actor-less stamped runs (plain bookkeeping, wave-fallback
   derivations): keep the ambient service snapshot, or clear it to
   undefined (fail-closed placeholder minting)?** Recommendation: **keep
   the service snapshot** — zero behavior change for paths that today
   work (structure loads, watermark, pattern-swap setup, factory-time
   loads), aligned with protocol.md §1's "the SpaceServer's own writes";
   the gated mint families are already unreachable from those paths
   (uiContract requires a trusted event — 1b). The fail-closed
   alternative is one line if the owner prefers the tighter posture and
   accepts hunting any latent bookkeeping path that relied on snapshot
   presence (writeAuthorizedBy's presence floor — 1c).
4. **Spec home.** Recommendation: one binding sentence in
   serving-loop.md §3c (where per-run CFC is already normative), shaped
   like: *"The run's CFC trust snapshot carries the run's ACTING
   principal — the event's server-stamped actor, the demanded instance's
   principal, or the delegated carriage's actor — never the serving
   runtime's ambient identity; a run with no acting principal keeps the
   service snapshot and cannot mint current-principal claims."* Plus an
   SC entry in `docs/specs/cfc-spec-changes.md` (next free number —
   SC-38 at this writing) recording the served-execution reading of the
   current-principal family, and the register re-tense (OW31 residual
   (iii) → closed-by, the OW34-family note updated). The build lands
   spec + code together per the standing rule.
5. **The direct provider reads (sqlite, llm-dialog): re-point now or
   leave to OW53?** Recommendation: **leave** — they are OW53's identity-
   model decision (db ownership, clearance keying), not label attribution;
   this design only guarantees the tx snapshot they would re-point at is
   right. Re-pointing them here would smuggle an OW53 ruling in through a
   label fix.
6. **`TrustSnapshot.id` shape for served runs.** Recommendation:
   `principal:<acting user>` — uniform with every client snapshot; `id`
   is presence-checked and digest-bound but nothing branches on its text,
   so uniformity beats a `served:` marker (which would be option (b)'s
   distinction smuggled into a field nothing should read).
7. **Register row for the build.** The residual currently lives inside
   OW31's row (iii) with "OW34's family" as its name. Recommendation: the
   implementation train mints its own row at the then-next free OW number
   (OW56 is being taken by open #6173) titled "OW34-family: per-run CFC
   trust attribution", carrying this document as the design of record,
   and re-tenses OW31 (iii) + the group-chat skip reason to point at it;
   this doc deliberately does not claim a number in advance.

## Verification inventory (what was probed, what was not)

| claim | how verified |
|---|---|
| snapshot default + edit() attach + single writer | code read: runtime.ts:1318-1326,1945; grep over src for `setCfcTrustSnapshot` (one production caller + the wrapper) |
| serving runtimes get no provider/config | toolshed/lib/server-execution.ts:144-183 |
| placeholder mint mechanics + gates + literal-DID rejection | prepare.ts:345-412, 2371-2469, 3881-3937 |
| digest binds snapshot verbatim; no cross-tx digest state | ext-tx:1558, canonical.ts:437,499-500; prepare state on tx (ext-tx:1782-1795) |
| per-tx snapshot override is a supported surface | profile-owner-cfc.test.ts:134-149,408-447 (public setter, exercised) |
| stamp precedes first read at both choke points; retries re-stamp | scheduler/events.ts:1187-1268, scheduler/run.ts:508-542, pattern-manager.ts:2074-2098,2183-2200 |
| mid-run snapshot consumer exists (forces pre-run seam) | writeCfcGrant, ext-tx:1354-1357 |
| seal-time attribution settles AFTER prepare | wave.ts:898-989 (settle at 938) vs ext-tx commit path 2270-2387 |
| verifier compares authored-by.subject vs represents-principal.subject | cf-cfc-authorship.ts:268-374,610-624,752-792; test waitForAuthorshipState |
| two-browsers file asserts no authorship state (why it passes ON) | grep over cfc-group-chat-demo-two-browsers.test.ts |
| service-DID labels on served rows (the defect) | NOT re-probed live in this pass — carried from rootcause §2a's store dump + first-on-ci-gate row 2, both same-day evidence; the §9-1 red-first pin re-establishes it at build time |
| OW50 totality landed; adjacent open PRs disjoint | ext-tx:1710-1801; `gh pr list` + git log sweep 2026-08-21 |

No scratch code probes were needed: every mechanism claim resolved by
reading, and the one live claim (the store shape) has same-day archived
evidence plus a red-first pin in the acceptance path. The worktree carries
this document only.
