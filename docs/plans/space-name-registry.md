# Space name registry implementation plan

## Status

Proposed. Not started.

If selected, this plan is implemented and landed enabled in one pull request. It
has no feature flag or opt-out mode. Selecting the plan remains optional: it
does not participate in space creation, authorization, or storage, and it can be
implemented before or after
[random space identities](random-space-identities.md), or not implemented at
all.

## Decision

Add a deployment-scoped registry that maps a short public name to a canonical
space DID. A registry name is a convenient, mutable alias. It is not the space's
identity, an ownership claim about the target, or an authority-bearing input to
storage.

The registry has one durable fact:

| Field                  | Meaning                                                    |
| ---------------------- | ---------------------------------------------------------- |
| `name`                 | Canonical short name within one registry origin            |
| `space`                | Target space DID                                           |
| `host`                 | Non-authoritative HTTP origin currently serving the space  |
| `owner`                | Identity allowed to change or transfer this registry entry |
| `registrationSequence` | Immutable order assigned by the first successful claim     |
| `revision`             | Compare-and-set revision for mutations                     |
| `state`                | `active` or `inactive`                                     |

The toolshed origin and name together identify an entry. `orchard` at one
deployment is unrelated to `orchard` at another deployment.

A separate namespace table has one create-only row per claimed or reserved name:

| Field  | Meaning                          |
| ------ | -------------------------------- |
| `name` | Canonical name, unique in origin |
| `kind` | `alias` or `reserved`            |

Claiming an alias inserts its namespace row and alias entry in one transaction.
Deactivation never deletes either row. Fixed product routes use permanent
`reserved` rows and have no alias entry.

The public alias URL is `/<name>`, with an optional piece address after the
name. For example, `https://toolshed.example/space` resolves the active `space`
entry at that toolshed origin. The server resolves registered names before it
serves the shell, so old cached clients cannot reinterpret a registered name
through legacy derivation.

The space DID remains the opaque fallback URL. After opening the target and
reading its ACL, the shell gives the space the URL of the most recently
registered active name whose registry owner is a current owner of that space. If
no entry satisfies both conditions, it uses `/<space-did>`. A non-default host
remains encoded by the existing validated host query.

## Why

A human-readable name and a cryptographic identity have different jobs.

- A DID is stable, globally unambiguous, and suitable for durable links.
- A display name is local, editable, and may be duplicated.
- A registry name is public, scarce within one registry, and may be repointed by
  its owner.

The current named-space path combines all three. The fixed derivation makes a
name sufficient to calculate both the DID and its private key. A registry
restores the useful part, a short link, without making the name an authority.

The earlier `ct-space` work reached the same boundary from two directions:

- [`docs/acl.md` at commit `a81a9009f`](https://github.com/commontoolsinc/labs/blob/a81a9009f7adb46eddd96b411e564deba8eaf7d0/docs/acl.md)
  requires carrying a DID beside a name and proposes an address book for
  name-to-DID resolution.
- [`docs/space-petnames.md` at commit `f5c70f5fc`](https://github.com/commontoolsinc/labs/blob/f5c70f5fca70d80a6a58902ea318f3b65fe97d06/docs/space-petnames.md)
  proposes registering, resolving, and listing petname mappings, with
  provider-directed resolution.

This plan keeps the small common core and leaves out hierarchical petnames,
`did:web`, provider chaining, search, and contact management. Those features can
be added over the same exact-lookup contract if demand appears.

## Specification connections and conflicts

This proposal was checked against the current labs documentation and the full
`commontoolsinc/specs` document corpus at commit
[`5fb2c6435`](https://github.com/commontoolsinc/specs/tree/5fb2c64357f643f7344d00cdb049f0d9e5983ef0).
No CFC rule requires a global space-name registry. The material connections are:

- [CFC space principals](https://github.com/commontoolsinc/specs/blob/5fb2c64357f643f7344d00cdb049f0d9e5983ef0/cfc/03-core-concepts.md#361-space-principals)
  and
  [CFC causal addressing](https://github.com/commontoolsinc/specs/blob/5fb2c64357f643f7344d00cdb049f0d9e5983ef0/cfc/17-addressing-and-storage.md#171-causal-id-storage-core-cfc-path)
  treat the stable identifier and access authority as separate facts. A public
  alias therefore resolves to a DID but never supplies `HasRole`, a storage
  capability, or evidence that its registry owner owns the target.
- [CFC `HasRole` fact generation](https://github.com/commontoolsinc/specs/blob/5fb2c64357f643f7344d00cdb049f0d9e5983ef0/cfc/04-label-representation.md#493-hasrole-fact-generation)
  establishes one ACL document as the declared membership record. Reverse
  canonicalization reads its concrete `OWNER` rows. Configured service authority
  does not qualify unless the service DID also has an explicit row. The registry
  does not create a second meaning of “space owner.”
- [Pattern import resolution](../specs/pattern-imports/README.md#open-questions)
  already requires a DID at the Fabric resolver and places readable aliases in a
  separate short-link service. It also defines the host as a routing hint, not
  part of space identity. Registry reverse lookup must consequently select
  candidates by DID, even when two aliases route that DID through different
  admitted hosts.
- The existing [shell route table](../../packages/shell/README.md#routes) and
  [navigation guide](../common/patterns/navigation.md) parse a first segment as
  a space name or DID. This proposal replaces the public-name half with a
  server-owned exact registry lookup. DID routes remain backwards-compatible.
- The [Home space list](../common/conventions/HOME_SPACE.md#spaces) is personal,
  while the registry is deployment-wide. The two may display the same text but
  never resolve each other implicitly.
- The
  [FUSE path specification](../specs/fuse-filesystem/2-path-scheme.md#space-name-resolution)
  currently derives a DID from any directory name. Its replacement is an
  explicit registry connect operation followed by DID-and-host persistence in
  `.spaces.json`; directory traversal stays offline.
- [Toolshed request authentication](../specs/toolshed-access-control.md#request-proof-format)
  supplies the existing proof vocabulary for mutations. A claim permit and
  compare-and-set revision add allocation and concurrency control without
  changing what the proof says about target-space authority.
- [Toolshed storage configuration](../development/CONFIGURATION.md#memory-store)
  currently configures Common Memory rather than a general metadata database.
  Existing control records such as
  [webhook registrations](../../packages/toolshed/routes/webhooks/webhooks.handlers.ts)
  use the service Fabric space. This proposal instead adds one private registry
  database because namespace uniqueness, compare-and-set mutation, and monotonic
  sequences need a compact transactional authority and are not user Fabric data.

The audit found one conflict inside the earlier draft of this plan. It selected
canonical aliases by DID and host even though the host is only a route. This
revision selects every eligible alias whose target DID matches the opened space.
Each candidate alias must still have a currently admitted target host that
serves the same validated DID and ACL state. The newest qualifying registration
wins even when it routes that space through a different admitted host.

## Invariants

1. The resolved DID is the only space identifier passed to the runtime, storage,
   ACL, CFC, piece, and link layers. The host is a routing hint handled at the
   existing site-table boundary.
2. No private key is derived from a registry name or stored in the registry.
3. A registry entry's owner controls the alias. The entry does not assert that
   its owner controls the target space.
4. Durable Fabric data contains DIDs, never registry names. A user's existing
   site table may retain the resolved DID-to-host hint.
5. Space creation succeeds or fails without consulting the registry.
6. Registry mutation succeeds or fails without creating, opening, or writing the
   target space.
7. An inactive name returns not found before the shell loads. A name with no
   registry row may reach the shell's independent ordinary fallback. Neither
   case denotes an empty space.
8. A lookup is exact. This plan has no enumeration, prefix search, wildcard,
   hierarchy, or fallback to another provider.
9. An alias URL returns the same registry entry and canonical DID-and-host
   redirect for every viewer. Authentication and ACLs may change whether a
   viewer can open that target, never which target the URL denotes.
10. URL canonicalization uses only the target DID, an authoritative ACL owner
    set and revision read from the opened space's host, and authoritative
    registry rows whose target hosts serve that same validated space state. It
    does not use a caller-supplied owner set, viewer identity, cookies, Home
    contents, or personal routing hints.
11. Among active entries for the same DID whose registry owner is a current
    space owner and whose target host serves the same validated space state, the
    greatest immutable registration sequence wins. If none match, the canonical
    URL uses the space DID.
12. Once a name has a namespace row, no shell version handles that path. Active
    aliases redirect. Inactive aliases and reservations not yet consumed by a
    fixed route return not found.
13. A fixed product route may use a name only if that name is reserved before
    any claim. The namespace table resolves every race between reservation and
    claim; a later route may not take an alias name.
14. Forward lookup, reverse lookup, and every host mutation apply the same
    current host-admission policy. Removing a host immediately makes aliases
    routed through it unavailable without exposing their names to shell
    fallback.

The third invariant is deliberate. Making registration depend on a target
space's ACL would couple this plan to space authorization. It would also make a
registry claim unsafe while legacy named-space keys remain publicly derivable.
The registry promises who controls the short link, not who controls the value to
which the link points.

The host is not part of the space identity. It is the authoritative route for
the navigation produced by an alias redirect, but the space log remains the
integrity boundary. A registry response cannot make content under another DID
valid.

## Names

Registry names contain 1 through 63 ASCII characters. They begin and end with a
lowercase letter or digit and may contain lowercase letters, digits, and hyphens
between them.

Reject instead of transforming input. In particular, do not lowercase,
transliterate, normalize Unicode, collapse punctuation, or trim whitespace. A
caller that did not submit the canonical name receives a validation error. This
leaves one byte representation for every name and avoids visually confusable
aliases.

Reserve names required for deployment operation, product entry points, and shell
built-ins. A valid DID segment and fixed prefixes such as `api`, `static`, and
`.embed` are never registry names. Route classification happens before registry
lookup and uses the shared reserved-name module.

Keep the reserved-name list in one shared module used by validation, API
documentation, and tests. The initial database migration inserts matching
`reserved` namespace rows before registry mutations are enabled.

Adding a fixed route is a namespace mutation. Its database migration inserts a
create-only `reserved` row before the route serves. The same unique constraint
serializes that insert against every claim, including claims from an older
registry instance. If an `alias` row wins, the migration fails and the product
must choose another route. If the reservation wins, every claim sees an existing
namespace row and fails. A claimed path is permanent.

A space's display name is not subject to these restrictions. It remains a
user-owned label in Home and may contain Unicode or duplicate another display
name.

## Ownership and lifecycle

Claiming a name requires an authenticated identity and a one-use allocation
permit issued through the deployment's abuse-controlled admission boundary. The
permit binds the canonical name, registry origin, and proposed owner DID. The
issuer applies a lifetime claim quota to a stable deployment account, not to the
DID, because identities are free to generate. A deployment without such an
account boundary uses operator-approved permits; it does not fall back to
self-service DID claims.

The first successful create-only mutation records the permitted identity as the
registry owner, inserts the create-only `alias` namespace row, and consumes the
permit in one transaction. Concurrent claims or a claim racing a reservation use
the namespace table's unique name constraint; exactly one succeeds. Replaying
the accepted operation returns its result without consuming another permit. The
same transaction assigns an immutable, deployment-wide registration sequence
from the database. Repointing, transfer, deactivation, and reactivation do not
change that sequence. A later successful claim therefore always sorts after
every earlier claim without using wall-clock timestamps or requiring a
tie-breaker.

The owner may:

- repoint the name to another valid space DID and host;
- update the host hint for the current DID;
- transfer the entry to another identity;
- deactivate the entry;
- reactivate an inactive entry.

Every mutation supplies the revision the caller observed. A stale mutation fails
with a conflict and reports the current revision. The client presents the
conflict; it does not retry automatically.

Deactivation does not release a name. Reassigning an old link to an unrelated
future claimant would turn every saved alias URL into an ambient transfer of
trust. A transfer is therefore an authenticated mutation by the existing owner.
Recovery of a lost owner identity is outside this plan.

The registry retains an append-only audit row for every accepted mutation. The
public read response exposes only the current entry. Operator tooling may read
the audit log.

Registry ownership and space ownership remain separate facts. Registration and
mutation do not read the target ACL. Canonicalization asks the target storage
authority for the current validated ACL and its revision, then compares the
concrete owner set with registry rows. It does not trust an owner set supplied
by the browser. If an ACL has several concrete `OWNER` identities, an entry
owned by any one of them qualifies. An ownerless or malformed ACL has no
matching registry owner.

## Service boundary

The registry is a small service owned by the toolshed deployment. Store its
records and audit rows in one Toolshed-private SQLite database, separate from
Common Memory's per-space storage and the service Fabric space. The
authoritative registry process owns that file, runs schema migration before
accepting traffic, and provides the narrow storage interface. Other front ends
proxy registry requests to that authority.

This gives one authoritative toolshed origin with serializable transactions and
read-your-writes behavior without inventing a distributed database. Lookup is
not served from file copies or asynchronous replicas. Backup and restore move
the database as one unit and must preserve its monotonic registration-sequence
state. Cross-provider federation is outside this plan.

For reverse canonicalization, the registry service first makes an authenticated
server-to-server read to the opened space's validated storage origin. The
response binds the space DID, ACL revision, and complete concrete `OWNER` set.
Accept only origins admitted by the existing space-routing policy, and do not
follow redirects.

The registry then takes one authoritative database snapshot and reads active
same-DID rows owned by that concrete owner set in descending registration
sequence. A row routed through the opened host is already validated. For a row
routed through another host, make the same authenticated exact read and require
the same DID, ACL revision, and concrete owner set. Skip a row only when current
policy excludes its host or an authoritative response proves that the host
redirects or serves different state. If the highest remaining candidate cannot
answer, stop canonicalization and retain the safe DID URL. Do not choose an
older name based on a transient failure. Evaluating the next authoritatively
disqualified candidate is part of one bounded selection, not a retry of a failed
request. The finite owner set and existing per-account lifetime quota bound the
candidate count.

The first validated row wins. If every candidate is authoritatively
disqualified, return the canonical DID fallback with the opened ACL revision. A
named result also carries the selected entry revision. A host-read failure
returns an incomplete result, which also retains the DID URL but is not evidence
that no name qualifies. Do not cache owner sets or retry a host read.

Use the existing signed first-party HTTP request format for mutations. The
signed material binds:

- HTTP method and canonical path;
- registry audience;
- canonical request body;
- expected revision;
- an operation identifier.

A claim also carries the one-use allocation permit. The target host is part of
the canonical body. Claim, repoint, and host-update mutations accept only an
HTTP or HTTPS origin without credentials, path, query, or fragment that is
admitted by the same configured space-routing policy used for authoritative ACL
reads. Every accepted host must support that read contract.

An operation identifier makes a repeated delivery return the original result. It
does not authorize a retry loop. A different body under the same operation
identifier is a conflict.

## HTTP surface

The HTTP surface contains three public read forms and three mutation forms:

- exact public lookup by canonical name;
- exact reverse canonical-name lookup by target DID and the opened host, with
  the service reading current space owners from that host;
- public `/<name>` navigation, which redirects to a DID-and-host URL before the
  shell loads;
- authenticated create-only claim;
- authenticated compare-and-set update or deactivation;
- authenticated compare-and-set transfer.

Active exact lookups return the canonical name, target DID, host hint, entry
owner, registration sequence, and revision, with an `ETag` derived from the
revision. Reverse lookup accepts only a canonical target DID and the host from
which that DID was opened. The service validates the opened state, then returns
only the greatest-sequence active same-DID entry with a matching owner whose
host serves that same state, or not found. The caller supplies no owner and does
not choose among returned rows. Reverse responses use `Cache-Control: no-store`,
so a new claim, transfer, repoint, deactivation, or reactivation affects the
next canonicalization.

Alias navigation has three outcomes. An active alias on an admitted host
supplies its target. An inactive alias, reserved name, or alias on a removed
host is terminally unavailable. An absent namespace row allows ordinary shell
fallback. Every fresh navigation reads the authoritative database. A successful
mutation and the following authoritative lookup are read-your-writes, and
revisions never decrease across backup restore or authority failover.
Registration sequences are never reused and do not move backward across restore
or failover. Operator inspection also sees the stored audit state.

Before returning an active target, forward lookup reapplies the configured host
admission policy. A row whose host is no longer admitted returns a terminal
route-unavailable result and never falls through to the shell. Reverse lookup
applies the same policy before contacting the opened or candidate hosts.
Re-admitting a candidate host makes it eligible only after it serves the same
validated space state. An owner mutation to a host that does so also restores
ordinary resolution.

Do not add a public list endpoint. Exact forward lookup and the single-result
reverse lookup are sufficient for navigation. Enumeration would turn the
registry into a deployment inventory and make scraping its default use.

Apply body limits and mutation rate limits keyed by the client network address
before signature verification. Rate limiting limits load; the allocation permit
and account quota limit permanent namespace use. Require the signed request's
ordinary expiry and audience checks in addition to the operation identifier.
Apply a separate, generous lookup limit.

## Shell and navigation

For a request whose first segment is a possible registry name, the toolshed
server applies route precedence in this order:

1. fixed product, API, static, and embed routes;
2. a valid explicit space DID;
3. an exact namespace row;
4. the shell's ordinary fallback when no namespace row exists.

On an active row with a currently admitted host, the response does not vary with
cookies, authentication, or Home contents. It returns `302 Found` with
`Cache-Control: no-store` and a `Location` containing the target DID path, the
original optional piece address, and a validated host query whenever the host is
not the deployment default. The redirect prevents a cached legacy shell from
deriving a different space from the name. The registry entry supplies the route;
a caller cannot override its host through the alias URL.

An active row whose host is no longer admitted returns route unavailable before
the shell loads. It remains a claimed name and cannot reach legacy derivation.

On an inactive row, the server returns the ordinary public not-found response
before it serves any shell version. Deactivation permanently reserves the path,
so an old client can never reinterpret a former alias through legacy derivation.

A `reserved` namespace row that has no active fixed route also returns not found
before the shell loads. Registry servers understand this state from the initial
implementation, so inserting a future reservation immediately prevents old and
new instances from falling through on that path.

A name with no registry row falls through without registry behavior. If this
plan lands before random space identities, the existing shell may still use its
legacy name path. After the random-identity plan removes that path, the same
fallthrough returns not found. The registry route contains no branch for either
behavior.

The same resolver gates every name-shaped navigation within the shell, including
link clicks, application navigation events, browser history, and embed routes.
It resolves the name before any programmatic history mutation and, in every
case, before opening a session. An active alias on an admitted host supplies its
DID and host. An inactive alias, reserved name, or alias on a removed host
returns a terminal error. An absent namespace row reaches the shell's ordinary
behavior.

The implementation deployment drains old server instances, closes sessions from
pre-registry shell versions, and rejects a missing or old protocol version
before any subsequent space read. An old shell may still derive a name locally
or change its address bar, but the resulting target never resolves. The terminal
incompatibility response instructs the user to reload; it does not assume the
old client can reload itself. This one-shot cutoff prevents an already-open old
shell from reading a registered name through `common user`.

The shell treats the DID and host selected by the URL as authoritative for the
navigation. It ignores conflicting Home hints, closes or isolates an existing
session bound to another host, and fails before reading if it cannot open the
URL-bound host. After a successful open, it may persist the DID-to-host hint to
an authenticated writable Home. Navigation never depends on that write and never
writes the target space.

After the target opens, the shell sends only its DID and canonical host to the
reverse lookup. The registry service reads the authoritative ACL owner set from
that host. If the lookup returns an entry, the shell replaces browser history
with `/<name>` while preserving the piece suffix and dropping the host query
because the registry entry supplies that route. If it returns not found, the
shell replaces browser history with `/<space-did>`. The DID form retains the
validated host query for a non-default store. If the ACL read or reverse lookup
is unavailable, canonicalization has not completed: the shell keeps the safe DID
form and never chooses a cached name. This replacement does not reload the space
or create another history entry.

The rule applies no matter how navigation began. Going directly to a DID,
following a Home entry, or opening any alias for the space converges on the most
recently registered active owner-matching name. An alias owned by someone who is
not a current space owner still resolves to its target, but the resulting URL
converges to the qualifying name or DID. An older qualifying alias converges to
the newer qualifying alias.

A registry update or ACL change does not move an already-open runtime. A fresh
navigation, reload, or explicit canonical-link action performs a new lookup and
uses current authoritative state. Copy-link actions emit the URL selected by the
same rule. User interface text states that a named URL may be repointed.

## Home, CLI, and FUSE

Home's `spaces` list remains a personal address book. Its `name` is a display
label and its `did` is the canonical address. It does not become a mirror of the
public registry.

Add explicit registry commands under `cf space name`:

- `resolve` reads an exact public name;
- `claim` creates an entry;
- `set` repoints an owned entry;
- `transfer` changes its owner;
- `disable` makes it inactive;
- `enable` reactivates it.

Every mutating command requires an identity and an expected revision except a
create-only claim. Commands print both name and DID. Machine-readable output
includes owner, registration sequence, state, and revision.

FUSE may accept a registry alias only through an explicit mount or connect
operation that names the registry origin. Once resolved, `.spaces.json` records
the resulting DID and host hint. Filesystem traversal never performs an implicit
network lookup.

## Relationship to random space identities

This plan accepts any valid space DID. It does not know whether the DID came
from a legacy name derivation, random key data, an imported shared space, or a
future DID method.

If random space creation is also implemented, the product flow is:

1. create the space and receive its DID and host;
2. add the DID and a personal display name to Home;
3. optionally claim a public registry name in a separate operation.

The third step is not part of the creation transaction. A name conflict or
registry outage leaves the new space intact and usable by DID. Deleting this
entire registry feature leaves no field, key, branch, or compatibility mode in
the space-creation path.

If random space creation is not implemented, the registry can map aliases to
legacy named-space DIDs or any explicitly supplied DID. It neither improves nor
worsens the target space's authority model.

## Migration and compatibility

Registered aliases deliberately occupy `/<name>`. The server resolves every
registry row before serving any shell version: an active row redirects, and an
inactive row returns not found. Only a name with no row falls through to the
shell. If this plan lands before random space identities, existing legacy name
creation therefore continues for never-registered names. If the random-identity
plan lands first or later, its shell returns not found for that same
fallthrough. Neither implementation contains a compatibility branch or dormant
hook for the other.

Do not infer an owner merely because a legacy name exists. Preparation
inventories every known legacy name and gives each retained alias an explicit
verified owner, target DID, and host. Only names that already satisfy the
registry grammar may be seeded. Product links with invalid names are rewritten
to canonical DID-and-host URLs instead of being silently transformed. The
current negligible population makes this a finite reviewed manifest. The
implementation seeds valid aliases, including product-operated names, in the
same pull request. An unowned or invalid name is not imported and returns the
shell's ordinary result to every viewer. There is no later cutover.

## Preparation

- Select the Toolshed-private registry-database path, single-authority routing,
  schema migration, backup and restore procedure, and the same-origin forward
  lookup, single-result reverse lookup, alias-navigation, and mutation API
  routes.
- Identify the stable deployment account boundary that issues claim permits. If
  none exists, specify the operator approval procedure used at launch.
- Inventory every known legacy and product alias. Record its canonical spelling,
  owner DID, target space DID, and validated host origin. Mark invalid names for
  direct DID-and-host link migration instead of registry seeding. Put valid seed
  entries in their intended registration order.
- Confirm the signed-request verifier, live host-hint registration, optional
  Home site-table persistence, target-host ACL read, and FUSE connection format
  that the implementation will reuse.
- Inventory every fixed first-segment route and encode its precedence or
  reservation in the shared route classifier.

Preparation produces a short decision record and reviewed seed manifest as
inputs to the implementation. They are committed with the implementation, not
landed separately. Preparation adds no runtime code, schema, flag, or
compatibility path.

## Implementation

- Add the registry as one enabled feature in one pull request:
  - Define canonical name validation and the reserved-name set in one package
    shared by the service and clients.
  - Seed permanent namespace reservations for the initial fixed routes before
    enabling claims. Require every future fixed route to insert its create-only
    reservation before serving and to choose another segment if an alias row
    wins the unique-name race.
  - Define lookup and mutation protocol types, stable errors, revisions,
    immutable registration sequences, operation identifiers, and one-use claim
    permits.
  - Connect permit issuance to the prepared deployment account quota or operator
    approval boundary.
  - Add the private SQLite registry database, schema migration, and routing to
    its single authoritative process. Keep it independent of Common Memory and
    the service Fabric space.
  - Add the durable storage implementation with atomic create-only claim, unique
    namespace rows, compare-and-set mutation, consumed permits, append-only
    audit rows, and an index that selects the greatest registration sequence by
    target DID and owner.
  - Add exact authoritative forward lookup, single-result reverse lookup, and
    authenticated claim, update, transfer, deactivation, and reactivation
    endpoints.
  - Reapply current host admission on every forward and reverse lookup. Return a
    terminal route-unavailable result for an alias whose recorded host was
    removed from policy; never redirect it or let its name fall through.
  - Make reverse lookup read the current validated ACL and revision directly
    from the admitted host where the target was opened. Reject redirects. Check
    same-DID rows in descending registration sequence and validate a different
    candidate host against the opened DID, ACL revision, and concrete owner set.
    Skip removed, redirected, or divergent candidates. If the highest remaining
    candidate is unavailable, return an incomplete result and retain the DID
    URL. Otherwise return the first validated entry and its revision, or the
    canonical DID result, with the opened ACL revision.
  - Reuse first-party request verification; bind every mutation field into the
    signature; validate DID; require the same configured host admission used by
    reverse ACL reads; and reject expired or wrong-audience requests.
  - Apply body and client-network rate limits before expensive verification,
    with the permit and account quota enforcing permanent allocation limits.
  - Return the active, inactive, route-unavailable, reserved, and absent
    navigation states needed to keep a claimed name out of legacy derivation.
    Expose mutation history only to operators.
  - Add `cf space name` commands over the shared protocol types.
  - Add server-owned `/<name>` interception after fixed routes and explicit DIDs
    but before serving the shell. Redirect active aliases without using cookies,
    authentication, or Home state; return not found for inactive aliases and
    reserved namespace rows; and let absent namespace rows follow the shell's
    ordinary behavior.
  - Make the redirect carry the target DID path, original optional piece
    address, and validated host query for a non-default store. Bind the
    resulting shell navigation to that route and ignore conflicting personal
    hints.
  - Register the resolved host hint live and optionally persist it through the
    existing Home site-table flow only after the URL-bound space opens.
  - Gate every same-document name navigation on the same resolver before history
    mutation or session open. Drain old servers and sessions, reject missing or
    pre-registry shell protocol versions before reads, and return a terminal
    incompatibility error instructing those users to reload.
  - Perform reverse lookup by DID and host after open, then replace browser
    history with the returned latest-registered name or the DID fallback without
    reloading. Treat a failed ACL or registry read as incomplete
    canonicalization and retain the DID URL.
  - Make Home navigation, intra-space navigation, reload, and copy-link actions
    use the same canonicalization function.
  - Add explicit FUSE resolution that records the DID and host in `.spaces.json`
    without network lookup during traversal.
  - Create the database schema, seed valid reviewed product aliases, and rewrite
    managed links with invalid legacy names to canonical DID-and-host URLs as
    the in-pull-request data migration.
  - Add dashboards for lookup outcomes, mutation conflicts, and rate-limit
    decisions without logging private request material.
  - Document backup, restore, and authoritative-origin recovery without revision
    rollback.
  - Test claim races, registration ordering, permit consumption, account quotas,
    stale revisions, idempotent replay, transfer, repoint, deactivation,
    reactivation, host routing, authoritative reads, process restart, registry
    unavailability, and identical redirects for anonymous and differently
    authenticated viewers.
  - Test direct DID canonicalization, several current ACL owners, owner
    mismatch, several aliases for one target, alias and ACL ownership changes,
    piece-suffix preservation, admitted non-default hosts, rejection of a host
    that cannot supply authoritative ACL reads, and removal of a formerly
    admitted host.
  - Test that conflicting Home hints cannot change an alias target, an old
    cached or already-open shell cannot interpret a registered or inactive name,
    fixed routes retain precedence, future routes cannot take any claimed name,
    and landing this plan alone leaves never-registered legacy name creation
    unchanged.

The pull request lands with the registry API and all clients enabled on the
existing toolshed deployment. It has no disabled state: if the registry is
unavailable, alias resolution fails while canonical DID URLs and space creation
continue to work.

## Acceptance criteria

- Two registry origins may use the same name for different DIDs.
- Within one origin, anonymous and differently authenticated viewers receive the
  same DID-and-host redirect from the same registered `/<name>` URL.
- A conflicting Home route cannot change the DID or host selected by an alias
  URL.
- Every host accepted by claim, repoint, or host update supports authoritative
  ACL reads for reverse canonicalization.
- Opening `/<space-did>` for a space with one active alias owned by a current
  ACL owner replaces the URL with that `/<name>`.
- If several active aliases for the DID are owned by current ACL owners and
  their target hosts serve the same validated space state, every navigation
  converges on the one with the greatest immutable registration sequence, even
  when it names another host.
- A newer same-DID alias at a removed, redirected, or divergent host is
  disqualified, so canonicalization may use the next qualifying alias. If its
  admitted host is merely unavailable, canonicalization remains incomplete and
  keeps the safe DID URL rather than choosing an older alias.
- If no active alias owner is a current ACL owner, every navigation converges on
  `/<space-did>`, retaining the host query when required.
- An alias whose owner does not own its target still resolves to that target but
  does not become the target's canonical URL.
- Successful canonicalization at the same target ACL revision and authoritative
  registry state produces the same URL for every viewer who can open the space.
- If authoritative ACL or registry lookup fails, the navigation remains on its
  safe DID URL and is explicitly not considered canonically named. It never uses
  a stale alias.
- A claim without a valid allocation permit fails, and generating more DIDs does
  not increase one deployment account's lifetime quota.
- Two identities racing to claim one name produce one owner and one conflict.
- An entry owner may repoint or transfer with the current revision.
- A stale or differently signed mutation changes nothing.
- An inactive name cannot be claimed by a new identity.
- An inactive `/<name>` returns not found before any shell version loads and
  never reaches legacy derivation.
- A fresh navigation after repoint, transfer, deactivation, reactivation, host
  update, or ACL owner change observes the new canonical URL. An already-open
  runtime remains on its bound target.
- Public lookup never creates or writes a space, and navigation never writes the
  target space.
- An anonymous visitor and an authenticated visitor whose Home write fails can
  open a non-default-host alias through the live route hint.
- When Home persistence succeeds, a non-default-host space may also reopen from
  Home after restart. The alias URL does not depend on that persisted hint.
- Durable Fabric links produced after alias navigation contain the DID.
- Canonical DID navigation works when the registry database and route are
  unavailable.
- Landing this registry alone leaves creation and navigation through names with
  no namespace row unchanged. Active, inactive, and reserved names resolve
  before every shell version.
- Same-document navigation in a pre-registry shell is rejected before it reads a
  space. Its locally derived URL does not resolve, and the terminal error
  instructs its user to reload.
- Removing a host from policy makes every alias routed through it unavailable on
  the next lookup without exposing the name to legacy derivation.
- A future fixed route cannot take a segment whose namespace row is an alias.
- A newly inserted reservation returns not found on old and new registry servers
  until its fixed route begins serving.
- Invalid legacy names are migrated to canonical DID-and-host links rather than
  normalized into registry claims.
- Removing all registry client and server code requires no change to space
  creation, storage, or ACL behavior.

## Out of scope

- A global internet namespace.
- Search, browse, suggestions, and public enumeration.
- Hierarchical petnames or delegation between registries.
- `did:web`, DNS, and provider migration.
- Requiring target ownership to claim or repoint an alias. Target ownership is
  consulted only when selecting the space's canonical browser URL.
- Identity recovery for a registry owner.
- Automatic alias claiming during space creation.
- Changing legacy named-space derivation.
