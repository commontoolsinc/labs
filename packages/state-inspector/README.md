# @commonfabric/state-inspector

Offline autopsy of Common Fabric memory v2 space DBs. Prototype for the
[Multiplayer State Inspector proposal](../../docs/plans/2026-06-26-runtime-trace-inspector.md).

The thesis: **the durable store the server already wrote is the flight
recorder.** This package is the lens over it — open a space SQLite file
read-only, reconstruct state-at-`(branch, seq)`, and answer who/what/when
questions with no live runtime and no capture step.

## Status: prototype (Milestones 1 + 2)

Tested against hermetic fixtures + real space DBs (a 571 MB legacy DB and a set
of modern `fvj1:` DBs):

**M1 — single-space autopsy core**
- **read-only DB access** (`db.ts`)
- **value decoder** (`decode.ts`) — recognizes sigil links
  `{ "/": { "link@1": {…} } }`, entity refs `{ "/": "of:…" }`, and streams
  `{ "$stream": true }`; annotates a value into JSON-printable form.
- **state reconstruction** (`reconstruct.ts`) — replays the append-only
  `revision` log (`set` / `patch` / `delete`) to a target seq. **Patch
  application reuses the server's `applyPatch`** (`@commonfabric/memory/v2/patch`),
  not a re-implementation — see fidelity note below.
- **autopsy queries** (`queries.ts`) — `summary`, `commits`, `entityHistory`
  (who wrote this), `hotEntities` (contention proxy).

**M2 — cross-space convergence** (`multispace.ts`)
- `convergence(spaces, {id, path})` — reconstruct an entity's value across N
  space DBs, cluster equal values, and classify:
  `converged` / `diverged` / `partial` (present in some, absent in others) /
  `absent`. Per-space evidence: head seq, revision count, last writer, last
  write time. Resilient: a decode error in one space is isolated, not fatal.
- `convergenceScan(spaces)` — find entities present in ≥2 spaces and report
  those that diverge.

**CLI** (`cli.ts`) — every command supports `--json` for agents:
`summary`, `commits`, `hot`, `history`, `value-at`, `converge`, `converge-scan`.

## Fidelity note (why reconstruction reuses the server applier)

The server's JSON-Patch dialect (`packages/memory/v2/patch.ts`) is **not plain
RFC 6902**: it has a custom `splice` op (`{index, remove, add}`), creates missing
object keys on `add`, and is strict about missing array indices. A hand-rolled
applier silently dropped `splice` and mis-handled `add`. Reconstruction therefore
calls the real `applyPatch` (offline-safe: pure value ops, no live runtime/cell).
The hermetic test guards `splice` + missing-key `add` against regressing to a fork.

## Reality checks found while building (feed back into the plan)

1. **Scheduler tables are usually absent.** The 571 MB production-shaped DB had
   only the entity tables. `scheduler_observation` & friends exist only when
   `persistentSchedulerState` was enabled. ⇒ The autopsy core that works *today*
   is entity-history only; the scheduler graph is opt-in, so every query degrades
   gracefully (`hasSchedulerTables`).
2. **TWO at-rest value formats exist in the wild** — both handled:
   - **modern**: an `fvj1:`-prefixed codec-json envelope (decoded via
     `valueFromJson`; embedded links are `/quote`-escaped literals, so a
     context-less decode is inert and never reconstructs a live cell).
     Entity ids: `of:fid1:…`.
   - **legacy**: plain JSON with inline sigil links. Entity ids: `of:baedrei…`.
   `reconstruct.ts` routes by the `fvj1:` tag. (This corrects an earlier
   assumption that no `@commonfabric/data-model` dependency was needed.)
3. **Convergence needs link-graph context to interpret.** Many entities share a
   content-addressed id across spaces because they're instances of the same
   pattern (e.g. `home.tsx`), not because they're cross-space replicas — so they
   *legitimately* diverge. Distinguishing "replica that should converge" from
   "independent instance" requires following cross-space links; that's the M2.5
   refinement. The scan currently surfaces all same-id divergence as candidates.

## Usage

```bash
DIR=/abs/path/to/engine-v3   # a directory of <space-did>.sqlite files
INSPECT="deno run --allow-read --allow-ffi --allow-env cli.ts"

# single space
$INSPECT summary  "$DIR/<did>.sqlite"
$INSPECT hot      "$DIR/<did>.sqlite" --limit 10
$INSPECT value-at "$DIR/<did>.sqlite" of:fid1:… --path value/count

# cross-space convergence
$INSPECT converge      of:fid1:… --dir "$DIR" --path value
$INSPECT converge-scan --dir "$DIR" --limit 20 --json
```

## Not yet built (next milestones)

- **M2.5** — follow cross-space links so convergence separates true replicas
  from same-pattern instances.
- `ifc` / security-label decoding from stored schemas.
- Snapshot-base optimization for reconstruction (currently replays from seq 0).
- Wiring into `cf inspect` as a first-class subcommand.
- Client-side correlation overlay (connectionId / eventId) for the per-session
  view dimension of convergence.
