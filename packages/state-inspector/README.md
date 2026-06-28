# @commonfabric/state-inspector

Offline autopsy of Common Fabric memory v2 space DBs. Prototype for the
[Multiplayer State Inspector proposal](../../docs/plans/2026-06-26-runtime-trace-inspector.md).

The thesis: **the durable store the server already wrote is the flight
recorder.** This package is the lens over it — open a space SQLite file
read-only, reconstruct state-at-`(branch, seq)`, and answer who/what/when
questions with no live runtime and no capture step.

## Status: usable (Milestones 1, 2, 2.5, 3 + model unification)

Wired into the `cf` CLI as **`cf inspect`** with local-DB auto-discovery — no
absolute paths needed. Tested end-to-end against real space DBs (a 571 MB legacy
DB and a set of modern `fvj1:` DBs).

**Model unification** (`model.ts`) makes the tool _fluent_: instead of guessing
from the shape of `doc.value`, it reads the **whole entity document** (`value`
plus the meta paths `argument` / `result` / `patternIdentity` / `internal` /
`schema` / `cfc`) and classifies by **which top-level paths exist**:

| Kind         | Signal                                                                   |
| ------------ | ------------------------------------------------------------------------ |
| `piece`      | `patternIdentity` (modern) or a legacy `$TYPE`/`resultRef` process value |
| `module`     | value carries `{ code, identity }` (pattern source/compiled)             |
| `stream`     | `value.$stream === true`                                                 |
| `schema`     | value is a JSONSchema (`{ type, properties\|$defs }`)                    |
| `owned-cell` | carries a `result` ownership back-link                                   |
| `free-cell`  | a bare `value`, owned by no piece                                        |

It also resolves **lineage**: a piece → its input (`argument`), its pattern
(`patternIdentity` → the module entity, matched by `value.identity`), and its
owned cells (`internal` manifest); an owned cell → its owner (`result`). This
corrected `entities` (the old value-shape heuristic undercounted pieces — 4 of 7
in the notes space; now all 7) and added `cf inspect piece <id>`.

**M3 — usable surface**

- `cf inspect spaces` — discover local space DBs (walks up from cwd through
  `cache/memory/…` and `packages/toolshed/cache/memory/…`, or honors
  `MEMORY_DIR` / `DB_PATH` / `--dir`) and list them with quick stats.
- All commands take a `<space>` as a **DID, DID-prefix, or path** (resolved via
  discovery), so you go from `spaces` straight to drilling in.

Underlying milestones:

**M1 — single-space autopsy core**

- **read-only DB access** (`db.ts`)
- **value decoder** (`decode.ts`) — recognizes sigil links
  `{ "/": { "link@1": {…} } }`, entity refs `{ "/": "of:…" }`, and streams
  `{ "$stream": true }`; annotates a value into JSON-printable form.
- **state reconstruction** (`reconstruct.ts`) — replays the append-only
  `revision` log (`set` / `patch` / `delete`) to a target seq. **Patch
  application reuses the server's `applyPatch`**
  (`@commonfabric/memory/v2/patch`), not a re-implementation — see fidelity note
  below.
- **autopsy queries** (`queries.ts`) — `summary`, `commits`, `entityHistory`
  (who wrote this), `hotEntities` (contention proxy).

**M2 — cross-space convergence** (`multispace.ts`)

- `convergence(spaces, {id, path})` — reconstruct an entity's value across N
  space DBs, cluster equal values, and classify: `converged` / `diverged` /
  `partial` (present in some, absent in others) / `absent`. Per-space evidence:
  head seq, revision count, last writer, last write time. Resilient: a decode
  error in one space is isolated, not fatal.
- `convergenceScan(spaces)` — find entities present in ≥2 spaces and report
  those that diverge.

**M2.5 — replica vs. instance classification** (`multispace.ts`)

- `buildCrossSpaceLinkIndex(spaces)` — find every link whose `space` names a
  _different_ space than the one holding it (only entities whose stored data
  carries an explicit `"space":"did:key:` are reconstructed, so it stays cheap).
- Each divergence is then labeled `cross-space-linked` (a real replica that
  should converge → **drift bug**) vs `no-cross-space-link` (shared id with no
  cross-space link → **likely independent same-pattern instance**, expected).
  This stops the scan from crying wolf on every same-id divergence.

**CLI** (`cli.ts`) — every command supports `--json` for agents: `summary`,
`commits`, `hot`, `history`, `value-at`, `converge`, `converge-scan`.

## Fidelity note (why reconstruction reuses the server applier)

The server's JSON-Patch dialect (`packages/memory/v2/patch.ts`) is **not plain
RFC 6902**: it has a custom `splice` op (`{index, remove, add}`), creates
missing object keys on `add`, and is strict about missing array indices. A
hand-rolled applier silently dropped `splice` and mis-handled `add`.
Reconstruction therefore calls the real `applyPatch` (offline-safe: pure value
ops, no live runtime/cell). The hermetic test guards `splice` + missing-key
`add` against regressing to a fork.

## Reality checks found while building (feed back into the plan)

1. **Scheduler tables are usually absent.** The 571 MB production-shaped DB had
   only the entity tables. `scheduler_observation` & friends exist only when
   `persistentSchedulerState` was enabled. ⇒ The autopsy core that works _today_
   is entity-history only; the scheduler graph is opt-in, so every query
   degrades gracefully (`hasSchedulerTables`).
2. **TWO at-rest value formats exist in the wild** — both handled:
   - **modern**: an `fvj1:`-prefixed codec-json envelope (decoded via
     `valueFromJson`; embedded links are `/quote`-escaped literals, so a
     context-less decode is inert and never reconstructs a live cell). Entity
     ids: `of:fid1:…`.
   - **legacy**: plain JSON with inline sigil links. Entity ids: `of:baedrei…`.
     `reconstruct.ts` routes by the `fvj1:` tag. (This corrects an earlier
     assumption that no `@commonfabric/data-model` dependency was needed.)
3. **Same-id divergence is usually NOT replica drift (now classified).** Many
   entities share a content-addressed id across spaces because they're instances
   of the same pattern (e.g. `home.tsx`), not cross-space replicas — so they
   _legitimately_ diverge. M2.5 classifies each divergence via the cross-space
   link index. **Real dev DBs frequently contain ZERO cross-space links**, in
   which case every same-id divergence is correctly labeled
   `no-cross-space-link` (likely independent instance). The classifier exists to
   suppress false alarms now and to flag real drift the moment cross-space
   replicas appear. (Verified: `converge-scan` over real `fvj1` DBs reports
   `0 cross-space link edges` and labels all 14 findings as instances.)

## Usage (`cf inspect`)

Run from a repo with local space DBs (discovery walks up to find the cache), or
point at any directory with `--dir` / `MEMORY_DIR`. `<space>` is a DID, a unique
DID-prefix, or a path.

```bash
# discover what's inspectable
deno task cf inspect spaces

# single space (DID-prefix resolves via discovery)
deno task cf inspect summary  z6Mkqa41
deno task cf inspect entities z6Mkqa41           # what's in here: pieces/modules/streams/cells
deno task cf inspect entities z6Mkqa41 --kind piece
deno task cf inspect piece    z6Mkqa41 of:fid1:… # a piece: pattern source, input, owned cells
deno task cf inspect piece    z6Mkqa41 of:fid1:… --code   # + full pattern TS source
deno task cf inspect hot      z6Mkqa41 --limit 10
deno task cf inspect commits  z6Mkqa41 --limit 20
deno task cf inspect history  z6Mkqa41 of:fid1:…
deno task cf inspect value-at z6Mkqa41 of:fid1:… --path value/count

# cross-space convergence (--all discovered, or --spaces a,b, or --dir)
deno task cf inspect converge      of:fid1:… --all --path value
deno task cf inspect converge-scan --all --json
```

Every command also accepts `--json` for agents. (A standalone `cli.ts` entry
exists for use outside the `cf` CLI.)

## Not yet built (next milestones)

- `ifc` / security-label decoding from stored schemas.
- Snapshot-base optimization for reconstruction (currently replays from seq 0).
- Client-side correlation overlay (connectionId / eventId) for the per-session
  view dimension of convergence.
