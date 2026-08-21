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
