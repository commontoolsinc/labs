# Random Space Identities

## Status

Proposed target behavior and the active deployment direction. The
[implementation plan](../plans/random-space-identities.md) describes the
one-shot code and data change.

The [Common Fabric URL](fabric-urls.md) and
[space name registry](../plans/space-name-registry.md) designs are separate
concepts. Neither is planned for deployment, and neither is a dependency of
this specification.

## Scope

This specification applies to newly created ordinary spaces. A Home space
continues to use its user's DID as its space DID. Existing spaces keep their
DIDs.

A display label is user metadata. It does not select key data, determine a DID,
or resolve a route.

## Identity and genesis

- Each create action generates a fresh key pair from at least 256 bits of
  entropy supplied by the platform cryptographic random source.
- The public key determines the space DID. The display label, creator DID,
  application service provider hostname, clock, process identity, and
  idempotency key do not contribute key material.
- The private key signs one ACL-only genesis transaction. That transaction has
  no prior version and makes the authenticated creator the first owner.
- The complete signed genesis transaction is recorded durably before it is
  submitted to the space.
- The private key is destroyed after the signed transaction has been handed to
  that durable recording attempt. It is never stored, returned, logged, or
  used after genesis.
- After genesis, the space DID has no implicit owner or repair capability.
  Ordinary ACL grants determine access.

## One create action

A caller supplies an authenticated creator, a target application service
provider, and an opaque idempotency key. Repeating the same create action at
the same provider returns the same accepted DID and genesis transaction.
Starting a new create action generates a different space, even when its label
is unchanged.

Creation has one durable record whose state can be resumed by any request
process. It records the accepted random allocation before the target provider
creates or selects storage for that DID. A process that loses a conditional
allocation attempt discards its candidate. It returns only the allocation in
the durable record.

Creation completes after all of the following are durable:

- the accepted random DID and signed genesis transaction;
- a writable provider route for that DID;
- the committed genesis transaction; and
- the DID-keyed entry in the creator's Home space.

## Routing across provider processes

The process that receives a create request is not assumed to host the new
space. Before submitting genesis, the target provider must make the accepted
DID routable to one logical writable Common Memory history and its durable
store. Establishing that route must be idempotent for the DID.

Genesis and every later space operation use the provider's ordinary
space-addressed Memory endpoint. They do not call a Memory server merely
because it is embedded in the process handling the request. A retry through a
different request process therefore reaches the same accepted allocation and
the same space history.

The selected process may change after a restart, failover, or placement move.
Before another process accepts writes, the provider must preserve the durable
history and fence the previous writer. Process identity is neither space
identity nor part of the idempotency key.

Provider-private creation records live in a fixed set of pre-provisioned
control spaces. Those control spaces use the same routed storage contract as
ordinary spaces. A deployment that requires explicit space placement must
place the control spaces before enabling creation.

If route establishment fails after allocation, the create action remains
unfinished. Recovery resumes route establishment for the recorded DID and
then submits the recorded genesis transaction. It does not allocate another
DID.

## Deployment mappings

The current Estuary and Rapids
[process inventory](https://github.com/commontoolsinc/infra/blob/16e48222254059cc9eff53f5064ab696fbd37236/ansible/vars/toolshed-binary.yml)
runs 21 Toolshed processes on one host. The checked-in
[nginx configuration](https://github.com/commontoolsinc/infra/blob/16e48222254059cc9eff53f5064ab696fbd37236/ansible/roles/nginx/templates/toolshed.conf.j2)
round-robins ordinary API requests across five processes and routes a Memory
WebSocket carrying `space=<did>` to one of sixteen processes. Every process
loads the same
[service environment](https://github.com/commontoolsinc/infra/blob/16e48222254059cc9eff53f5064ab696fbd37236/ansible/roles/toolshed-binary/templates/toolshed-binary%40.service.j2),
and the host prepares one
[data volume](https://github.com/commontoolsinc/infra/blob/16e48222254059cc9eff53f5064ab696fbd37236/ansible/playbooks/toolshed_setup_disk.yml).
Random-space creation must send control-space and newly allocated space
connections through that nginx route. In particular, each production
`MEMORY_URL` must name the host-internal routed endpoint rather than a
process-local endpoint.

The Kubernetes replacement in `common-cluster` maps a space DID through a
[`SpacePlacement`](https://github.com/commontoolsinc/common-cluster/blob/dc70d63f2ce44930a1b23793a998e78eeac863bf/docs/design.md#july-2026-architecture-amendment-per-space-first-per-user-later)
to a `ToolshedShard`. Its current
[router](https://github.com/commontoolsinc/common-cluster/blob/dc70d63f2ce44930a1b23793a998e78eeac863bf/cmd/toolshed-router-extproc/router.go)
fails closed for an unknown placement. A deployment using that router must
idempotently create or find the accepted DID's placement and wait for its
shard to become writable before submitting genesis. The same operation places
the fixed control spaces during deployment preparation.

Labs supplies the common client boundary. A remote Memory session appends the
space DID to its
[`space` query parameter](../../packages/runner/src/storage/v2-remote-session.ts)
and Toolshed server runtimes connect through
[`MEMORY_URL`](../../packages/toolshed/runtime-options.ts). Both current and
future deployment routers must preserve that contract.

## Compatibility

Existing deterministic spaces remain addressable by their existing DIDs. New
browser navigation uses the existing ASP-hosted DID route. This change does not
add friendly-name lookup, name registration, Domain Name System namespaces, or
cross-provider move redirects.
