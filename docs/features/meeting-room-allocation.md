# Canonical meeting-room allocation

Toolshed can retain one canonical social Loom address for a portable calendar
occurrence. A daemon using this boundary first searches its owned and joined
social Looms. Before publishing a new meeting Loom, it calls the host's allocation
boundary. Every
participant uses the same host authority and the same occurrence signature.
Only the returned address may receive the meeting's panels or invitations.

This boundary selects an address. It grants no membership, and does not check
Calendar attendance. Calendar enrollment, recipient review, verification of a
room's meeting binding, and ordinary Fabric admission remain the daemon's
responsibility. A retained address that the caller cannot access holds that
caller's preparation; it never causes a replacement allocation.

## Requests and results

`GET /api/meeting-rooms` returns `available` and `scope: "host"`.
`POST /api/meeting-rooms/ensure` requires the existing first-party HTTP proof,
bound to the configured public `API_URL`, method, path and body. The request
contains:

- `key`: `scheme: "ical-uid-slot"`, `item_key` and `occurrence_key`. Both keys
  are lowercase, 64-character hexadecimal digests. Raw Calendar UIDs, organizer
  addresses and conference URLs are absent from this signature.
- `requestId`: a UUID retained by the requesting daemon for this preparation.
- `candidate`: either a `root` genesis reservation for a new Loom, or `space`,
  the DID of a room the caller already owns. These forms are exclusive.

The result contains `space` and `creator`, the principal whose proposal first
committed. For an allocated room, that principal also receives `intent`, holding
its retained `requestId` and `root`. Another principal receives the address and
creator alone. A retry with different proposed root data still receives the
retained intent. Adopting an existing room returns no new creation intent.

A new candidate declares the `loom` space kind and grants its authenticated
creator `OWNER`. Genesis uses ordinary random space creation through the
configured, space-addressed `MEMORY_URL`; its private key is never persisted.
The retained root reservation determines the publication cause. The daemon
verifies the Loom root and portable occurrence binding before sharing it.

An existing candidate requires an explicit `OWNER` grant to the caller. The
host does not rewrite its root or Calendar metadata. Before proposing a legacy
room, the daemon verifies its existing meeting binding and corroborates any
portable identity migration. A conflicting canonical address holds for review.

## Concurrency, durability and recovery

The host stores associations in `meeting-rooms.sqlite` under its resolved
Memory engine store root. All API processes for the authority use this same
file. An immediate SQLite transaction conditionally inserts the full portable
signature as its primary key, or reads the existing row. Allocating a new occurrence with a request UUID
that already allocated another occurrence for that principal is refused.

Candidates complete genesis and pass `Server.flushSpace()` before their
association commits with SQLite `synchronous=FULL`. The flush completes a
[full WAL checkpoint](https://www.sqlite.org/pragma.html#pragma_wal_checkpoint)
and throws if a reader prevents it. Thus a committed association
references a durable space. No bootstrap key or pending creation worker is
needed in the association store.

Concurrent requests may create unreferenced candidate spaces. A crash before
the association commits can leave one as well. These candidates receive no
meeting panels, Home entry or invitations from this operation, and are
abandoned under the ordinary
[random space creation contract](../specs/random-space-identities.md). A daemon
never receives its losing candidate as the canonical result. Once the
association commits, retries, process restarts and later participants return
the retained address without creating another candidate. The original creator
resumes publication and invitations from its local journal.

Allocation-store read errors and failed space creation or durability barriers
propagate as service errors. They are never interpreted as an absent meeting.
The host does not expire associations or replace inaccessible rooms.

## Authority and deployment

Uniqueness applies within one durable host allocation store. It does not span
independent host origins or unrelated copies of that store. Participants in one
meeting need a common authority. Backups and restore preserve the allocation
store alongside the space stores.

The route advertises `available: false` and refuses mutations with HTTP 503
when `MEMORY_ROUTER_CONFIG_FILE` configures Mode A: the allocation boundary has
no shared control-plane authority across those shards. A daemon treats an
unavailable host as a hold. The existing deployment's space-addressed Memory
routing remains in use for candidate genesis; an API process does not create a
space through its embedded Memory server.
