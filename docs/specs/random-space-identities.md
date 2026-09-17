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
provider, and an opaque idempotency key. The target is identified canonically
by its normalized public ASP origin and an immutable control-namespace version
that the ASP advertised before the creator signed the intent. The ASP
advertises one canonical public origin for each version; an alias is resolved
to that origin before signing. The idempotency scope is the creator DID,
normalized target origin, and opaque key; a retry must retain the recorded
namespace version. A different version at that scope is a conflict, not a new
create action. Repeating the same create action returns the same accepted DID
and genesis transaction. Starting a new create action generates a different
space, even when its label is unchanged.

Creation has one durable record whose state can be resumed by any request
process. It records the accepted random allocation before the target provider
creates or selects storage for that DID. A process that loses a conditional
allocation attempt discards its candidate. It returns only the allocation in
the durable record.

Creation completes after all of the following are durable:

- the accepted random DID and signed genesis transaction;
- the exact recorded genesis transaction committed as the DID's first history;
  and
- one Home-space transaction that completes the immutable creation record and
  adds the DID-keyed space entry and authenticated storage-origin hint.

## Routing across provider processes

The process that receives a create request is not assumed to host the new
space. Genesis and every later space operation use the provider's ordinary
space-addressed Memory endpoint, which routes one DID to one logical writable
Common Memory history and its durable store. They do not call a Memory server
merely because it is embedded in the process handling the request. A retry
through a different request process therefore reaches the same accepted
allocation and the same space history.

The routed endpoint accepts a previously unseen DID and atomically creates its
history when it accepts the recorded genesis transaction. Every connection for
that DID reaches the same logical history even when request processes restart
or the backend set changes. Finding the exact transaction already committed is
success. Finding a different genesis for the accepted DID is an integrity
failure.

The selected process may change after a restart, failover, or placement move.
Before another process accepts writes, the provider must preserve the durable
history and fence the previous writer. Process identity is neither space
identity nor part of the idempotency key.

Provider-private creation records live in a fixed set of pre-provisioned
control spaces. Those control spaces use the same routed storage contract as
ordinary spaces. A deployment that requires explicit space placement must
place the control spaces before enabling creation.

If routed genesis submission fails after allocation, the create action remains
unfinished. Recovery resubmits the recorded genesis transaction through the
ordinary routed endpoint. It does not allocate another DID.

## Deployment mappings

The current Estuary and Rapids
[process inventory](https://github.com/commonfabric/infra/blob/16e48222254059cc9eff53f5064ab696fbd37236/ansible/vars/toolshed-binary.yml)
runs 21 Toolshed processes on one host. The checked-in
[nginx configuration](https://github.com/commonfabric/infra/blob/16e48222254059cc9eff53f5064ab696fbd37236/ansible/roles/nginx/templates/toolshed.conf.j2)
round-robins ordinary API requests across five processes and routes a Memory
WebSocket carrying `space=<did>` to one of sixteen processes. Every process
loads the same
[service environment](https://github.com/commonfabric/infra/blob/16e48222254059cc9eff53f5064ab696fbd37236/ansible/roles/toolshed-binary/templates/toolshed-binary%40.service.j2),
and the host prepares one
[data volume](https://github.com/commonfabric/infra/blob/16e48222254059cc9eff53f5064ab696fbd37236/ansible/playbooks/toolshed_setup_disk.yml).
Random-space creation must send control-space and newly allocated space
connections through that nginx route. In particular, each production
`MEMORY_URL` must name the host-internal routed endpoint rather than a
process-local endpoint. Process restarts and changes to the nginx backend set
must not change the durable history selected by a DID.

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
