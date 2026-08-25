# Random space identities implementation plan

## Status

Proposed. Not started.

This plan is implemented, migrated, and landed enabled in one pull request. It
has no feature flag, opt-out mode, deprecation period, or mixed old-and-new
creation path.

That one-shot promise applies to the labs runtime and data migration. The
conflicting normative CFC text lives in another repository, so its amendment is
a coordinated specification prerequisite. It lands first and introduces no
runtime phase or compatibility mode.

The change removes the fixed `"common user"` root from space creation. It does
not require a global name registry. Friendly names remain personal Home labels,
and canonical navigation uses space DIDs.

## Decision

Create every new non-home space from fresh cryptographically secure random key
data. Use the resulting space identity only to authorize the first ACL commit.
After a valid ACL exists, the space identity has no implicit authority and its
private key data is discarded.

The initial ACL names the acting user as its only owner:

```json
{
  "did:key:<acting-user>": "OWNER"
}
```

Do not add the current `"*": "WRITE"` rollout grant to newly created spaces.
Changing wildcard grants on existing spaces is a separate access-policy
migration and is not implicit in this plan.

The space's display name is stored beside its DID in the user's Home space. It
is not an input to key generation and is not globally unique.

## Why

The current named-space algorithm derives a private key from two public strings:
`"common user"` and the space name. Equal names resolve to one shared space
across all users, and anyone who knows the name can reconstruct the space's
implicit-owner key.

Writing the acting user's DID into the ACL does not retire that key. The memory
server currently grants permanent implicit `OWNER` when a session principal
equals the space DID. A complete fix therefore has two inseparable parts:

1. stop deriving new space keys from public inputs;
2. limit a space identity to ACL genesis instead of treating it as a permanent
   owner.

The
[`ct-space` recovery design at commit `850bca9ae`](https://github.com/commontoolsinc/labs/blob/850bca9aed74c22773de5caa2b0b81c98713e646/docs/access-recovery.md)
begins space creation by generating a keypair and then addresses recovery of
that key. The
[`ct-space` keyring design at commit `a98c7444b`](https://github.com/commontoolsinc/labs/blob/a98c7444b08a944467171539a1e7baf7082e367d/docs/keyring-architecture.md)
also puts space-key generation in the local trusted boundary. This plan keeps
that boundary but takes a smaller route: because the key has no post-genesis
authority, it does not need long-term backup, synchronization, rotation, or
recovery.

Do not derive a space from the user's identity. A public user DID is no safer
than a public display name. A derivation keyed by the user's private identity
would make that identity a permanent master key and couple space recovery and
rotation to user-key recovery. Adding a counter would still require durable
allocation state. Fresh randomness plus an explicit ACL keeps identity,
authority, and naming independent.

## Specification connections and conflicts

This proposal was checked against the current labs documentation and the full
`commontoolsinc/specs` document corpus at commit
[`5fb2c6435`](https://github.com/commontoolsinc/specs/tree/5fb2c64357f643f7344d00cdb049f0d9e5983ef0).
The other specs projects either treat a space as an opaque `did:key` sharing
boundary or do not constrain space allocation. The material connections are:

- [Home space and user identity](../common/conventions/HOME_SPACE.md) and
  [Home runtime internals](../features/home-space-internals.md) define the home
  space DID as the user DID. They also describe the temporary
  space-authenticated ACL bootstrap. This proposal preserves the DID equality
  and makes the resulting explicit self-owner ACL the durable authority.
- [CFC space principals and role membership](https://github.com/commontoolsinc/specs/blob/5fb2c64357f643f7344d00cdb049f0d9e5983ef0/cfc/03-core-concepts.md#36-spaces-and-role-based-confidentiality)
  make the space DID a confidentiality principal and make administered
  membership an ACL-backed fact. That agrees with separating an opaque space DID
  from its owners.
- Memory v2 already specifies the required ACL-only genesis shape in
  [INV-12 and INV-13](../specs/memory-v2/09-invariants.md#inv-12--acl-mutation-commit-shape).
  Its [protocol](../specs/memory-v2/04-protocol.md#451-current-pass) conflicts
  only where it says the space DID retains implicit `OWNER` for later repair.
  Preserve its genesis rule and remove that post-genesis repair authority.
- [CFC `HasRole` fact generation](https://github.com/commontoolsinc/specs/blob/5fb2c64357f643f7344d00cdb049f0d9e5983ef0/cfc/04-label-representation.md#493-hasrole-fact-generation)
  and its
  [formal membership model](https://github.com/commontoolsinc/specs/blob/5fb2c64357f643f7344d00cdb049f0d9e5983ef0/cfc/formal/Cfc/Membership.lean#L101-L113)
  directly conflict with this proposal. They currently grant reader-or-higher
  membership when `principal === space`, even without an ACL grant. Before the
  implementation starts, remove that branch entirely from CFC `HasRole` and
  formal membership. State that the separate Memory sequence-zero admission rule
  governs ACL genesis without granting CFC membership. An ordinary principal's
  `HasRole` must come from the declared ACL. Configured service authority
  remains the existing separate resolver branch; removing it is not part of this
  plan. The same assumption is recorded in the historical
  [CFC render-membership design](../history/specs/cfc-render-membership-lookup.md);
  retain that file as history rather than treating it as a live contract. Home
  remains accessible because its ACL explicitly names the same DID.
- [CFC trusted derived identifiers](https://github.com/commontoolsinc/specs/blob/5fb2c64357f643f7344d00cdb049f0d9e5983ef0/cfc/02-overview.md#24-trusted-derived-identifiers)
  and
  [CFC causal addressing](https://github.com/commontoolsinc/specs/blob/5fb2c64357f643f7344d00cdb049f0d9e5983ef0/cfc/17-addressing-and-storage.md#171-causal-id-storage-core-cfc-path)
  require deterministic coordination identifiers to be typed runtime values, not
  raw digest-shaped authority. An event-derived creation operation ID must
  follow that contract. It selects an idempotency record and never determines
  the random key or grants access to the resulting space.
- [Server-side provisioning](../specs/server-side-execution/protocol.md#2b-cross-space-writes)
  currently obtains replay convergence by deriving the destination DID from the
  creation event. This proposal preserves the convergence property by durably
  associating that trusted event operation with one random allocation. The
  protocol and its
  [runtime map](../specs/server-side-execution/runtime-mapping.md) must replace
  “re-derive the same DID” with “recover the same recorded allocation.”
- The current [identity tutorial](../tutorial/10-identity-and-security.md),
  [FUSE path specification](../specs/fuse-filesystem/2-path-scheme.md),
  [shell routes](../../packages/shell/README.md#routes),
  [navigation guide](../common/patterns/navigation.md), and
  [shared-profile specification](../specs/shared-profile-space.md#profile-space-identity)
  describe name-derived spaces or name-or-DID routes. They are implementation
  migration targets, not compatible alternate contracts.
- [Pattern import resolution](../specs/pattern-imports/README.md#open-questions)
  already keeps human-readable aliases outside Fabric resolution and treats a
  DID plus an accepted host hint as the runtime boundary. That is the same
  separation used here.
- [Toolshed storage configuration](../development/CONFIGURATION.md#memory-store)
  currently configures Common Memory as per-space SQLite files or one combined
  memory file. It does not provide a private control database or key-protection
  facility. This proposal therefore adds those facilities explicitly instead of
  assuming they already exist or storing allocator secrets in a Fabric space.

The required CFC amendment is a cross-repository preparation result, not a
compatibility phase. It must be accepted before the one-shot labs implementation
pull request. The labs runtime, data migration, and live documentation then land
consistent with it in the single cutover.

## Invariants

1. Every newly created non-home space gets at least 256 bits of randomness from
   the platform cryptographic random-number generator.
2. The display name, user DID, operation identifier, event identifier, clock,
   and process state do not determine the random key data.
3. A space DID is the canonical and permanent address of that space.
4. The space identity may authenticate only a valid ACL-only genesis commit
   while the space has no ACL and server sequence zero.
5. After genesis, only the ACL and configured service identities grant access.
6. The acting user's authenticated DID is the genesis ACL owner. A service
   executing on the user's behalf is not written into the ACL.
7. Random key data never appears in Fabric values, URLs, logs, telemetry,
   errors, or client-visible protocol results.
8. A failed creation does not add a visible Home entry.
9. Re-execution after scheduler replay or process loss reuses the allocation
   recorded for the authenticated principal and logical operation. A
   deterministic operation identifier is a CFC trusted derived identifier and is
   never treated as space authority.
10. A created space's DID-to-host hint is durable before its Home entry becomes
    visible.
11. Random space creation and DID resolution do not depend on a global name
    registry.
12. A canonical URL binds both the DID and its route: an explicit validated host
    for a non-default store, or the deployment's fixed default host. Personal
    Home hints never override that navigation-bound route.
13. Authorization is checked only after the URL selects that common DID and
    host, so viewer identity can change access but never the target.

## Space identity authority

Replace the memory authorization rule in the same pull request that introduces
random creation and migrates legacy data. The replacement lands active; there is
no runtime switch between the two rules.

For a fresh space with no ACL and server sequence zero, a session whose
principal equals the space DID may submit one valid ACL-only genesis
transaction. It cannot perform an ordinary read or any other write. Existing
genesis validation continues to require a concrete owner and the exact
whole-document operation shape.

Once a valid ACL exists, `principal === space` no longer grants `OWNER`. The
principal is evaluated like any other identity against the ACL. This has three
consequences:

- discarding the random private key is safe;
- learning old or transient space key data does not confer lasting authority;
- transferring every ACL grant away from a creator is a real transfer.

Home spaces need no exception. A home space's DID equals the user's DID, and its
genesis ACL explicitly grants that DID `OWNER`. It therefore retains ordinary
access through the ACL after the implicit rule is narrowed.

Configured service DIDs retain their separately declared authority. Repair of a
malformed or ownerless ACL becomes an operator operation through that explicit
authority or offline storage tooling. Do not preserve an ambient space-key
repair path; it would recreate the permanent master key this plan removes.

Apply this authorization change to session open, reads, writes, ACL mutation,
CFC membership, foreign-write authority, and every other place that currently
special-cases `principal === space`. Add one shared capability function or
shared rule vocabulary so those decisions cannot drift.

## Creation primitive

Replace name resolution as a creation mechanism with an explicit `createSpace`
operation. It accepts:

- an operation identifier;
- an optional target storage host selected through the ordinary routing policy.

The storage authority at the target host owns allocation. Browsers, local
clients, and served runs call its signed creation endpoint; they never generate
or retain the space key. The signature binds the method, path, target-host
audience, operation identifier, and canonical request. The authority obtains the
owner DID from that authenticated caller or from the served run's verified
acting-principal proof. The request does not supply an owner field. A missing
acting principal is an authorization failure; the service identity is never
substituted.

An interactive caller obtains an opaque operation nonce from the trusted client
runtime. A replayable event path uses the runtime's typed trusted-derived-ID
form over its principal-bound frame cause and call ordinal. The allocator
rejects a raw event digest in that position. Neither form is a capability for
the resulting DID; request authentication and the genesis rule remain the only
pre-ACL authority.

The target toolshed stores operation records in a Toolshed-private control
database, separate from Common Memory's per-space storage and service Fabric
space. The implementation adds one SQLite file beside the configured memory
store and runs schema migration before accepting traffic. One allocator process
owns that file and the spaces it allocates; deployments with several front ends
route creation to that authority.

Pending key data is encrypted with an authenticated-encryption key supplied by
deployment secret configuration. The local daemon creates one persistent
mode-`0600` key file beside its control database when neither exists. It refuses
to start if only one exists or if the key file is accessible to other users.
Production does not generate a replacement for a missing key. Browser-only
memory and test fakes may implement the protocol for tests, but are not
supported creation authorities.

It returns the new space DID and canonical storage host only after ACL genesis
is confirmed. The random private key remains inside the target storage
authority.

Creation proceeds as follows:

1. Verify the signed request, canonicalize the target host, and look up a
   private durable operation record keyed by the acting principal and operation
   identifier.
2. If the record is absent, generate fresh random key data once, construct the
   space identity, and durably record the host, DID, and encrypted key data
   before opening the space.
3. If a record exists, reuse its allocation. Reject the operation identifier if
   its recorded host or other canonical request fields differ.
4. Open the empty space as its identity and commit the owner-only genesis ACL
   naming the acting user.
5. Atomically mark genesis confirmed and erase the encrypted private key from
   the operation record and every runtime registry.
6. Reopen as the acting user and confirm ordinary access.
7. Return the recorded DID and host.

The operation does not probe for name availability. Two creations with the same
display name produce distinct DIDs.

The operation record is a transaction journal, not a space-key backup. Protect
its pending key data with the control-database encryption key and never place it
in Fabric or a client-visible receipt. Erase the private key as soon as genesis
is confirmed. Retain the non-secret DID, host, owner, request digest, state, and
result for the allocator's lifetime. A delayed or repeated delivery therefore
cannot turn a completed logical operation into a fresh allocation.

A process that stops before genesis resumes with the same pending key. A process
that stops after genesis resumes with the recorded DID. This preserves the
ordered cross-space commit guarantee: child data may commit before a parent or
Home link, but replay addresses the same child space instead of creating a
populated orphan and repeating its effects.

If replay reaches a space whose genesis commit already landed, reopen it as the
recorded acting owner and verify the expected genesis ACL and recorded
allocation before marking the operation confirmed. Allow content authorized
after genesis, including the server-created default root. An ACL or allocation
mismatch is a terminal integrity error; do not allocate a replacement under the
same operation.

Do not add timeouts, sleeps, or automatic retry loops. Completion follows the
genesis commit result, and re-execution consults the durable operation state.

## Home entries and personal names

Make Home's space list a personal address book whose entries contain:

| Field  | Meaning                                                       |
| ------ | ------------------------------------------------------------- |
| `id`   | Stable entry identity, normally the space DID for new entries |
| `name` | Editable personal display name                                |
| `did`  | Canonical space address                                       |

Require all three fields in the final schema. The migration converts or
quarantines every old entry before that schema lands; there is no optional-DID
read path. Address array entities by `id`, not by `name`, so one user may have
two spaces with the same display name and may rename either without changing its
identity.

Home names never participate in URL resolution. They are personal presentation
and command-selection metadata only. A shared URL must carry a DID or use the
separate deployment-wide registry, so its target cannot vary with the viewer's
Home contents.

Keep routing in the existing Home site table rather than adding a host field to
the display entry. Before making a new display entry visible, append the
validated `{ did, host }` hint returned by `createSpace` to that table. A replay
may repeat the same hint and Home mutation, but the principal-bound creation
record makes them refer to the same space.

The site table helps construct links and route non-URL operations; it does not
override a route already bound by a URL. Clicking a Home entry navigates to
`/<space-did>` for the deployment default host or
`/<space-did>?host=<encoded-origin>` for another host. Deep links retain the
same query after the piece address. The shell validates the origin and opens
through that navigation-bound route even when Home contains a conflicting hint.

The shell may display the personal name while the URL remains DID-addressed. A
shared link contains the DID and the host when non-default, and may carry a
non-authoritative suggested label as presentation metadata.

Without a global registry, typing an arbitrary name cannot open an unknown
space. The user selects a Home entry, imports a DID-addressed link, or enters a
DID explicitly.

## Pattern space selection

Make the Pattern Factory surface unambiguous:

- `inSpace()` creates a fresh space for the logical creation event;
- `inSpace(spaceDid)` addresses an existing space;
- `inSpace(cell)` addresses the cell's space;
- `inSpace("name")` is removed.

Anonymous creation already separates a profile's editable display name from its
space identity and carries a durable per-event cause. Replace its final
fixed-passphrase derivation with the random creation primitive. Preserve one
allocation per acting principal, frame cause, and call ordinal across scheduler
and process re-execution. Record the returned route through the same site-table
flow before publishing the parent link.

Persist the resulting DID and host in the parent event's graph state under the
frame cause and call ordinal. Reevaluation consults that state before calling
the allocator. The mapping remains for the lifetime of the persisted parent
event. The allocator also retains its non-secret result record, so a delayed
delivery still converges after the parent has recorded the mapping.

Migrate every repository-owned pattern in the implementation pull request. Do
not rewrite persisted user source automatically: changing source can change its
compiled identity, causes, registrations, and provenance. Preparation lists
every persisted user pattern using named space selection. Its owner must migrate
and reinstantiate it while preserving the intended data, or explicitly accept
that the old instance will stop updating. Given the current negligible user
population, the cutover requires this list to be empty unless a concrete
exception is recorded.

There is no runtime compatibility shim. Recompilation of any remaining
`inSpace("name")` reports a focused error instructing the author to use
anonymous creation, a DID, or a cell.

A name registry, if separately installed, resolves its alias outside pattern
construction and supplies the resulting DID. The Pattern Factory never imports
or calls registry code.

## Shell, CLI, FUSE, and services

Keep the existing `/<space-did>` and `/<space-did>/<piece-address>` path forms.
For a non-default host, add the validated `?host=<encoded-origin>` query to
either form. URL navigation uses that host or the fixed deployment default and
ignores conflicting Home hints.

Remove legacy `/<space-name>` handling entirely. A first path segment that is
neither a built-in nor a DID returns not found uniformly; it is not retained as
a dormant registry hook. If the separate registry is installed, the server may
resolve an exact registered `/<name>` before serving the shell. It can be
implemented or omitted without changing this parser.

Preparation inventories the negligible set of known legacy name and product
links and migrates them directly to DID-and-host URLs in the same pull request.
Arbitrary unrecorded name-only links are accepted breakage rather than a
personal, dormant, or hidden registry.

Remove `createSession({ spaceName })`. Session creation accepts an explicit
space DID, while the shell turns Home selections into explicit DIDs and the new
creation primitive owns random identity generation and genesis.

Replace each other bare-name dependency:

- The shell creates spaces through `createSpace`. It records the returned host
  hint and Home entry before navigating to the canonical DID URL.
- CLI commands accept a DID. Commands with an identity may resolve a personal
  Home display name, and reject ambiguous matches with the matching DIDs.
- FUSE connects DIDs recorded in `.spaces.json`; an unknown directory name does
  not synthesize a space.
- The state inspector accepts a DID, DID prefix, or database path. It does not
  derive a DID from a name.
- Background services and system-space configuration carry explicit DIDs.
- Clone-to-new-space uses `createSpace`, records its returned route, then clones
  to its returned DID.
- Host embedding receives a DID for an existing space or invokes the explicit
  creation operation.

Keep all name handling above the runtime boundary. Once a client selects an
entry, every request below that boundary contains the DID.

## In-pull-request migration

Existing spaces keep their DIDs and data. This is an address-preserving
authority migration, not a re-key of stored contents. The implementation pull
request contains the schema, data, ACL, route, configuration, source, and link
migrations and removes the old path in the same change. There is no period in
which both creation algorithms are supported.

Preparation drafts an explicit manifest while the legacy derivation is still
available. At deployment, the migration quiesces legacy creation and writes,
drains old server instances and sessions, configures the new server to reject a
missing or old client protocol version before subsequent reads, takes a final
authoritative inventory at a fixed storage revision, and reconciles the draft
before changing data. The terminal incompatibility response instructs the user
to reload; it does not assume the old client can reload itself. The inventory
records every known named space's DID, host, verified owner, and personal
display name. The new binary does not start if a live space is unclassified or
differs from its reconciled entry.

The migration is a durable, resumable operation because its writes span many
Fabric spaces, ingest state, and product configuration and cannot share one
atomic commit. Its toolshed ledger records the fixed source revision, manifest
digest, each target's expected revision and completion, both security-audit
results, and a final cutover marker. Every step is idempotent and refuses an
unexpected revision. A crash leaves the write barrier in place and resumes from
the ledger; it does not roll back completed repairs.

The new binary serves only after the final marker proves that concrete ACL
owners, Home DIDs and display names, site-table routes, configuration, and
security cleanup all completed. Populated spaces that cannot be assigned a
verified owner are retired rather than kept behind a compatibility exception.
This is one bounded deployment operation, not a coexistence period.

The implementation also fulfills the current security tripwire. It retires
ingest channels minted under publicly reconstructible keys, removes explicit ACL
grants to non-home spaces' own DIDs, preserves legitimate home self-owner
grants, and checks for unexplained concrete owners. A signature made with the
old key is not evidence that its grant is legitimate.

After migration, the repository contains no executable production copy of the
fixed passphrase or its derivation algorithm. Documentation and migration
records may describe the former behavior.

## Relationship to a name registry

This plan does not define a public name-resolution service. Its only mapping is
the user's personal Home list, which is sufficient to render and reopen their
own spaces.

If the separate name-registry plan is already implemented, a caller may claim an
alias with the returned DID and host after `createSpace` returns. If it is
implemented later, existing random space routes can be registered without
migration. If it is never implemented, every operation remains complete through
DIDs, site-table hints, and Home labels.

There is no shared creation transaction, schema, storage table, capability, or
fallback between the two plans.

## Preparation

- Amend the CFC `HasRole` specification and formal membership model to remove
  the `principal === space` branch entirely. Cross-reference Memory's separate
  sequence-zero ACL-genesis admission rule, which grants no CFC membership.
  Record the accepted specs commit in the implementation decision record.
- Catalog every production derivation and every implicit `principal === space`
  authorization check, including session, storage, CFC, worker, CLI, FUSE,
  inspector, embedding, test-helper, and Pattern Factory paths.
- Inventory hosted spaces by ACL state, route, owner, Home entry, and known
  user-facing name. Produce the explicit migration manifest and identify any
  populated space that must be retired because it has no verified owner.
- Run the ingest-channel audit and retirement dry run, and record the exact
  cleanup required by the derivation tripwire.
- Select the Toolshed-private control-database path and deployment secret
  source. Define local key-file creation, permissions, backup, restore, and
  missing-or-mismatched database and key failure behavior.
- Inventory repository-owned and persisted user `inSpace("name")` calls,
  including instantiated patterns. Record the instance identity, cells, links,
  provenance, and execution registration needed for owner-led migration.
  Inventory product-operated and known shared bare URLs so their direct
  replacements are part of the implementation diff.

Preparation produces a decision record and migration manifest as inputs to the
implementation. They are committed with the implementation, not landed
separately. Preparation adds no runtime code, schema, flag, or compatibility
path.

## Implementation

- Land one enabled cutover in one pull request:
  - Define one shared authorization rule: a space principal may submit only an
    ACL-only genesis transaction to a sequence-zero space with no ACL; afterward
    the ACL and configured service identities are the only authority.
  - Apply that rule consistently to session open, reads, writes, ACL mutation,
    CFC membership, foreign-write authority, and serving paths, with no home or
    legacy-name exception.
  - Add `createSpace` with an owner derived only from authenticated execution
    context and a canonical target host.
  - Put allocation behind a signed endpoint owned by the target toolshed. Bind
    the target-host audience and operation identifier, verify browser identity
    or served acting-principal proof, and return only the DID and host.
  - Implement the same endpoint and durable journal contract in the local
    toolshed daemon; do not make a browser-only runtime a supported allocator.
  - Add the private SQLite control database, schema migration, single-authority
    routing, deployment-supplied encryption key, and protected local key-file
    lifecycle. Keep this store independent of Common Memory and the service
    Fabric space.
  - Add the private durable operation record keyed by acting principal and
    logical operation identifier, with request-digest conflict detection.
  - Represent event-derived operation identifiers through the CFC trusted
    derived-ID contract. Reject raw event digests, and keep the operation ID an
    idempotency key rather than an authorization token.
  - Generate at least 256 cryptographically random bits once per allocation,
    protect the pending key at rest, erase it after confirmed genesis, and keep
    the non-secret DID, host, owner, request digest, state, and result for the
    allocator's lifetime.
  - Commit an owner-only genesis ACL, close the bootstrap session, remount as
    the acting user, and return the recorded DID and host.
  - For anonymous `inSpace()`, persist the DID and host under the parent frame
    cause and call ordinal, and consult that graph state on every reevaluation.
  - Make `id`, `name`, and `did` required in the final Home schema, address
    entries by `id`, and publish the DID-to-host site-table hint before exposing
    a new entry.
  - Remove legacy name parsing. Keep DID path forms and add a validated host
    query for non-default stores; bind each URL navigation to that explicit host
    or the fixed deployment default, ignoring conflicting personal hints.
  - Change Home, hosted authoring, clone-to-new-space, host embedding, CLI,
    FUSE, state inspection, services, and test helpers to create randomly or
    open an explicit DID.
  - Change anonymous `inSpace()` to use the random primitive, remove
    `inSpace("name")`, migrate every repository caller to an explicit DID or
    anonymous creation, and emit a focused source error for code that still uses
    the removed form.
  - Make deployment enter a write barrier, stop legacy creation, drain every old
    server instance and session, and reject missing or old client protocol
    versions before reads with a terminal response instructing reload. Then take
    the final inventory at a fixed storage revision.
  - Reconcile the prepared manifest against that revision and refuse to start
    the new binary while any live space is missing, stale, or still writable by
    the legacy protocol.
  - Apply the reconciled manifest before serving with the new rule: install
    verified ACL owners, preserve home self-owner grants, add Home DIDs and
    labels, add DID-to-host hints, and retire unowned populated spaces.
  - Run those cross-store writes through a durable toolshed migration ledger
    with the fixed source revision, manifest digest, per-target expected
    revisions, idempotent completion records, security-audit results, and a
    final cutover marker.
  - Keep the write barrier after a crash, resume incomplete ledger entries, and
    make the new binary refuse traffic until the final marker exists.
  - Migrate product configuration, examples, favorites, durable links, host
    messages, and every known legacy name URL to explicit DID-and-host URLs.
  - Run the confirmed ingest-channel retirement, remove unexplained ACL owners
    and explicit grants to publicly derived non-home space DIDs, and verify both
    audits are clean.
  - Delete `createSession({ spaceName })`, runtime name-to-DID derivation and
    caches, all production copies of `"common user"`, and tests that equate a
    name with a DID.
  - Remove the derivation tripwire and its task entry only after its audit,
    retirement, and ACL obligations have completed in the same change.
  - Update live identity, Home, URL, FUSE, CLI, embedding, pattern, and security
    documentation. Historical records may retain the former behavior.
  - Test same-name creation, user separation, display-name rename stability, ACL
    genesis and post-genesis denial, home self-access, host-route restart,
    ambiguous CLI display names, user-independent URL resolution, repository and
    persisted pattern migration, and absence of a registry dependency for
    creation and DID navigation.
  - Kill the creator before genesis, after genesis, after child data, and before
    parent or Home publication; prove replay converges on the recorded DID
    without repeating child effects.
  - Erase a completed record's pending key material, restart, and reevaluate a
    persisted parent. Prove both its graph mapping and the allocator's retained
    result select the original child DID.
  - Add a repository check forbidding the fixed passphrase and derivation in
    executable production code, configuration, and test vectors. Explanatory
    documentation and migration records are allowed.

The pull request lands with random creation and the narrowed authorization rule
active. It contains no dormant implementation, opt-out, dual-read, dual-write,
or deprecated creation path.

## Acceptance criteria

- Two creations with the same acting identity and display name have different
  DIDs.
- Two different users choosing the same display name have different DIDs.
- Re-executing one active creation operation before completion returns the same
  DID.
- Re-executing after a process exit returns the same DID, including when child
  data committed before its parent link.
- The Home entry appears only after successful ACL genesis.
- Before genesis, the space principal can submit only the ACL-only genesis
  transaction and cannot perform an ordinary read or another write.
- A non-default-host space reopens after restart through its durable site-table
  hint.
- A DID URL selects the same DID and host for every viewer; authorization may
  grant or deny access only after that target is selected.
- Two viewers with conflicting Home host hints still open the URL-bound host.
- Without a registry match, a legacy name URL returns not found uniformly and
  never allocates a space.
- Every known legacy name link in the preparation inventory is replaced with a
  DID-and-host link; no unresolved link is silently retained.
- A new ACL contains the acting user as `OWNER` and no wildcard grant.
- The bootstrap key cannot open or mutate the space after genesis unless the ACL
  explicitly grants its DID access.
- The actual owner can read, write, and change the ACL after remount.
- A home space continues to work through its explicit self-owner ACL.
- Anonymous `inSpace()` remains stable across scheduler re-execution and
  distinct across logical creation events.
- Anonymous `inSpace()` selects the same DID after restart and delayed duplicate
  delivery for the full lifetime of its persisted parent event.
- A remaining `inSpace("name")` call produces the focused source-migration
  error; there is no runtime fallback.
- Every persisted named-pattern instance is either migrated and reinstantiated
  by its owner with its data relationships verified, or recorded as accepted
  breakage before deployment.
- All runtime, storage, and durable links use DIDs.
- Space creation and DID navigation work with no name-registry service or code.
- Existing migrated spaces retain their original DIDs and data.

## Out of scope

- A global or deployment-scoped public name registry.
- Re-keying existing space contents to new DIDs.
- Long-term recovery, synchronization, or escrow of a space key after genesis.
- Automatic changes to existing wildcard ACL grants.
- General user-identity recovery and rotation.
- Cross-provider name federation or `did:web`.
