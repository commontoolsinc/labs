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
