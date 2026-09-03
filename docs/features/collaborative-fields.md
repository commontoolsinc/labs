# Collaborative fields

Collaborative fields let multiple editors change one stored value without
turning the owning Cell into a last-writer-wins document. Memory orders and
integrates versioned codec operations, stores their durable history, and writes
the resulting value through the ordinary entity revision path. CodeMirror text
collaboration is the first product consumer; the runtime contract itself is
codec-neutral.

## What remains ordinary

The Cell's materialized value remains a string for CodeMirror. Graph queries,
reactive computations, snapshots, point-in-time reads, and non-collaborative UI
consume that ordinary value. They do not read or reconstruct the operation log.

`cf-code-editor` enables this path only when its `collaborative` property is set,
its value is a string Cell handle, and the Memory server advertises
`codemirror-changeset@1`. Plain strings, non-collaborative Cell bindings, and
existing debounce behavior keep their existing whole-value write path.

## Ephemeral co-presence

Live participant names, carets, and selections use a separate WebSocket
service. The presence room stores only the latest value for each live socket;
it receives no document contents or changes and retains no state after a socket
disconnects. Presence is optional and cannot delay, alter, or disable a Memory
operation.

`cf-code-editor` can join only while collaborative editing is active, a
`participantName` is set, and a service endpoint is available. A browser tab
advertises presence in at most one editor room: no room is joined before the
first eligible editor focus, ordinary blur retains that room and selection, and
focusing another editor closes the previous room socket before joining the new
one.
Unmounting the owning editor closes its socket without promoting another
editor. By default each editor derives its opaque document room from the
resolved, pinned Memory field: the space DID, branch, full schemed document id,
resolved scope instance, and complete field path are domain-separated and
hashed. An explicit `presenceRoom` overrides that derived room. The address hash
is a pseudonymous rendezvous key, not authentication; a human space name is
display state and does not participate in Cell identity.

A host supplies the service endpoint through the exported
`presenceUrlContext`; Labs Shell provides it from the optional build-time
`PRESENCE_URL`. An explicit `presenceUrl` on an editor overrides that default
for tests, local development, or a specialized host. With no effective
endpoint, co-presence stays disabled.

Each selection names the Memory `{ epoch, version }` whose document coordinates
it uses and retains CodeMirror's side association for every range endpoint.
CodeMirror maps a displayable remote selection through the same transactions
that install later document changes and through the receiver's own pending
changes. A selection for a future version waits until Memory reaches that
version, while a late selection for an already-passed version is discarded
instead of being guessed into place.

The service implementation and deployment configuration live in the private
[`commontoolsinc/cloudflare-copresence`](https://github.com/commontoolsinc/cloudflare-copresence).
The initial protocol has no authentication. Deployed hosts restrict accepted
origins and use opaque high-entropy room identifiers, which limit accidental
access but are not authorization.

After a socket or protocol failure, the editor does not retry on a timer.
A browser `online` event or the page becoming visible may start a new session.
Editor focus, selection, and user-edit activity do not create repeated
connection attempts while a service is unavailable. Invalid configuration is
reported once and remains disabled until the room, participant name, or
effective endpoint changes. These failures clear only ephemeral decorations
and never make Memory collaboration read-only.

## Authority and lifecycle

Memory is the only integration authority. A client submits an `apply-op` with a
versioned codec id, durable submission id, field cursor, and codec payload. The
same transaction stores the submitted projection, appends canonical integrated
operations, advances the field cursor, and writes the ordinary materialized
revision.

`cf-code-editor` submits every unconfirmed local update in one apply, and
edits made while that apply is in flight go out in the next one, until none
remain. A local update is confirmed by Memory or reported through the editor's
error and reconciliation events; it is never dropped silently.

One collaborative epoch owns a field until it is explicitly released or its
entity is deleted. An ordinary write may change other paths, but it cannot
change an active collaborative path. Deliberate release plus replacement may be
one ordered commit. Reopening the field creates a new epoch.

The current implementation supports only the default branch. Collaborative
queries, applies, and releases on child branches fail explicitly.

## Checkpoints, reconnect, and reset

The operation cursor is `{ epoch, version }`. Memory creates storage-owned
checkpoints at a configured operation interval. When a later checkpoint is
created, integrated rows through the preceding checkpoint are pruned, while
submitted rows remain available for idempotency and audit.

A connected or reconnecting client at the retained floor receives the complete
contiguous suffix. A client behind the floor receives `reset: true` and the
current canonical materialized value. CodeMirror reinstalls from that value
when it has no pending edits. If it has unconfirmed local edits, the editor
preserves them, becomes read-only, and emits an explicit reconciliation event
containing both local and canonical values. A stale write fails with
`OpHistoryUnavailableError`; Memory never transforms it across missing history.

## Operational inspection

`deno task cf inspect operations <space> [entity-id] --json` reads the durable
store offline. It reports field addresses, epochs, cursors, retained floors,
submitted and integrated histories, checkpoints, pagination markers, and
consistency checks against the ordinary materialized value. `cf inspect` is
read-only; explicit pruning is a Memory engine maintenance operation.

OpenTelemetry instruments use the `ct.memory.operation.*` prefix for accepted
apply count, transform suffix length, submitted payload bytes, integration
duration, reset count, codec failures, and observed active-watch count.

The normative storage and protocol contract is
[`../specs/memory-v2/07-op-views-and-annotations.md`](../specs/memory-v2/07-op-views-and-annotations.md).
