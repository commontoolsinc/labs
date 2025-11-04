# Fabric Identities

This document addresses future plans for identity and permissions for the Common Tools fabric, and the process to get there.

## URL structure

Via latest [PRD](https://docs.google.com/document/d/1KixOc7L5LZ8IdJtO_9pNHohPg_LXEF5hFgoAzvq9KLc/edit?tab=t.vx0btmvvbit9), the URL structure represents the three address component types:

```
DID = "did:key:{string}"
DOMAIN = "{string.}*{string}.{string}"
NAMESPACE = DID | DOMAIN
SPACE = DID | string;
CHARM = DID | string;
ADDR = "/{@NAMESPACE/}?SPACE/CHARM?"
```

Each component may be a slug/name ("my-notes-123") or a DID key ("did:key:abc..").
Namespaces are optional in the URL, and are prefixed with a "@" followed by either
a DID key or DNS address. If namespace not provided, then an implicit, global provider-namespace is used.

## Namespace

Namespaces are a scope of spaces, and spaces contain charms.

Namespaces can be referenced via DNS record, resolving to a DID key, or via directly as a DID key. Similarly, a provider-namespace is implied when no namespace given, which also resolves to an identity DID. 

Namespaces manage many spaces, and are responsible from mapping space petnames to their identity.
Each namespace has an "admin" space (possibly with the same identity as the namespace itself?), where records are stored.

> [!NOTE]
> There may be a way to view a namespace, like itemizing all contained spaces, but is out of scope here.

Additionally, delegations for access to the namespace is stored in the admin space as well. See **CAPABILITIES** below for delegation.

### Namespace Admin Space

```
DELEGATIONS = UCAN[];
// Mapping of space name to space identity
ITEMS = Map<string, DidKey>
```

### Provider Namespace

The provider namespace is local to a provider service, and the default namespace used when none supplied. This functions like other user-owned namespaces, except owned by the provider.
 
## Space

Each space contains many charms and other data. A space is the root of permissions in the system, and capabilities are applied per space. Similar to namespaces, each space must maintain a mapping of charm names to identities, as well as permission for the space. Unlike namespaces, this data is stored in well-known Cells rather than a derivable space.

### Space Admin Space

```
DELEGATIONS = UCAN[];
// Mapping of charm name to charm identity
ITEMS = Map<string, DidKey>
```

## Capabilities

Access and permissions are handled via an authorization token like [UCAN](https://github.com/ucan-wg/spec) or another alternative. These tokens represent capabilities delegated to identities for a given subject.

* `SPACE:CREATE`: A namespace-based capability indicating permission to create a new space. This is the only delegation stored in a namespace admin record. 
* `SPACE:READ`: Permission to read a space. 
* `SPACE:WRITE`: Permission to write data to a space. A superset of `SPACE:READ`.
* `SPACE:OWNER`: Permission to modify authorization in a space. A superset of `SPACE:WRITE`.

> [!NOTE]
> Revocations and rotations are currently out of scope, but could be handled with delegation.

### The `ANYONE` User

We use a well-known key to assign delegation to all users.

### Example

Alice (`did:key:alice`) creates a new space on `provider.com` (with identity `did:key:provider`) with the name `alice-space`. No namespace was provided, so the *provider namespace* is used. The space name with identity `did:key:provider` (possibly a derivation of identity) is referenced to ensure Alice has permission to create a new space, and that `alice-space` is an available space name.

`provider.com` was configured to allow all users to create a new space by delegating the `SPACE:CREATE` capability to the `ANYONE` identity, stored in the `did:key:provider` space's delegations. Additionally, there are no current spaces with the name `alice-space`. The provider creates the space on Alice's behalf, generating a new key for the space (`did:key:alice-space`). This key is stored by the provider, immediately delegating `SPACE:OWNER` capabilities to `did:key:alice`.

Now, `provider.com` is hosting `alice-space` in the provider namespace. No one else yet has any access to data stored in this space. Alice wants to invite Bob (`did:key:bob`) to this space, and signs a new delegation with `did:key:alice` for `did:key:bob`, granting Bob `SPACE:WRITE` permissions. Bob can now read and write data to the space, but cannot invite Eve, lacking the `SPACE:OWNER` capability.

Similarly, in a non-provider namespace (e.g. `@alice.fab.com`, or `@did:key:alice`), the namespace is created, immediately assigning `SPACE:CREATE` capabilities to `did:key:alice`, or whatever key `@alice.fab.com` resolves to. No other identities may create spaces within Alice's namespace, unless they were to e.g. delegate `SPACE:CREATE` capabilities to another user.

## Plan

Currently, `Session`s are created in the workspace, and the abstraction between public/private spaces needs updated. There are a few areas currently that will need to use a new Session compatible with this document:

### Manual Private Space

* charm/src/ops/charms-controller.ts
* shell/src/lib/runtime.ts
* cli/lib/charm.ts

### Uses Admin Session

* background-charm-service/src/worker.ts
* background-charm-service/cast-admin.ts

### Steps

* Update Session interface with this address proposal, apply to codebase
* Sign transactions with correct identity, not the anonymous user.
* Store delegations when creating a new space.
* Verify transactions against the signer and space's delegations.
* [UX] Option to create new space as public-write (all users have write access(?)) public (delegating read permissions to all users, write permissions to owner), or private (only delegates read/write access to owner)

  
