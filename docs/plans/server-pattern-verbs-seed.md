# Seed: pattern verbs as server calls

A design seed, not a design: it records the owner's serverize direction
(rulings of 2026-08-24, server-execution v2 coordination) so the arc that
picks this up starts from the ruled anchors instead of re-deriving them. The
register (`docs/specs/server-side-execution/verification-coverage.md`) holds
the surrounding context.

## The ruled direction (owner, 2026-08-24)

- **Pattern lifecycle verbs become server calls.** `upload-pattern`,
  `instantiate`, and `setsrc` execute on the serving runtime, not in the
  client process. The client's part is to *request*; the server's part is to
  compile, materialize, and commit. This is the same authority split the
  event path already has under EXPERIMENTAL_SERVER_EXECUTION.
- **Client speculative-local, server-state wins.** A client may enact
  speculatively for latency (the L2-punted optimistic surface included), but
  durable state is what the server computed; convergence is always toward
  server state. Nothing client-side is authoritative once the wire is
  involved.
- **Thin CLI end-state.** The `cf` client surface converges on: `connect`,
  plus `set` / `send` / `instantiate` as requests to the serving runtime;
  `get` becomes pull-and-wait on server-computed state. The one sanctioned
  whole-stack-in-memory path is **`cf test`** — everything else speaks to a
  server.

## Why this seed exists now

The keyless close-out (L3(a), RULED 2026-08-27) fixed the last writers that
let session-synthetic pattern identities leak into durable state. That fix
holds for the current split-brain shape (client and server each running the
whole stack); the verbs-as-server-calls direction is what retires the shape
itself — a client that only requests cannot mint runtime state the server
never computed. The two arcs meet where instantiation becomes a server call:
piece materialization then has exactly one writer.

## What the follow-up arc has to settle (not settled here)

- Wire shape for the three verbs (request/receipt; where compile errors and
  CFC refusals surface).
- What `cf test`'s in-memory stack shares with the served path so the test
  posture stays representative.
- Migration order for existing CLI callers and harness lanes.

Nothing below the verbs is blocked on this seed; it is direction, recorded.
