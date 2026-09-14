# Random Space Identity Implementation Plan

## Status

Proposed one-shot implementation plan. The change lands enabled everywhere and
includes its data migration. It has no feature flag, compatibility mode, or
deprecation phase.

This plan removes the fixed `"common user"` root from space creation. Every new
ordinary space gets a fresh random key pair and therefore a fresh DID. The
creating user's identity becomes the initial owner through the genesis ACL.

The plan uses the DID form defined by
[Common Fabric URLs](../specs/fabric-urls.md). It does not implement DNS
namespaces or a name registry. Those can land independently through the
[space name registry plan](space-name-registry.md). If the registry is absent,
new spaces use DID URLs and Home stores editable display labels.

## Principles

- A space DID comes from fresh cryptographic key data. It does not come from a
  display name, user DID, account DID, or provider hostname.
- Equal labels do not imply equal spaces. Renaming a label does not change a
  space DID.
- The bootstrap private key has one job: authorize the genesis transaction. It
  is destroyed after durable ownership has been established.
- The genesis transaction is the first valid state for the new DID. It assigns
  the creating user as owner before ordinary writes are accepted.
- Repeating a completed create request returns the original result. Repeating a
  new create action creates a different space.
- Creation is complete only after the genesis transaction and the creating
  user's `homeSpaceCell.spaces` entry have both committed. Every ordinary
  space-creation path performs that registration; callers do not add it as a
  separate best-effort step.
- Browser URLs identify the initial ASP with their hostname and the space with
  its DID. They do not carry a host query parameter.
- This change contains no partial support for future names. Display labels are
  Home metadata and have no resolution semantics.
- Generate at least 256 bits of entropy with the platform cryptographic random
  source. The label, user DID, operation identifier, clock, and process state do
  not contribute key material.
- Do not derive spaces from a user's private key. That would turn user-key
  recovery and rotation into a permanent master-key problem for every space.
- The space DID can authorize one ACL-only genesis transaction at sequence
  zero. After genesis, the space DID has no implicit owner or repair authority.
- Newly created spaces do not receive an ambient `"*": "WRITE"` grant. Their
  first owner is the authenticated creator.

## Connected specifications

- [Common Fabric URLs](../specs/fabric-urls.md) supplies the browser DID form.
  The random identity plan does not define a competing URL or name resolver.
  If the separate registry plan is present, a source ASP can preserve this DID
  URL with a space-move redirect after moving the space to another ASP.
- [Home space and user identity](../common/conventions/HOME_SPACE.md) and
  [Home runtime internals](../features/home-space-internals.md) keep the Home
  space DID equal to the user DID. Its explicit self-owner ACL remains the
  durable authority after genesis. The random identity change adds an ordinary
  `spaces` field to the existing Home space root and ordinary creation-record
  documents within the Home space. The existing Home site table remains the
  per-user source of DID-to-ASP routing hints.
- [Memory v2 genesis invariants](../specs/memory-v2/09-invariants.md#inv-12--acl-mutation-commit-shape)
  already require the ACL-only first transaction. The
  [current-pass protocol](../specs/memory-v2/04-protocol.md#451-current-pass)
  must lose the conflicting permanent implicit ownership of the space DID.
- [CFC space principals and role membership](https://github.com/commontoolsinc/specs/blob/5fb2c64357f643f7344d00cdb049f0d9e5983ef0/cfc/03-core-concepts.md#36-spaces-and-role-based-confidentiality)
  agree that a space DID is a confidentiality principal whose membership is
  administered.
- [CFC `HasRole` fact generation](https://github.com/commontoolsinc/specs/blob/5fb2c64357f643f7344d00cdb049f0d9e5983ef0/cfc/04-label-representation.md#493-hasrole-fact-generation)
  and the
  [formal membership model](https://github.com/commontoolsinc/specs/blob/5fb2c64357f643f7344d00cdb049f0d9e5983ef0/cfc/formal/Cfc/Membership.lean#L101-L113)
  currently grant membership when the principal equals the space. Preparation
  must amend both so the special case admits genesis without creating permanent
  CFC membership.
- [CFC trusted derived identifiers](https://github.com/commontoolsinc/specs/blob/5fb2c64357f643f7344d00cdb049f0d9e5983ef0/cfc/02-overview.md#24-trusted-derived-identifiers)
  and
  [CFC causal addressing](https://github.com/commontoolsinc/specs/blob/5fb2c64357f643f7344d00cdb049f0d9e5983ef0/cfc/17-addressing-and-storage.md#171-causal-id-storage-core-cfc-path)
  govern replay-stable operation identifiers. Those identifiers select an
  allocation record and never determine key data or authority.
- [Server-side provisioning](../specs/server-side-execution/protocol.md#2b-cross-space-writes)
  and its
  [runtime map](../specs/server-side-execution/runtime-mapping.md) must recover a
  recorded random allocation during replay instead of re-deriving a DID.
- The [FUSE path specification](../specs/fuse-filesystem/2-path-scheme.md),
  [shell routes](../../packages/shell/README.md#routes),
  [navigation guide](../common/patterns/navigation.md), and
  [shared-profile specification](../specs/shared-profile-space.md#profile-space-identity)
  are migration consumers of the explicit create-and-open split.
- [Toolshed storage configuration](../development/CONFIGURATION.md#memory-store)
  does not provide the private allocation record or pending-key protection.
  The implementation adds that control storage explicitly.
- Earlier `ct-space`
  [recovery](https://github.com/commontoolsinc/labs/blob/850bca9aed74c22773de5caa2b0b81c98713e646/docs/access-recovery.md)
  and
  [keyring](https://github.com/commontoolsinc/labs/blob/a98c7444b08a944467171539a1e7baf7082e367d/docs/keyring-architecture.md)
  designs generated fresh space keys but retained them. This plan keeps their
  random allocation boundary and avoids long-term key recovery by removing the
  key's authority after genesis.

## Preparation

- Inventory every production and test path that creates, opens, serializes,
  lists, or schedules work for a space. Include the shell, CLI, runtime,
  PatternFactory, background execution, FUSE, agents, toolshed, fixtures, and
  migration scripts.
- Inventory every use of `"common user"`, `spaceName`, passphrase derivation,
  and assumptions that equal names imply equal DIDs.
- Inventory existing spaces created by deterministic name derivation. Record
  each DID, current owners, public ASP origin, storage origin, user-facing URLs,
  Home references, and stored cross-space links.
- Confirm that the user-facing named-URL inventory is empty, as expected from
  the stated near-zero-user deployment. Rewrite any unexpected managed links to
  DID URLs and explicitly retire unmanaged legacy names during preparation.
  Do not add a redirect table or make the change depend on the registry plan.
- Prove the exact ACL transaction that grants ownership and the validation rule
  for the first commit of a new DID.
- Land the coordinated CFC specification and formal-model amendment that removes
  permanent membership from `principal === space`. This is a research and
  specification prerequisite, not a runtime phase in the labs pull request.
- Select the existing identity library's secure random key-generation API.
  Confirm that it uses the platform cryptographic random source and emits the
  supported space DID method.
- Define an idempotency key for one user create action. It must survive client
  resubmission and server-process changes without becoming part of the DID.
- Define the `spaces` field on the ordinary Home space root. Define the stable
  cause and schema for one ordinary Home-space creation-record document. Confirm
  that a single Home-space transaction can complete that document while
  updating `spaces` and the existing Home site table atomically.
- Confirm that the normal pattern-update machinery can rebind the stored input
  of an existing standard Home root while preserving its result cell and output
  links. The migration uses that operation to supply the new `spaces` input.
- Define the content-authorization rule for Home creation records. It permits
  one `authorized` record followed by one `completed` or `abandoned` terminal
  transition. It must reject every other replacement and deletion even when an
  ordinary Home-space ACL would otherwise authorize the writer.
- Identify the configured Home operator recovery identity and define the signed
  evidence it may use when a permanently unavailable target ASP has been fenced
  and its authoritative control database recovered.
- Confirm that every production toolshed process shares the durable create
  request store and space storage. Creation must not depend on process-local
  state.

## Changes to make

- Add one space-creation operation shared by every caller.
  - Accept a creator-authorized creation intent containing the creator DID, an
    opaque idempotency key, the authenticated Home ASP origin, the target public
    ASP origin, and an optional initial display label. Obtain the Home ASP from
    the authenticated session rather than a free-form caller field.
  - Before allocating a DID, verify that the intent authorizes one Home
    registration for the result bound to that creator, idempotency key, and
    target ASP. This authority cannot write any other Home data.
  - Persist the validated intent, then have the authenticated Home ASP commit
    its `authorized` Home creation record. Generate key data only after the
    target ASP has observed that commit.
  - Generate a fresh random space key pair only while that durable and
    Home-authorized request has no allocation. Use at least 256 bits of entropy
    from the platform cryptographic random source.
  - Derive the space DID from the generated public key.
  - Build an ACL-only genesis transaction with no prior version. Grant only the
    creator the owner capability in the ACL representation used by ordinary
    authorization.
  - Sign only that genesis transaction with the space private key.
  - Record the request before submitting genesis. Never report success before
    durable state can reproduce the result.
  - Treat Home registration as part of this operation. Do not expose a second
    caller-managed "add to Home" operation for newly created spaces.
  - Destroy every in-memory and serialized copy of the private key after
    genesis commits. Do not return it to the shell, store it in Home, or place
    it in logs.
  - Obtain the normalized storage origin from the target ASP's authenticated
    creation result. Keep it distinct from the public ASP origin used in browser
    URLs.
  - Return the space DID, public ASP origin, storage origin, and committed
    genesis reference only after the corresponding Home registration has
    committed.

- Make creation safe across parallel toolshed processes.
  - Store create-request ownership and results in a toolshed-private PostgreSQL
    control table shared by every process for the ASP.
  - Use a unique database constraint on creator DID plus idempotency key so two
    frontend processes cannot generate two accepted results for one action.
  - Store the authorized creation intent in an `intent-recorded` row before
    contacting Home. Change it to `home-authorized` only after observing the
    matching Home creation record. A later conditional transaction changes it
    to `allocated` and stores the DID and encrypted pending private key. Encrypt
    pending key data with an authenticated-encryption key supplied as a
    deployment secret.
  - If concurrent processes generate candidates for one `home-authorized` row,
    accept only the key stored by the conditional transition. Destroy every
    losing candidate without publishing its DID or genesis transaction.
  - Use explicit `intent-recorded`, `home-authorized`, `allocated`,
    `genesis-committed`, `complete`, `rejected`, `abandoning`, `abandoned`, and
    `inconsistent` states. A process that receives the same request returns its
    completed result, resumes its unfinished state, or reports its terminal
    state. It cannot replace an accepted allocation. `Abandoning` remains
    unfinished until Home records the matching terminal state.
  - Ensure a losing concurrent process reads the durable request. It returns a
    completed result or resumes the recorded allocation. It must not publish an
    unused key or genesis transaction.
  - After observing committed genesis, delete the encrypted pending key and mark
    the genesis step complete in one control-database transaction. If a process
    exits between those actions, a later request observes genesis and performs
    the deletion. The key has no post-genesis authority while it awaits
    deletion. Do not mark the overall request complete until Home registration
    has committed.
  - Fence a failed database or storage writer before another writer accepts the
    same request.
  - Treat unfinished control rows as durable work. Process them when they are
    committed and when a toolshed process starts, so recovery does not depend on
    the original frontend process.
  - Expose a durable creation-state lookup for Home registration. Require the
    matching creator-authorized intent, serve the result from every toolshed
    process, and retain it at the original public ASP origin through completion.
    Return an allocation result only from `genesis-committed` or `complete` and
    include the committed genesis reference. Return no-DID abandonment evidence
    only from `abandoning` or `abandoned`. Do not expose request enumeration.
  - Use bounded connection pools and request sizes. Apply backpressure when the
    service is saturated.
  - Keep decrypted private key material only in the process performing the
    accepted creation. Do not pass it through queues that persist request
    bodies.

- Register every created space using ordinary data in the creator's Home space.
  - Add `spaces` to the existing Home space root. Represent it and each creation
    record as ordinary Fabric cells governed by ordinary schemas, transactions,
    and content authorization. Do not add a directory manager, private index, or
    special resolution API.
  - Key entries in `homeSpaceCell.spaces` by space DID using the normal
    `elementById()` and `addUnique()` operations. Store the full DID, optional
    editable display label, and public ASP origin. Equal labels are allowed and
    do not affect entry identity.
  - Protect each entry's stored DID with ordinary content authorization. Its
    initial value must equal the DID used as the `elementById()` key, and later
    transactions cannot change it. The label and public ASP origin remain
    editable, and users may remove the entry's collection membership.
  - Record the authenticated storage origin in the existing Home site table.
    Do not substitute the public ASP origin unless that ASP serves memory
    traffic at the same origin.
  - Before allocation, create an ordinary document in the Home space. Derive its
    cause from the normalized target public ASP origin and creation idempotency
    key. Its `authorized` state contains a digest of the complete signed intent
    but no DID, storage origin, or display label. Repeating the same intent
    addresses the same document. A different intent at the same cause is a
    protocol error.
  - Enforce the creation record's transitions with content authorization at Home
    storage. Permit `authorized` creation by the authorized user. Permit exactly
    one terminal transition that preserves the intent digest. A `completed`
    transition fills the DID, storage origin, serving-state revision, and
    committed genesis reference obtained through the creation protocol. An
    `abandoned` transition carries proof that the target's control row moved to
    `abandoning` while it had no DID. When no record exists, permit the same
    proof and signed intent to create it directly as `abandoned`. Reject every
    other replacement and deletion, including an otherwise owner-authorized Home
    transaction. Permit the configured Home operator recovery identity to supply
    the separately defined fenced-database evidence when the target ASP is
    permanently unreachable.
  - Complete the creation-record document and commit the DID-keyed `spaces`
    entry and site-table hint in one normal Home-space transaction. Write the
    presentation and routing entries only during that transition. Replaying the
    same creation request then cannot append duplicates or restore entries that
    the user later edits or removes. The completed document is the immutable
    receipt.
  - Perform the Home transaction under the creator-authorized creation intent.
    Send the registration command to the authenticated Home ASP named by the
    intent. The Home ASP fetches the durable allocation result directly from the
    exact target public ASP origin named by that intent. Require authenticated
    HTTPS and reject a cross-origin redirect. Apply the shared outbound-request
    policy before every connection: reject credentials and disallowed ports,
    resolve and pin the connected address, and reject loopback, link-local,
    private, multicast, unspecified, and other special-use addresses in
    production. Development exceptions must be explicit configuration rather
    than request data. Verify the creator and idempotency key. Accept only the
    DID, storage origin, serving-state revision, and committed genesis reference
    returned by that lookup. Do not accept an allocation proof supplied by the
    caller. This rule does not grant the creation service general Home-write
    authority or require a portable ASP signing key.
  - Persist the signed creation intent with the allocation record before
    generating the key. Any toolshed process may then complete the Home
    transaction without retaining the user's private key, reconnecting the
    initiating client, or holding a general-purpose Home-write capability.
  - If a process exits after the Home transaction commits but before updating
    the control row, a later process observes the matching immutable receipt and
    marks the request complete. It does not inspect or rewrite the mutable
    `spaces` and site-table entries.
  - Mark the control row `rejected` when Home rejects a malformed or unauthorized
    intent, unsupported protocol, wrong Home ASP, or conflicting creation record
    before allocation. Return that durable error without processing the row
    again.
  - Allow the creator to abandon an `intent-recorded` or `home-authorized`
    request before allocation. Conditionally move the target control row to
    `abandoning` only while it has no DID. Have Home fetch that state and move or
    create the matching creation record as `abandoned`. Only after observing the
    Home state may the target mark its row `abandoned`. Allocation and
    abandonment therefore cannot both succeed. A delayed Home-authorization
    request observes the terminal record and cannot revive it.
  - Keep a request pending when Home storage is unavailable after genesis. Mark
    it `inconsistent` and surface an operator error for any permanent Home-side
    rejection after allocation. Never allocate a replacement DID. If an ASP is
    permanently unreachable, do not treat absence as proof that allocation did
    not occur. Fence every process and public route that could allocate for that
    ASP before operator recovery. Recover the authoritative PostgreSQL control
    state from its surviving quorum or backup. Home may accept operator-signed
    abandonment evidence only when it identifies that fenced control database,
    the creator, target origin, idempotency key, last durable revision, and the
    absence of an allocated DID. Without that evidence, leave the Home record
    pending.
  - Let users later remove a `spaces` entry or edit its label without changing
    the space, its ACL, or its site-table hint. A `spaces` entry records a
    space the identity knows about; it is not evidence that the identity still
    owns the space.
  - Supply `homeSpaceCell.spaces` as an ordinary cell input when starting the
    standard system Home pattern. Make that pattern render and edit the input.
    Preserve the existing empty input passed to custom Home patterns, whose
    schemas may reject undeclared fields. Replacing `defaultPattern` does not
    replace the Home root or its space list.

- Narrow the space identity's authorization in the same change.
  - Permit `principal === space DID` only for the ACL-only genesis transaction
    when the space has no ACL and remains at sequence zero.
  - After genesis, evaluate the space DID like any other identity against the
    ACL. Remove every read, write, ACL mutation, CFC membership, and foreign-write
    path that treats equality with the space DID as permanent ownership.
  - Keep configured service authority as its existing explicit policy. It is
    not derived from the space key.
  - Require operator authority or offline storage tooling to repair an invalid
    ownerless ACL. Do not preserve a hidden space-key repair path.
  - Keep Home spaces on the same rule. A Home space remains accessible because
    its genesis ACL explicitly grants its user DID ownership.

- Prepare every existing ACL migration before narrowing authorization.
  - Design a ledger for every populated deterministic space. During cutover,
    populate it from the final authoritative ACL after old writers have drained.
    Include effective owner evidence, Home references, and whether the space DID
    appears as an explicit principal.
  - Derive no owner from knowledge of the old public key. Accept only an owner
    proven by an existing concrete ACL grant or independently authenticated
    account and Home records reviewed by the migration.
  - Plan to install at least one verified concrete owner grant before removing
    implicit space-DID authority.
  - Plan to remove explicit grants to the publicly derivable space DID from
    non-Home spaces. Preserve a Home self-grant because its space DID is the
    user's ordinary identity DID, not a discarded bootstrap identity.
  - Refuse the cutover while any populated space lacks a verified owner. Retire
    an abandoned space explicitly rather than making it inaccessible by
    accident.
  - Define the final ledger verification and durable completion marker that the
    authorization service checks before enabling the narrow rule.

- Replace every ordinary named-space creation path.
  - Change shell creation to call the shared operation and navigate to the
    returned DID.
  - Change CLI creation to call the shared operation and print the returned DID
    and Common Fabric URL.
  - Change `PatternFactory.inSpace()` and `PatternFactory.inSpace(label)` to
    request a fresh space. Treat the optional string as a display label only.
  - Preserve the action's durable event identity as the idempotency key for
    handler post-run creation. A replay of one committed event resolves to the
    same created space.
  - Change background and server-side creation to use the same operation with
    the authenticated initiating identity.
  - Remove public APIs whose only purpose is deriving a space DID from a name.
  - Keep APIs that open an explicit DID. Opening and creating become separate
    operations.

- Make ownership visible immediately after creation.
  - Require all storage, runtime, scheduler, and server authorization paths to
    recognize the genesis ACL before accepting later transactions.
  - Start the default space pattern only after creation returns the committed
    genesis reference.
  - Attribute the default pattern and later writes to the user's delegated
    authority, not to the discarded bootstrap key.
  - Reject a genesis transaction that lacks an owner, has a prior version, or
    grants ownership to a different identity than the authenticated request.
  - Reject a genesis transaction that contains an ordinary data write or a
    wildcard write grant.
  - Reject a second genesis transaction for an existing DID.

- Separate labels from identity throughout Home and user interfaces.
  - Store each known space's DID and editable display label in
    `homeSpaceCell.spaces`. Use its public ASP origin for browser URLs and its
    Home site-table entry for storage connections.
  - Allow duplicate labels. Use the DID as the list key and navigation target.
  - Keep a renamed label local to Home metadata. It does not rewrite cell
    links, ACLs, stored references, or URLs.
  - Show a shortened DID when no display label exists.
  - Remove any fallback that opens an unknown label by deriving a DID.
  - Make FUSE named paths resolve only through its explicit `.spaces.json`
    mapping. Direct DID paths remain available.

- Use the Common Fabric DID URL subset.
  - Emit `https://<asp-host>/<space-did>` for a space root and
    `https://<asp-host>/<space-did>/<piece-did>` for a piece.
  - Use `https://<asp-host>/` for the authenticated user's home space when the
    application intentionally chooses the specified empty-space spelling.
  - Accept existing piece-slug URLs as user-facing compatibility input and
    replace them with piece-DID URLs after loading.
  - Stop constructing `?host=` and `?spaceHost=` URLs. Keep them as
    user-facing compatibility inputs that validate the ASP origin and redirect
    to the equivalent hostname-based URL.
  - Continue to let higher-priority API, static, and embed routes win before the
    Common Fabric catch-all route.
  - Do not add unregistered friendly-name routing. The separate registry plan
    owns that behavior.
  - Do not implement ASP-to-ASP transfer or space-move redirects in this plan.
    Random space identity remains independently deployable.

- Migrate existing data in the same pull request.
  - Preserve every existing space DID. Random identity creation applies only to
    newly created spaces.
  - Move `defaultPattern.spaces` entries with known DIDs into
    `homeSpaceCell.spaces`, keyed by DID. Preserve their names as editable
    display labels and record their public ASP origins in those entries. Record
    their inventoried storage origins in the existing site table.
  - Restage each existing standard system Home root through the normal
    pattern-update machinery. Preserve its result cell and existing output
    links while rebinding its stored argument to the exact
    `homeSpaceCell.spaces` link. Leave custom Home roots and their stored inputs
    unchanged.
  - Rewrite other Home entries and internal metadata that store a name in place
    of a DID so they store the inventoried DID.
  - Rewrite pattern code and fixtures that use a name as an identity. The user
    has explicitly allowed pattern code to migrate without URL-pattern
    compatibility shims.
  - Rewrite repository-owned links and managed Home references to DID URLs.
    Do not install a named redirect table, registry row, or conditional
    integration with the registry plan.
  - Preserve legacy host-query URLs through a validated redirect into
    the Common Fabric hostname form. This compatibility route opens an explicit
    DID and does not restore name-derived creation.
  - Retain old deterministic spaces as ordinary DIDs. Do not rotate their
    identity merely to make their origin random.
  - Remove production code, configuration, and secrets that contain the fixed
    `"common user"` passphrase after all callers and migration inputs have been
    converted.

- Cut over every process and protocol as one compatibility barrier.
  - Provision the shared allocation table without enabling new behavior.
  - Stop accepting new space creation, ACL mutations, and ordinary writes
    globally.
  - Drain every old shell session, toolshed process, storage process, background
    worker, and server-side executor that can derive a named-space key, mutate
    an ACL, write under old authority, or grant permanent space-DID authority.
  - Reject old creation and storage protocol versions after the barrier. Do not
    let an old client reach a new process through another frontend.
  - Take the final authoritative inventory only after old writers are gone.
    Apply the data and ACL migrations, re-read every migrated ACL, and verify
    the completed ledger while the global write barrier remains active.
  - Publish one durable cutover marker only after the migration ledger is
    complete and every old process is gone. New processes refuse ordinary
    reads, writes, and creation until they observe that marker.
  - Resume traffic with random allocation and the narrowed authorization rule
    together. Recovery after activation rolls forward; it does not re-enable an
    old protocol or deterministic creator.

- Update security-sensitive features in the same change.
  - Remove tripwires and disabled states whose only blocker is public named-space
    key derivation after their authorization tests pass with random spaces.
  - Retire credentials or bearer capabilities that were issued while public
    deterministic key material could impersonate a space owner, according to
    each feature's existing retirement procedure.
  - Verify that no code treats knowledge of a display label as authorization.

- Verify identity, replay, routing, and migration behavior.
  - Create two spaces with the same label and prove their DIDs differ.
  - Create spaces with the same label for two users and prove their DIDs differ.
  - Submit one idempotency key through different toolshed processes and prove
    every successful response returns one DID and one genesis reference.
  - Replay a committed handler event and prove it refers to the original new
    space. Trigger a second event with identical inputs and prove it creates a
    different space.
  - Prove the creator owns the space before the first default-pattern write.
  - Prove every successfully created space already has exactly one DID-keyed
    `spaces` entry, one effective site-table hint, and one completed immutable
    creation record in the creator's Home.
  - Exit a process after recording the intent, after Home authorization, after
    allocation, after genesis, and after the Home commit. Prove another process
    resumes each request without allocating a new DID or creating duplicate Home
    entries.
  - Ask Home to complete a record while the target control row is `allocated`.
    Prove the target withholds a result and Home does not publish the `spaces`
    entry, site-table hint, or completed record before genesis commits.
  - Prove a creation is not reported as successful while its Home registration
    is absent. Prove recovery does not require the creator to reconnect.
  - Edit and remove a completed `spaces` entry, then replay the create request.
    Prove its receipt completes recovery without restoring the old label,
    public ASP origin, `spaces` membership, or site-table route.
  - Attempt to change the DID stored in a `spaces` entry. Prove content
    authorization rejects it while allowing label and public-origin edits and
    collection removal.
  - Attempt to alter an authorized record outside its one completion transition.
    Attempt to replace and delete a terminal record with the Home owner identity.
    Prove the content rule rejects every operation.
  - Abandon a Home-authorized request concurrently with allocation. Prove that
    exactly one transition succeeds and that an abandoned request never obtains
    a DID.
  - Exit after the target commits `abandoning`. Prove startup recovery completes
    the Home transition before marking the target row `abandoned`.
  - Abandon an `intent-recorded` request while Home authorization is in flight.
    Prove Home ends in `abandoned` and the delayed authorization cannot revive
    it.
  - Reject a request before allocation and prove process startup does not resume
    it as unfinished work.
  - Upgrade and restart an existing standard Home root. Prove its preserved
    result reads and edits `homeSpaceCell.spaces` through the rebound input.
    Prove an existing closed-input custom Home root still receives its original
    argument.
  - Simulate permanent target loss. Prove Home rejects operator abandonment
    without fencing and durable no-allocation evidence, then accepts correctly
    bound evidence recovered from the fenced target's control database.
  - Use the same idempotency key at two ASP origins. Prove the two composite
    receipt keys do not conflict and both creations complete.
  - Forge an allocation response and attempt a cross-origin redirect during
    Home registration. Prove the Home ASP rejects both and accepts the result it
    fetches directly from the intended ASP over authenticated HTTPS.
  - Point a target ASP origin at private and special-use addresses, and change
    its DNS answer between validation and connection. Prove destination
    validation and address pinning prevent both connections.
  - Prove the public ASP origin and distinct storage origin are used only for
    browser navigation and storage connections respectively.
  - Prove another identity cannot write without a later delegation.
  - Prove no bootstrap private key remains in databases, Home cells, logs,
    queues, browser storage, or returned values.
  - Prove DID URLs work through every production frontend and identify the same
    ASP without a host query parameter.
  - Prove duplicate and renamed Home labels do not affect resolution.
  - Prove the user-facing named-URL inventory is empty and that the random-only
    result contains no name resolver or name-to-DID redirect table. Test
    host-query compatibility separately.
  - Attempt old protocol versions through every frontend and prove they are
    rejected after the cutover marker.
  - Verify every populated legacy space has a concrete owner and no non-Home
    grant to its publicly derivable space DID.
  - Exercise database and storage failover during creation. Assert that writer
    fencing prevents two accepted results.
  - Run repository formatting, lint, documentation-link, unit, integration,
    browser, ACL, background-execution, and migration checks before landing.

## Result

Every new space has a fresh, unguessable DID backed by random key data. The
creating user owns it from its first committed state. The bootstrap key is then
gone. The completed creation is already present in the user's durable Home
space list, with a completed write-once creation-record document and routing
supplied by the Home site table. Display labels remain convenient user metadata,
while browser links use the ASP hostname and space DID prescribed by Common
Fabric URLs.
