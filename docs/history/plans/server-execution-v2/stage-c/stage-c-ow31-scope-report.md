---
status: historical
created: 2026-08-18
archived: 2026-08-18
reason: "Stage-C evidence: the OW31 write-authority scoping report behind the 2026-08-18 ruling (the USER's identity, not the serving identity, writes users' spaces; a provisioned space's genesis is signed by the space's own keys and names the acting user OWNER in that same first commit) — the write inventory, the one defect (the served genesis ACL's content), the read-only service class recommendation, the build work order B0-B7 and the flags F1-F10."
---

# OW31 scope — owner ruling 2026-08-18 (re-ruled): the USER's identity, not the serving identity, writes users' spaces; genesis under the new space's OWN keys, delegating OWNER to the acting user

Report only (work order + spec text). No code, no pushes, no comments.
Read against `origin/claude/server-exec-v2-stage-c-docs` @ c74ded63b in a
detached worktree (removed at the end). All `file:line` cites are to that
tree; the P5/P7 report cites are to `/Users/berni/labs-worktrees/*.md`.

## 0. TL;DR

- **The blanket is on the wrong plane for what it was added for.** Under
  the flag `memoryServiceDidsFor` makes the toolshed process identity a
  memory SERVICE PRINCIPAL = implicit OWNER for its SESSIONS on every
  space (`packages/memory/v2/server.ts:1210-1215`, genesis arm `:1380-1389`).
  It was added because the served `#profile` wish could not READ the
  demanding user's home space (`p7-build-report.md:47-56`: `lacks READ on
  space <home>` ×4/run). Reads are the whole need on the session plane.
- **The served WRITES into a user's home space are ALREADY on the
  delegated path.** Every write a served run makes into alice's home
  space or a `.inSpace()`-provisioned space rides the wave → accept gate
  (`wave.ts:1141-1208`, `foreignWriteAuthorityFor` — blanket ignored,
  `server.ts:4984-4989`) → engine-direct sink (`engine-wave-sink.ts:215`)
  with `delegated: { actingPrincipal: <user>, capabilityRef }`. The
  service identity is not the actor of any of them today. Nothing to
  re-route (§3, §4 below).
- **The ONE write that names the SERVICE is the `.inSpace()` genesis
  ACL** — and it is not signed by the service either: the loopback
  StorageManager's fresh-space bootstrap (`v2.ts:1047-1221`) opens a
  session AS THE SPACE IDENTITY (`v2.ts:1133-1144`) and writes
  `{ [signer.did()]: "OWNER", "*": "WRITE" }` (`v2.ts:1165-1167`) where
  `signer` = the manager's `as` = the SERVICE on the loopback plane
  (`server-execution.ts:149-150`, `loopback-storage.ts:66-70`). So the
  served create makes the service the DURABLE, EXPLICIT owner of the
  user's profile space (or, if the sink's data commit wins the race, no
  ACL at all — INV-13 bypassed). Both violate the ruling. UNPINNED today
  (no executor test asserts a served fresh space's ACL).
- **The RULED genesis shape is already the mechanism** — the client does
  exactly it: the space's own derived keys sign the genesis
  (`identity/src/session.ts:25-28`, `runtime.ts:2711-2728`,
  `v2.ts:951-953`), the memory server admits `principal === space`
  (`server.ts:1383`), and `hasConcreteOwner` ties the OWNER to SOME
  concrete DID, never to the signer (`packages/memory/acl.ts:43-48`).
  Change = content (OWNER := the acting user, not `signer.did()`) +
  ordering (genesis BEFORE the sink's data commit, deterministically).
  No memory-server policy change is needed for genesis.
- **The read side needs a narrow class, not nothing.** Without the
  blanket AND without a read-only class, `session.open` (`server.ts:
  2355-2363`) denies the serving runtime on every owner-only home space
  (`{ [user]: "OWNER" }`, `v2.ts:1165`), so under ON — where clients do
  not commit derivations — every private home space stops being derived,
  not only the wish. Recommend **(b): a read-only service class** in the
  memory ACL (`acl.readOnlyServiceDids`; the process identity joins it
  under the flag; OFF: empty). FP2's row is a different row (instance
  naming, `server.ts:2880+`, after the READ check at `:2838-2853`);
  delegated READ cannot cover `session.open`.
- **OFF-invisible; land post-merge but BEFORE the flip PR.**

## 1. The ruling and the amendment (verbatim intent)

Owner, 2026-08-18: "toolshed's serving identity (a generic one, not
user-specific) should NOT be used to write into users' home spaces; the
USER's identity should — for wish provisioning and `.inSpace()`
genesis." The owner does not want the service principal as an implicit
OWNER of users' spaces.

Owner, 2026-08-18 (genesis, via coordinator): "for genesis of a new
space, the new space's own keys can be used for the genesis transaction,
immediately delegating owner to the acting user (so that first commit
happens under the space's own identity, the rest is then the user's)."

## 2. Ground truth: two planes, one blanket

| plane | who is the principal | ACL check | where |
| --- | --- | --- | --- |
| **client-session plane** (`session.open` / `graph.query` / `session.watch` / `transact` over a mounted session; the loopback plane's sessions are exactly these — `loopback-storage.ts:1-9`) | the session's verified principal; for the serving runtime = the toolshed process identity (`server-execution.ts:149-150`) | `#resolveCapability` `server.ts:1205-1230`: implicit OWNER iff `principal === space` OR `#isServicePrincipal(principal)` (`:1210-1215`); else the space's ACL doc / the missing-ACL compat arms (`:1221-1225`). `session.open` needs READ (`:2355-2363`), queries READ (`:2838-2853`), transact WRITE / OWNER-if-ACL-doc after `#validateAclCommit` (`:2593-2617`). Genesis: `#validateAclCommit` `:1329-1391` — precedence clause `:1341-1346`, authority clause `:1380-1389` (only `principal === space` or a service DID may initialize). | THIS is where the blanket lives. `MEMORY_ACL_MODE` defaults to `enforce` in production (`packages/toolshed/env.ts:213`). |
| **wave / engine-direct plane** (the wave's ONE derived home commit + foreign provisioning batches, `EngineWaveCommitSink`; the outbox's delegated appends; lease rows) | the sink commits `sessionId = DR1 holder`, `principal = undefined` (`space-server.ts:591-594`); foreign batches carry `delegated: { actingPrincipal, actingSession?, capabilityRef }` (`engine-wave-sink.ts:183-223`) | **NO session ACL** — `applyCommit(engine, …)` directly (`engine-wave-sink.ts:215`); the engine has no ACL/genesis code (grep: none). Authorization is the wave's accept gate: carriage present (`wave.ts:1169-1178`) AND `foreignWriteAuthorityFor(space, acting.user)` (`wave.ts:1179-1184`, `:2276-2298`; `server.ts:4995-5040`: owner-by-identity `:5016`, fresh-store creation `:5019`, target ACL `:5022-5035`; the service-DID blanket "does NOT apply" `:4984-4989`); engine delegated admission = presence + completeness (`engine.ts:3155-3229`); stored `acting_principal/acting_session/capability_ref` (`engine.ts:3453-3455`). | The register (`verification-coverage.md:2650-2653`) and the P7 review (`p7-independent-review.md:194-204`) already state the blanket is NOT a widening here. Confirmed. |

The seal destination is installed for the WHOLE activation
(`space-server.ts:790` install, `:3347` clear), so during serving every
`runtime.edit()` seals into the wave — the session plane carries the
loop's READS (subscriptions/queries), the fresh-space ACL bootstrap
(space-identity-signed, `v2.ts:1133-1144`), and stragglers outside an
activation (none known — see §7 canary).

## 3. Q1 — write inventory: every write the serving process makes into a USER's space under the flag

"User's space" = the demanding user's HOME space, or a space the user's
run provisions (`.inSpace()`). Reads are listed separately in §6.

| # | write | producer / path today | identity + class TODAY | identity + class RULED | path to get there |
| --- | --- | --- | --- | --- | --- |
| W1 | `profiles.push(ProfileHome.inSpace()({…}))` → alice's HOME `defaultPattern.profiles` (`profile-create.tsx:74-104`) | served EVENT-HANDLER run of the create sidecar (the sidecar lives in the SERVED space `parentCell.space`, `wish.ts:2167-2175`); the push crosses into alice's home. `#stampRun` `space-server.ts:1156-1222`: acting = the event's server-stamped actor (alice), `capabilityRef = event-consequence:<eventId>` (`:1214-1215`) | wave foreign batch → accept gate: carriage ✓, `foreignWriteAuthorityFor(aliceHome, alice)` = **owner** (`server.ts:5016`) → sink `applyCommit` AUTHORED + `delegated{alice}`; stored `acting_principal = alice`, session = holder, no envelope principal | same — AUTHORED, delegated under alice | **already there.** No change. |
| W2 | `setDefaultProfile` → alice's home `defaultProfile`; `setMruProfile` → alice's home `mru` (`profile-create.tsx:109-146`, picker sidecar) | served event-handler runs, as W1 | as W1 (owner-by-identity) | same | **already there.** |
| W3 | the `.inSpace()` piece's DATA docs into the FRESH profile space P (the `ProfileHome` result/argument docs) | the same handler run; `resolveInSpaceTargetSpace` → `anonymousSpaceName` (`pattern.ts:1059-1083`, `:1127-1131`) → `resolveSpaceName` (`runtime.ts:2711-2728`) → `optIntoInSpaceMultiSpaceCommit` (`pattern.ts:1098-1112`) | wave foreign batch → gate: carriage ✓, grant = **creation** (store absent, `server.ts:5019-5021`; on replay **acl** via alice's OWNER, `:5022-5028`) → sink AUTHORED + `delegated{alice, event-consequence:…}` — engine-direct, **lands with no ACL check and no genesis** (INV-13's precedence clause `server.ts:1341-1346` is session-only; `09-invariants.md` INV-13 names `#validateAclCommit` as its only layer) | AUTHORED, delegated under alice — unchanged — but **sequenced AFTER W4** | **already delegated**; add the ordering + the sink-side INV-13 mirror (work order B4). |
| W4 | the GENESIS ACL of the fresh space P (`of:<P>`) | the loopback `StorageManager`'s `#createInitializedSession` (`v2.ts:1047-1221`) — fires lazily on the P provider's first session mount (`v2.ts:5822-5840`) because `LoopbackSessionFactory.supportsAclBootstrap = true` (`loopback-storage.ts:22`) and `resolveSpaceName` registered P's derived identity (`runtime.ts:2722-2723`, `v2.ts:951-953`) | bootstrap session signed AS P (`v2.ts:1133-1144`; admitted by `server.ts:1383` `principal === space` and OWNER-implicit `:1212`) — content **`{ [SERVICE]: "OWNER", "*": "WRITE" }`** (`v2.ts:1165-1167`, `signer` = `as` = the service) — IF the mount wins the race with the sink's W3; else `openedServerSeq !== 0` → skipped (`v2.ts:1112`) and P stays ACL-less-populated (authenticated READ/WRITE, no owner, `server.ts:1221-1225`) | **RULED:** actor = P's own identity (the space's keys) — as today; content **`{ [alice]: "OWNER", "*": "WRITE" }`** — the acting user OWNER, the service named NOWHERE; lands as P's FIRST commit, deterministically before W3 | (i) OWNER := the acting principal, threaded to `registerSpaceIdentity` from the serving-side `resolveSpaceName` call (`runner.ts:5667-5677`; the run's tx carries the actor — `runtime.homeSpacePrincipalFor`-style read of `waveRunContextOf(tx)`, `runtime.ts:2640-2663`); client default stays `signer.did()` (byte-identical). (ii) the SpaceServer's commit step forces the mount/genesis for every `creation`-granted foreign target BEFORE the sink applies; the sink refuses a foreign batch into a seq-0/no-ACL store (INV-13 mirror). Work order B3 + B4. |
| W5 | the wish's OWN writes: wish state cell (`wish.ts:1975-1980`), `#now` cells (`:1238-1249`), sidecar result/ready cells (`:2019-2036`, `:2167-2175`, `:2230`), sidecar-run / error-UI txs (`:2085-2136`, bookkeeping-stamped) | all in `parentCell.space` = the SERVED space, never the demander's home | HOME-wave writes: fold into the wave's DERIVED commit under the lease (holder session); bookkeeping carries no actor by design (`space-server.ts:1153-1155`; protocol.md §1 "The SpaceServer's own writes") | unchanged — derived class under the single deriver is the design (protocol §1); NOT what the ruling addresses (flag F3) | none. If the served space IS a user's home (home-profile flow) these are still derived-class outputs of that space's deriver, not "the service writing as itself". |
| W6 | cross-space EVENT appends into a user's stream (outbox) | `#deliverDelegatedAppend`-class server-internal engine commit (`server.ts:1959-2140`) with the carried actor | delegated (acting user) — engine plane | same | already there. |
| W7 | the toolshed's OWN `productionServer` runtime (webhooks / ingest → `sendToStream` into user spaces) — session plane as the operator identity | today OWNER via the blanket wherever `MEMORY_SERVICE_DIDS` did not already list it (`verification-coverage.md:2647-2650`) | after: the configured list verbatim — the ingest checklist's posture (`docs/plans/ingest-channels-journal-sink.md:108-114`) | not "wish provisioning / genesis" — OUT of this work order; flag F1 (config-granted OWNER persists if the operator lists the DID). |
| W8 | lease rows (plane c), watermark doc, effect retirement | engine tables / the served space's derived commit | service, by design (protocol §1) | unchanged | none. |

Bottom line for Q1: **the service identity is not the actor of any
served write into a user's home space today**; the only service-named
artifact is W4's ACL CONTENT, plus the ordering hole that lets W3 land
before any ACL. Everything the ruling asks for on the write side is
W4's content + W3/W4's ordering.

## 4. Q2 — the delegated path per write

Protocol §2's delegated row (`protocol.md:306`) + §2b's provisioning
bullets (`:530-573`, "creating THEIR space — RULED") sanction served
AUTHORED writes under the acting principal with carriage.

- **W1/W2/W3 — already on it.** The carriage exists from F/P5
  (`#stampRun`, `space-server.ts:1196-1218`); the ref is
  `event-consequence:<eventId>` for handler runs and
  `demanded-run:<user>` for demanded derivations (`:1214-1216`) — both
  are presence-checked only (`protocol.md:318-331`; `wave.ts:2303-2317`;
  `engine.ts:3173-3185`). `#foreignGrantFor` accepts W1/W2 via
  owner-by-identity (`server.ts:5016-5018`) and W3 via creation
  (`:5019-5021`) then acl on replay (`:5022-5028`). The engine's
  delegated admission needs **nothing new**. (`p5-fix-report.md:35`,
  `p7-build-report.md:39-43` say the same.)
- **W4 — not a wave write; not "delegated" in the carriage sense.** The
  RULED shape keeps it as a SESSION-plane commit signed by the space's
  own identity (the amendment: "first commit happens under the space's
  own identity") whose CONTENT is derived from the delegated carriage
  (`delegated.actingPrincipal` of the `creation`-granted batch — the
  same actor the sink will store on W3). What it takes: thread the
  actor to the bootstrap (B3), and make the wave commit step ORDER it
  ahead of the sink for `creation` targets (B4). `#foreignGrantFor` is
  untouched (it already keys on the acting user); the engine's
  delegated block is untouched.
- **What must NOT be done:** do not add a `delegated` field to the
  session `transact` path so a USER session could initialize a foreign
  space — the protocol's closed metadata list keeps `delegated` off the
  wire (`engine.ts:3141-3154`; protocol §7), and the ruled shape does not
  need it (the space signs).

## 5. Q3 — GENESIS (RULED 2026-08-18): the space's own keys sign; the ACL immediately makes the acting user OWNER

**(a) Does the current genesis code already support "the space signs
its own genesis" and "owner ≠ signer"?** YES, on both counts, and it is
the mechanism the CLIENT uses today:

- Authority: `#validateAclCommit` `server.ts:1380-1389` admits the first
  ACL commit iff the SESSION principal `=== space` (or a service DID);
  `#resolveCapability` `:1210-1215` gives that principal implicit OWNER,
  so the bootstrap session's `session.open` (READ, `:2355-2363`) and its
  ACL-doc write (OWNER, `:2606-2617`) both pass with NO service-DID
  status. INV-13 (`docs/specs/memory-v2/09-invariants.md`, "the commit
  that creates it must come from the space's own identity or from an
  identity the deployment has designated") is satisfied by the first
  arm.
- Content: the ACL must be valid and `hasConcreteOwner`
  (`server.ts:1373-1379`) — `packages/memory/acl.ts:43-48` requires SOME
  concrete-DID OWNER; nothing binds the OWNER to the signer. The client
  writes `{ [user]: "OWNER", "*": "WRITE" }` signed by the SPACE
  (`v2.ts:1165-1182`) — owner ≠ signer already.
- Where the space's keys come from and who holds them at provisioning:
  DERIVED, not stored — `createSession({ spaceName })` →
  `Identity.fromPassphrase("common user").derive(name)`
  (`packages/identity/src/session.ts:21-35`), called from
  `Runtime.resolveSpaceName` (`runtime.ts:2711-2728`) and retained ONLY
  as fresh-space bootstrap authority in `StorageManager.#spaceIdentities`
  (`v2.ts:946-953`, "Providers continue to authenticate all ordinary
  replica work as `this.as`"). For anonymous `inSpace()` the name is
  `toURI(createRef({ inSpace: ordinal }, frame.cause))` (`pattern.ts:
  1127-1131`) — CT-1650: unique per creating user AND per creation event
  (`profile-create.tsx:63-73`); the SERVING runtime derives and holds it
  the moment its handler run resolves the pending name
  (`runner.ts:5667-5677` → `resolveSpaceName`), i.e. exactly at
  provisioning time. The keys are re-derivable by anyone who knows the
  name (a pre-existing property; the name embeds the creator's cause).
  The space's OWN SpaceServer (activating later as P's deriver) never
  needs them.

**(b) What changes so the genesis ACL names the ACTING USER as owner in
the SAME first commit:**

1. `StorageManager.registerSpaceIdentity(identity)` (`v2.ts:951-953`)
   gains an optional genesis-owner: `registerSpaceIdentity(identity,
   { owner?: DID })`; `#createInitializedSession`'s `bootstrapAcl`
   (`v2.ts:1165-1167`) becomes `{ [owner ?? signer.did()]: "OWNER",
   "*": "WRITE" }` for the non-home arm (the home arm `signer.did() ===
   space` is untouched — a home space is its own identity). Client:
   `owner` undefined → byte-identical.
2. `Runtime.resolveSpaceName(name, { owner? })` (`runtime.ts:2711-2728`)
   passes it through; the serving-side call site
   `resolvePendingSpaceNamesAndRetry(frame)` (`runner.ts:5667-5677`)
   supplies the run's ACTING principal read from the frame's tx wave-run
   context (`waveRunContextOf(tx)?.acting?.user ??
   scopeKeyIdentity?.principal` — the same source
   `homeSpacePrincipalFor` reads, `runtime.ts:2644-2646`, but WITHOUT
   its read-scope ratchet side effect; a serving runtime with NO actor
   REFUSES to register (loud), mirroring `getHomeSpaceCell`'s refusal
   `runtime.ts:2669-2679` — a served `.inSpace()` with no actor must
   not mint a service-owned space; on a client (`!servingPosture`) the
   owner is `this.as`, unchanged).
3. Ordering (INV-13 precedence, which the sink bypasses): in the
   SpaceServer's commit step, after `#resolveForeignEngines`
   (`space-server.ts:851`, awaited at `:3047`) and BEFORE the sink
   applies, for every foreign batch whose grant resolved `via:
   "creation"` (the probe result is available — `space-server.ts:
   1107-1118` currently discards `verdict.via`; keep it per (space,
   acting) in the wave), `await` the P provider's initialized session
   (a small `StorageManager.ensureSpaceInitialized(space)` that forces
   `sessionHandle()` → `#createInitializedSession`; on the loopback
   plane that is an in-process round trip). Then the sink's W3 lands at
   seq ≥ 2. Backstop in the sink: refuse a FOREIGN batch whose target
   engine has `serverSeq === 0` and no ACL doc (`Engine.readState(engine,
   { id: aclDocId(space) }) === null`) — the mirror of `server.ts:
   1341-1346` on the engine-direct plane — as `WaveCommitRejected`
   (foreign failure ⇒ home withheld ⇒ replay, §2b's existing failure
   semantics). This turns today's silent INV-13 bypass into a loud
   invariant.
4. Cache coherence: the genesis rides the SESSION transact path, which
   invalidates `#aclCapabilities` (`server.ts:2735-2736`) — no new
   invalidation needed. (Had genesis been done sink-side/engine-direct
   it would need explicit invalidation — a reason NOT to do it there.)

**(c) Replay-idempotence across a kill between foreign and home commits
(§2b `protocol.md:556-566`):**

- The genesis actor (P's identity) and content (`{ [alice]: OWNER, "*":
  WRITE }`) are both DETERMINISTIC functions of the creation event: P's
  DID/keys from the frame cause + event id (CT-1650), alice from the
  event's server-stamped `firedAt.user` (protocol §2's stamping
  paragraph, `protocol.md:368-401`). A replayed handler re-derives the
  same name → `resolveSpaceName` → the same keys → the same owner.
- Kill BEFORE genesis: replay → store absent or seq 0 → creation grant
  → genesis → W3. Kill BETWEEN genesis (seq 1) and W3: replay → store
  exists → `foreignWriteAuthorityFor(P, alice)` = acl (alice OWNER,
  `server.ts:5022-5028`) → the mount sees the ACL exists
  (`aclNeverCreated` false, `v2.ts:1110-1115`) → no second genesis → W3
  lands (CAS no-op on identical values, §2b). Kill AFTER W3 but before
  the home commit: replay → acl grant → no genesis → W3 re-applies as
  the same values → home commits. All three converge on ONE ACL with
  alice as OWNER.
- Concurrent initializer (a client-side genesis for the same P — only
  in a mixed/OFF posture, or a second serving process): the bootstrap
  tolerates `ConflictError` (`v2.ts:1187-1194`); the client's content is
  the SAME `{ [alice]: OWNER, "*": WRITE }` (`v2.ts:1167`) → convergent.
  The bootstrap session id is random per attempt (`v2.ts:1133-1136`), so
  no replay-mismatch hazard on (session, localSeq).
- The result: "the first commit happens under the space's own identity,
  the rest is then the user's" — W3 and every later write into P are
  delegated under alice (or a client session as alice); the service is
  neither owner nor actor at any step.

## 6. Q4 — the READ side, separated

What the loopback plane needs to READ once the OWNER blanket is gone:

- **R1 — the SERVED space itself.** The serving runtime's loopback
  session on the space it serves (`space-server.ts:669`,
  `runtime.storageManager.open(space)`; subscriptions deliver frames
  `:1736`) — `session.open` needs READ (`server.ts:2355-2363`; no
  lease-holder bypass exists in `#authorizeMessageWithEngine`). Home
  spaces are OWNER-ONLY (`v2.ts:1165` `{ [signer.did()]: "OWNER" }`,
  no `"*"`), so serving ANY user's home space at all needs a grant.
- **R2 — the DEMANDING user's home space** (foreign, space-scope docs
  `defaultPattern.profiles/defaultProfile/mru/favorites/journal/
  learned` — `wish.ts:818-956`, `:422-520`; `getHomeSpaceCell` →
  `runtime.ts:2665-2686`) — the P7 base-ON failure
  (`p7-build-report.md:47-50`).
- **R3 — fresh `.inSpace()` spaces** (seq 0 → authenticated READ,
  `server.ts:1225`; after genesis `"*": WRITE` → covered).

Options:

- **(a) FP2's read row** (`protocol.md:309`, `server.ts:4280-4313`,
  `#denyExplicitInstanceReads` `:4314+`) — is about NAMING an
  `entity_scope_key` on a scoped root as a live lease holder. It runs
  AFTER and INDEPENDENTLY of the ACL READ check (`:2838-2853` then
  `:2880+`); it grants no ACL capability. Different row. Does not
  cover R1/R2/R3.
- **(b) a read-only service class in the memory ACL policy** —
  `acl.readOnlyServiceDids`: in `#resolveCapability`
  (`server.ts:1205-1230`) a listed principal resolves as an ordinary
  principal and is then FLOORED at READ (max(explicit grant, READ));
  `#validateAclCommit`'s genesis arm (`:1380-1389`) unchanged (a
  read-only principal may NOT initialize); ACL-doc writes still need
  OWNER; `#revokeDeauthorizedSessions` (`:1413-1440`) never revokes it
  (it always holds READ). Covers R1/R2/R3. Honest, because the process
  already reads every engine directly as the deriver (`server.ts:
  4944-4954` `engineForSpace`; the read row's own trust argument
  `protocol.md:417-424`) — the class grants nothing the process does
  not structurally have, and it grants NO write. Smallest shape:
  one option field, one arm in `#resolveCapability`, one predicate.
- **(c) delegated READ under the acting user** — the grant-scoped read
  DESIGN (`protocol.md:443-469`), fail-closed interim landed with P5
  (producer refusal `v2.ts:991-995`; admission refusal `server.ts:
  4509+`), per-doc grant resolution owed on OW13. It cannot cover R1
  (`session.open` has no acting user; the wire carries
  `entity_scope_key` per root, not an acting principal per query),
  and it is a protocol addition sized like OW13. Also R2's reads are
  SPACE-scope docs (the "free" foreign read row, `protocol.md:500`),
  not scoped instances — the design targets the wrong reads.

**Recommendation: (b).** What it needs: the memory-server option +
arm + tests (B1); the toolshed flag helper split into an OWNER list
(configured verbatim, both arms) and a READ-ONLY list (ON: the process
identity; OFF: empty) (B2); the spec sentences (§10). Note honestly
that (b) also floors the toolshed's OWN `productionServer` runtime's
sessions at READ everywhere under ON (same identity) — a READ widening
relative to OFF-unconfigured, bounded by process trust (flag F5). An
alternative that avoids even that — a DERIVED loopback identity used
only by the serving plane — would move the DR1 holder identity
(`executionLeaseHolder(serviceIdentity)`, `server.ts:4386-4400`) and
FP2's holder matching; larger, not needed for the ruling (flag F7).

## 7. Q5 — what breaks / what protects

**Removing the OWNER blanket with NOTHING else** (per the code, gate-
unevidenced except where cited):

- R2 → `AuthorizationError … lacks READ on space <home>` (the P7 base-ON
  signature ×4/run, `p7-build-report.md:47-50`) — the served `#profile`
  wish throws at resolution → the lunch gate red at step 1 (its join UI
  needs `#profile`); two-browsers likewise. (Both are already
  ON-skip-listed for OW32; this adds a second, independent reason.)
- R1 → `session.open` denied for the serving runtime on every owner-only
  home space → activation fails (`host.ts:391 activate-failed`) or the
  first sync fails → `loop-failed` park + backoff (`host.ts:298-345`).
  Under ON the client does not commit derivations
  (`runtime.ts:1913-1927`), so every private-home-space piece stops
  deriving. This was masked by the P7 blanket and is invisible under
  `MEMORY_ACL_MODE=off` (most in-process tests) and on `"*": WRITE`
  shared spaces (the lunch space).
- Served create (`.inSpace()`) — genesis is space-identity-signed and
  unaffected; P's data commit is engine-direct and unaffected; the
  P-provider's session opens fine (seq 0 → READ; after genesis `"*"`).
- W7 (ingest/webhooks under ON) → back to the configured list: a
  deployment that never listed the operator DID loses ingest into
  private spaces under ON exactly as under OFF (the documented posture,
  `ingest-channels-journal-sink.md:108-114`).

**With (b) + B3/B4 (the ruled posture):** R1/R2/R3 keep working; no
served write path changes identity (they were already delegated); the
only behavior change on the write side is W4's content and W3's
ordering. Any RESIDUAL session-plane WRITE by the process identity into
a user space (none found in the code read — the seal destination covers
the whole activation) would now surface as `AuthorizationError` — which
is the point; the `observe`-mode canary (B6) counts them
(`server.ts:1171-1174 aclStats.wouldDeny`, logged `:1276-1279`) before
`enforce` ever refuses one.

**What the ruling protects:**

- A compromised or buggy serving PROCESS can no longer write arbitrarily
  into user spaces over its session plane (READ-floored, never OWNER);
  its engine-direct writes stay gated by the ACTING identity's structural
  grant (`foreignWriteAuthorityFor`) and, for derived commits, by the
  lease. Note the residual truthfully: the sink is engine-direct by
  design (process trust) — the ruling narrows the SESSION plane and the
  ACL CONTENT, it does not add a cryptographic barrier around the sink
  (that is OW13/attestation, `protocol.md:398-401`).
- Audit attribution: `acting_principal` shows the user on every served
  provisioning write (already true), AND the space's ACL shows the USER
  as owner — the service DID appears nowhere in a user-created space's
  ACL (new pin).
- The wave's accept gate and the delegated admission are unchanged —
  no new trust is minted anywhere; the change REMOVES an implicit grant
  and CORRECTS one document's content.

## 8. Q6 — OFF-arm; pre- or post-merge

- `memoryServiceDidsFor` OFF = the configured list verbatim
  (`server-execution-flag.ts:63-75`, pinned `server-execution-flag.test.
  ts:76-91`). The replacement keeps that: OFF → OWNER list = configured
  verbatim, READ-ONLY list = empty → the memory server's new arm is a
  no-op for an empty list → byte-identical ACL decisions. B3's owner
  parameter defaults to `signer.did()` for clients and is only supplied
  on `servingPosture` runtimes; B4 lives in the SpaceServer's commit
  step and the sink (ON-only machinery). So the change is
  **OFF-invisible** (witness: the runner OFF suite + the memory suite
  green, plus the acl-bootstrap tests unchanged for the client shape).
- Therefore it can land **post-merge** of the stack (owner posture:
  land OFF, then optimize) — but it MUST land **before the flip PR**
  (the register's trigger stands): under ON the OWNER blanket is live,
  and the served create mints service-owned spaces. Recommend: its own
  PR in the post-merge train, ahead of the flip, with the pins below;
  it also unblocks the honest re-tensing of the plan's Phase-7
  precondition (1) (`docs/plans/server-execution-v2.md:920-925`).

## 9. Build work order

Ordered; each item red-first where a pin is named.

**B0 — Observe before changing (the unpinned fact).** An executor-level
probe on an in-process memory server with `acl.mode: "enforce"`: a
served handler run (acting = alice, `event-consequence:` carriage)
performing `.inSpace()` provisioning; assert what P's ACL is at the end
of the wave. Expected TODAY: `{ [SERVICE]: "OWNER", "*": "WRITE" }` (or
missing if the sink won the race). This becomes the red half of pin P2.

**B1 — Memory ACL: read-only service class.** `Server` option
`acl.readOnlyServiceDids?: readonly string[]` (`server.ts:1106-1109`);
`#isReadOnlyServicePrincipal`; `#resolveCapability` arm: ordinary
resolution, then floor at READ. Genesis arm and ACL-doc OWNER rule
unchanged. Pins (`packages/memory/test/v2-server-acl.test.ts`): (i) a
read-only principal opens/queries an OWNER-ONLY space (READ); (ii) its
transact WRITE is refused (`enforce`) / would-deny counted (`observe`);
(iii) its ACL-doc write is refused (OWNER); (iv) it CANNOT initialize a
fresh space (`Only the space identity or a service DID may initialize`);
(v) an explicit ACL WRITE grant to it still yields WRITE (floor, not
cap); (vi) an ACL change never revokes its session. Doc: the policy
comment `server.ts:1091-1104` + `docs/development/CONFIGURATION.md:153`
(new row `MEMORY_READONLY_SERVICE_DIDS`? — NOT needed as an env var for
this ruling: the only member is the process identity under the flag;
keep it code-set to avoid a new operator knob — flag as a choice) +
`docs/specs/memory-v2/04-protocol.md:740-751` + INV-13 note.

**B2 — Toolshed flag helper.** `memoryServiceDidsFor` →
`memoryAclPrincipalsFor({ configured, processIdentityDid, serverExecution })
→ { serviceDids: configured, readOnlyServiceDids: serverExecution ?
[processIdentityDid] : [] }` (dedupe against `configured` — if the
operator listed the process identity as an OWNER-class service DID,
verbatim wins and the read-only listing is moot; LOG that under ON, do
not refuse — flag F1). `routes/storage/memory.ts:22-37, 64-67` passes
both; the log line `:31-37` re-worded ("READ-ONLY memory service
principal"). Pins (`server-execution-flag.test.ts:68-110`): OFF →
`{ [configured], [] }` byte-identical; ON → the process identity is in
the READ-ONLY list and NOT in `serviceDids` unless configured; the
absolute pin "under ON the process identity is not an OWNER-class
service DID by default".

**B3 — Genesis owner = the acting user (RULED shape).**
`registerSpaceIdentity(identity, { owner? })` (`v2.ts:951-953`);
`bootstrapAcl` (`v2.ts:1165-1167`) uses `owner ?? signer.did()` on the
non-home arm; `Runtime.resolveSpaceName(name, { owner? })`; the
serving-side supply at `runner.ts:5667-5677` from the frame tx's wave
run context (no actor on a serving runtime → refuse loudly, named error
citing builtins.md §5 / protocol §2b). Pins: (i)
`memory-v2-acl-bootstrap.test.ts` — "bootstrap names the supplied
owner, not the signer" (client shape untouched: existing tests
`:155-446` stay green byte-for-byte); (ii) executor test (B0's probe
turned green): **"a served `.inSpace()` genesis: actor = the space DID
(the ACL commit's session principal is P), ACL owner = the acting user,
the service principal appears nowhere in P's ACL, and P's commit #1 IS
the ACL commit"**; (iii) a served `.inSpace()` with NO acting identity
refuses (no service-owned space is ever minted).

**B4 — Ordering + INV-13 mirror at the sink.** In the SpaceServer's
commit step (after `#resolveForeignEngines`, `space-server.ts:3047`),
for each foreign batch granted `via: "creation"` (retain the probe's
`via` per (space, acting) — `space-server.ts:1107-1118` currently drops
it), `await storageManager.ensureSpaceInitialized(P)` before the sink;
the sink refuses a foreign batch into an engine with `serverSeq === 0`
and no ACL doc (`WaveCommitRejected`, message naming INV-13 / protocol
§2b) — foreign failure ⇒ home withheld ⇒ replay (existing semantics).
Pins: (i) sink unit test — "a creation-granted foreign data commit never
lands before the genesis ACL" (batch into a fresh engine with no ACL →
rejected; with a genesis at seq 1 → applied at seq 2); (ii) executor
kill/replay: kill between genesis and W3, and between W3 and the home
commit → replay converges on ONE ACL `{ [alice]: OWNER, "*": WRITE }`
and identical P docs (template: `executor-wave.test.ts`'s
foreign-failure-withholds-home / requeue-after-foreign-landed pins,
`p5-build-report.md:44-47`); (iii) the accept gate on replay grants via
`acl` (alice OWNER) — mutation: drop the genesis owner → the replay
probe must go red on `acl` (`the ACL of P grants alice nothing`).

**B5 — "The service principal cannot write into a user home space."**
Pins: (i) SESSION plane — a loopback transact as the process identity
into `{ [alice]: "OWNER" }` under `enforce` with the read-only class →
`AuthorizationError` (and `wouldDeny` +1 under `observe`); (ii) WAVE
plane — a bookkeeping (carriage-less) foreign write into alice's home
refuses at accumulation (exists: `executor-cross-space.test.ts`, keep);
a carriage-bearing write acting as bob into alice's OWNER-ONLY home
refuses on the `acl` arm (exists per P5's F1 fix; keep as the negative
twin).

**B6 — Acceptance (gates).** Under the ruled posture (`MEMORY_ACL_MODE=
enforce`, fresh store, private offset — the mandatory protocol):
(i) the lunch gate: NO `lacks READ` AuthorizationError in the toolshed
log (the P7 base-ON signature), `foreignWriteRefusals` 0,
`unstampedSealRefusals` 0, the join UI renders as at P7 (`p7-build-
report.md:75-76`) — i.e. no regression at step 1; the OW32 stall is
NOT this ruling's criterion (both two-user gates stay ON-skip-listed
for OW32); (ii) served create — the profile family is red at base for
`#wish-profile-name-input` (`p5-build-report.md:123-125`), so the
create click's e2e witness may not be available: the executor pin
B3(ii)/B4(ii) is the acceptance for genesis, plus a store dump of a
gate run showing NO `of:<P>` with the service DID as OWNER;
(iii) an `observe`-mode canary run of the same gates counting
`aclStats.wouldDeny` for the process identity — expected 0 WRITE
would-denies; any non-zero names a residual session-plane write to
re-route (wave-stamp it) or grant explicitly — this is how the
"unknown residual" is discharged rather than assumed.

**B7 — Spec/register edits** (§10), plan Phase-7 precondition (1)
re-tensed, `server-execution-flag.ts` and `memory.ts` comments,
`builtins.md` §5 read-authority paragraph, `p7`-era "OWNER-everywhere"
sentences retired.

## 10. Spec text (proposed wording)

**protocol.md §2 — the delegated row (`:306`), append:**
> *Genesis of a provisioned space (RULED 2026-08-18): the FIRST commit
> into a `.inSpace()`-minted space is its ACL, signed by the SPACE'S OWN
> identity (its keys derive from the creation name — CT-1650 — and the
> provisioning runtime holds them only as genesis authority); that ACL
> names the ACTING principal OWNER (`{ [actor]: "OWNER", "*": "WRITE" }`,
> the same shape a client mints) and names the serving identity nowhere.
> Every later write into the space is the actor's — this row's delegated
> carriage — or a client's own session. A `creation`-granted foreign
> batch never lands before that genesis (INV-13's precedence, mirrored at
> the sink); replay converges on the one ACL because actor and keys are
> functions of the creation event.*

**protocol.md §2b — the "read a foreign doc" row (`:500`), replace the
Mechanism sentence:**
> *Mechanism (RULED 2026-08-18, supersedes the Phase-7 OWNER posture):
> the serving runtime's loopback session is admitted by the memory ACL as
> the process identity, which under the flag is a READ-ONLY memory
> service principal — floored at READ on every co-hosted space (what the
> deriver structurally holds), never WRITE or OWNER by that class, never
> a genesis initializer; OFF the flag the operator's OWNER-class list is
> used verbatim and the read-only list is empty. Writes into any user's
> space ride the acting identity's grant (this table's accept gate) or
> an explicit ACL grant — the serving identity is not an implicit owner
> of users' spaces.*

**Memory ACL policy sentence — `server.ts:1091-1104` doc comment,
`docs/specs/memory-v2/04-protocol.md:748` ("The exact space DID and
configured service DIDs retain implicit OWNER…"), `09-invariants.md`
INV-13, `CONFIGURATION.md:153`:**
> *A principal listed as a READ-ONLY service DID holds at least READ on
> every space and nothing further from that class: it may not write
> without an ordinary grant, may not mutate an ACL, and may not
> initialize a genesis ACL — the space identity or an OWNER-class service
> DID remain the only genesis initializers.*

**builtins.md §5 (`:175-186`) — replace the italic Phase-7 paragraph
with the read-only mechanism + the genesis sentence (owner = demanding
user).**

**verification-coverage.md OW31 (`:2639-2665`) → RULED 2026-08-18** with
both owner quotes verbatim (§1), the disposition (blanket → read-only
class; genesis actor = the space DID, owner = the acting user; service
nowhere in the ACL), the pins B1–B5, "OFF-invisible; post-merge, before
the flip PR", and the flags below as sub-rows.

## 11. Refuters / flags (flag-don't-fill)

- **F1 — config-granted OWNER persists.** `MEMORY_SERVICE_DIDS` keeps
  its OWNER-everywhere semantics; the ingest checklist tells operators to
  list the toolshed operator DID there (`ingest-channels-journal-sink.md:
  5, 108-114`; `self-serve-ingest-channels.md:135-140`). If a deployment
  does, the process identity IS an implicit owner of users' spaces by
  config, and this ruling's protection is only as strong as that
  setting. Owner decision, out of OW31: whether ingest moves to
  per-space grants (the docs already name that alternative).
- **F2 — `"*": WRITE` on minted spaces.** The client's rollout default
  for named/anonymous spaces (`v2.ts:1041-1042, 1167`) means the service
  (and every authenticated principal) keeps WRITE on the new profile
  space via the wildcard. "The user is OWNER, the service is not" holds;
  "the service cannot write P" does NOT follow from OW31 — narrowing the
  wildcard is a separate policy question.
- **F3 — derived class untouched.** Derived commits into a served home
  space stay under the lease holder (single-deriver posture, protocol §1;
  per-write annotations carry the demanding principal). The ruling's
  words target provisioning + genesis; if the owner also means derived
  outputs, that is a different (larger) ruling.
- **F4 — the served genesis outcome is UNPINNED today** and race-shaped
  (session mount vs sink apply). B0 observes it before anything moves.
- **F5 — READ widening for the productionServer runtime under ON**
  (same process identity) — bounded by process trust; stated in the spec
  sentence; the derived-loopback-identity alternative (F7) avoids it at
  the cost of moving the DR1 holder identity.
- **F6 — acceptance cannot be "gate green":** both two-user gates are
  ON-skip-listed (OW32); the criteria are the log/counter/ACL assertions
  in B6 and the executor pins.
- **F7 — alternative not taken:** a derived serving-plane identity as the
  read-only principal (keeps the toolshed identity itself unclassed);
  larger (holder identity, FP2 matching, `server-execution.ts:147-150`).
- **F8 — the actor source for B3** must NOT reuse
  `homeSpacePrincipalFor` verbatim (it ratchets the tx's read scope,
  `runtime.ts:2647-2661`); read the context without the side effect.
- **F9 — session replacement mid-commit-step:** `#createInitializedSession`
  closes and reopens the P provider's session (bootstrap → resume,
  `v2.ts:1130-1212`); the sealed foreign ops are held by the accumulator
  and applied engine-direct, not through that session, so a replacement
  should not drop them — verify with B4(ii), not assume.
- **F10 — the two-list helper keeps the OWNER-class list operator-only.**
  If a future stage needs the process identity to WRITE somewhere over
  the session plane, the answer is a wave-stamped path or an explicit
  grant, never re-adding it to the OWNER list — worth one sentence in
  the register so the blanket does not creep back.

Nothing found refutes feasibility: the ruled genesis shape is the
existing client mechanism relocated; the read-only class is a one-arm
policy addition; the write side is already delegated.

## 12. Anchor list (this tree)

- `packages/memory/v2/server.ts` — 1091-1104 policy; 1184-1186; 1205-1230
  (`#resolveCapability`); 1329-1391 (`#validateAclCommit`: 1341-1346
  precedence, 1380-1389 authority); 1413-1440 revocation; 2343-2363
  `openSession` READ; 2593-2617 transact ACL; 2735-2736 cache
  invalidation; 2826-2853 query READ; 2880+ FP2 naming; 4280-4313 read
  row; 4944-4954 `engineForSpace`; 4956-5040 `foreignWriteAuthorityFor`.
- `packages/memory/v2/engine.ts` — 3134-3140; 3155-3229; 3453-3455.
- `packages/memory/acl.ts` — 43-48 `hasConcreteOwner`; 55-61 `isCapable`.
- `packages/runner/src/executor/engine-wave-sink.ts` — 165-225 foreign
  batch (`applyCommit` at 215); 261-279 home derived.
- `packages/runner/src/executor/wave.ts` — 703-718; 1141-1208; 2276-2298;
  2303-2317.
- `packages/runner/src/executor/space-server.ts` — 591-606 sink; 669;
  790; 851/3047 `#resolveForeignEngines`; 1086-1121 grant wiring;
  1156-1222 `#stampRun`; 3347.
- `packages/runner/src/executor/loopback-storage.ts` — 1-9, 22, 66-70.
- `packages/toolshed/lib/server-execution.ts` — 124-185 (149-150 `as`).
- `packages/toolshed/lib/server-execution-flag.ts` — 25-75;
  `…/server-execution-flag.test.ts` — 68-110;
  `packages/toolshed/routes/storage/memory.ts` — 12-37, 58-68;
  `packages/toolshed/env.ts` — 213, 241.
- `packages/runner/src/storage/v2.ts` — 946-953; 976-1016; 1047-1221
  (1092-1099, 1110-1115, 1133-1144, 1165-1182, 1187-1194); 5822-5840.
- `packages/runner/src/runtime.ts` — 1913-1927; 2640-2686; 2711-2728.
- `packages/runner/src/runner.ts` — 5667-5677.
- `packages/runner/src/builder/pattern.ts` — 1059-1083; 1098-1112;
  1127-1131.
- `packages/identity/src/session.ts` — 21-40.
- `packages/patterns/system/profile-create.tsx` — 57-146.
- `packages/runner/src/builtins/wish.ts` — 327-344; 422-520; 818-956;
  1238-1249; 1907-1908; 1969-1997; 2019-2036; 2085-2136; 2149-2175; 2230.
- `packages/runner/src/executor/host.ts` — 298-345, 391.
- `docs/specs/server-side-execution/protocol.md` — 108-127; 300-331;
  368-401; 417-469; 486-573.
- `docs/specs/server-side-execution/builtins.md` — 139-186.
- `docs/specs/server-side-execution/verification-coverage.md` — 2639-2665.
- `docs/plans/server-execution-v2.md` — 916-939.
- `docs/specs/memory-v2/04-protocol.md` — 740-751;
  `docs/specs/memory-v2/09-invariants.md` — INV-13;
  `docs/development/CONFIGURATION.md` — 153;
  `docs/plans/ingest-channels-journal-sink.md` — 5, 108-114.
- Reports: `p7-build-report.md:36-76`; `p7-independent-review.md:194-204`;
  `p7-fix-report.md:34`; `p5-build-report.md:35-50, 108-115, 123-125`;
  `p5-independent-review.md:25-61`; `p5-fix-report.md:35, 153-162`.
