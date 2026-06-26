# @commonfabric/state-inspector

Offline autopsy of Common Fabric memory v2 space DBs. Prototype for the
[Multiplayer State Inspector proposal](../../docs/plans/2026-06-26-runtime-trace-inspector.md).

The thesis: **the durable store the server already wrote is the flight
recorder.** This package is the lens over it — open a space SQLite file
read-only, reconstruct state-at-`(branch, seq)`, and answer who/what/when
questions with no live runtime and no capture step.

## Status: prototype (Milestone 1 core)

Implemented and tested against a hermetic fixture + a real 571 MB space DB:

- **read-only DB access** (`db.ts`)
- **value decoder** (`decode.ts`) — recognizes legacy sigil links
  `{ "/": { "link@1": {…} } }`, entity refs `{ "/": "of:…" }`, and streams
  `{ "$stream": true }`; annotates a value into JSON-printable form.
- **state reconstruction** (`reconstruct.ts`) — replays the append-only
  `revision` log (`set` / `patch` (RFC 6902) / `delete`) to a target seq.
- **autopsy queries** (`queries.ts`) — `summary`, `commits`, `entityHistory`
  (who wrote this), `hotEntities` (contention proxy).
- **thin CLI** (`cli.ts`) — every command supports `--json` for agents.

## Reality checks found while building (feed back into the plan)

1. **Scheduler tables are usually absent.** The 571 MB production-shaped DB had
   only the entity tables (`commit`, `revision`, `head`, `snapshot`, `branch`,
   `blob_store`, `invocation`, `authorization`). `scheduler_observation` &
   friends only exist when `persistentSchedulerState` was enabled on the server.
   ⇒ The autopsy core that works *today* is entity-history only; the scheduler
   read/write graph is opt-in, so every query must degrade gracefully
   (`hasSchedulerTables`).
2. **Stored values are plain JSON with inline sigil links**, not the `fvj1:`
   codec-json envelope. Decoding current DBs needs no `@commonfabric/data-model`
   dependency. The modern envelope can be plugged in at the leaves later.
3. **Entity ids are legacy `of:baedrei…` (CIDv1)** in these DBs; modern cell-rep
   uses `fid1:…`. The decoder treats both as opaque strings.

## Usage

```bash
# from repo root
DB="packages/toolshed/cache/memory/engine-v3/engine-v3/<space-did>.sqlite"

deno task --cwd packages/state-inspector inspect summary  "$DB"
deno task --cwd packages/state-inspector inspect commits  "$DB" --limit 20
deno task --cwd packages/state-inspector inspect hot      "$DB" --limit 10
deno task --cwd packages/state-inspector inspect history  "$DB" of:baedrei… 
deno task --cwd packages/state-inspector inspect value-at "$DB" of:baedrei… --path value/count
```

## Not yet built (next milestones)

- Per-path **convergence diagnosis** across multiple space DBs (M2).
- `ifc` / security-label decoding from stored schemas.
- Snapshot-base optimization for reconstruction (currently replays from seq 0).
- Wiring into `cf inspect` as a first-class subcommand.
- Client-side correlation overlay (connectionId / eventId).
