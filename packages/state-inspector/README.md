# @commonfabric/state-inspector

Offline autopsy of Common Fabric **memory v2** space DBs.

The thesis: **the durable store the server already wrote is the flight
recorder.** This package is the lens over it — open a space SQLite file
read-only, reconstruct state-at-`(branch, seq)`, and answer who/what/when/
why-different questions with no live runtime and no capture step.

Wired into the `cf` CLI as **`cf inspect`** with local-DB auto-discovery (no
absolute paths needed). Agents: see the `state-inspector` skill
(`skills/state-inspector/SKILL.md`) for the debugging map — when to reach for
each command and what to trust.

## What it sees (the model you need to read the output)

memory v2 stores each entity as a **document tree**, not a bare value: a `value`
plus the meta paths `argument` / `result` / `patternIdentity` / `internal` /
`schema` / `cfc`. The tool classifies an entity by **which top-level paths
exist** and resolves lineage from them:

| Kind         | Signal                                                                   |
| ------------ | ------------------------------------------------------------------------ |
| `piece`      | `patternIdentity` (modern) or a legacy `$TYPE`/`resultRef` process value |
| `module`     | value carries `{ code, identity }` (pattern source/compiled)             |
| `stream`     | `value.$stream === true`                                                 |
| `schema`     | value is a JSONSchema (`{ type, properties\|$defs }`)                    |
| `owned-cell` | carries a `result` ownership back-link                                   |
| `free-cell`  | a bare `value`, owned by no piece                                        |

Lineage: a piece → its input (`argument`), its pattern (`patternIdentity` → the
module entity), its owned cells (`internal`); an owned cell → its owner
(`result`). This is why `entities` / `piece` / `graph` can speak in pieces and
links rather than raw blobs.

**`scope_key` partitions an entity by identity.** The same cell id can hold a
shared `space` value AND a per-`user:<DID>` override AND a
per-`session:<DID>:<sid>` override, stored side by side and genuinely different
— this is where "looks different for me" multiplayer bugs live.

**Two at-rest value formats coexist, both handled:** modern `fvj1:`-prefixed
codec-json (ids `of:fid1:…`) and legacy plain-JSON sigils (ids `of:baedrei…`).
`decode.ts` routes by the `fvj1:` tag; links are recognized in both the legacy
sigil form (`{ "/": { "link@1": {…} } }`) and the modern `FabricLink` form.

## What is ground truth vs. a hint

The tool is deliberate about this — quoting an approximation as truth is the
failure mode it guards against:

- **`overlay <space> <id>` is ground truth** for "who sees what differently":
  the value in every scope, side by side, with divergence judged on the **raw**
  stored value (depth-complete, fabric-aware).
- **`value-at --as <DID>` is an APPROXIMATION** — the most-specific stored scope
  holding the id. It can't know which declared scope a real read targets, nor
  follow the base-scope link the runtime uses. Use `overlay` for truth.
- **`conflicts` stale-reads are an ANOMALY detector, not lost-update history.**
  The engine validates confirmed reads _before_ committing
  (`validateConfirmedReads`), so a healthy store yields zero. A hit is an
  invariant violation / corruption; "0 anomalies" means consistent, not "no
  concurrency." The writer-timeline / `multiUser` contention view is the
  normal-history side.
- **`converge` is server-view only** — durable values compared; client cursor
  lag and optimistic writes aren't visible.
- **Same id across spaces is usually independent instances**, not replica drift
  (content-addressed ids). The scan labels `cross-space-linked` (real replica →
  drift bug) vs `no-cross-space-link` (likely instance).

## Fidelity — reconstruction is the engine's, not a fork

State-at-`(branch, seq)` reconstruction **replicates the engine's read path**
(`read()` → `readRowForBranch` → `reconstructPatchedDocument` in
`packages/memory/v2`): it resolves the visible row with branch inheritance,
reconstructs within the resolved branch from the latest
`set`/`delete`/`snapshot` base, and applies patches through the server's own
`applyPatch` (`@commonfabric/memory/v2/patch`) — not a re-implementation, since
that dialect has a custom `splice` op and specific add/missing-key semantics a
hand-rolled applier gets wrong. `reconstruct-parity.test.ts` **drives the real
engine** and asserts `reconstructDocument == engine.read()` across branch
inheritance, child-local patches, tombstones, patch-first, and snapshots.
Conflict and scope analysis likewise reuse the engine's exported
`patchOverlapsRead` / `resolveScopeKey` rather than re-deriving them.

The store can't be opened through the live `Engine` (its constructor runs
migrations that would mutate the durable file), so reconstruction is a
parity-tested replica; extracting a shared read-only materializer in memory v2
is the natural next step.

## Usage (`cf inspect`)

Run from a repo with local space DBs (discovery walks up to the cache), or point
at any directory with `--dir` / `MEMORY_DIR` / `DB_PATH`. `<space>` is a DID, a
unique DID-prefix, a space **name** (resolved the way the runtime derives it),
or a path. Every command takes `--json` for agents.

```bash
# discover what's inspectable, then drill in
deno task cf inspect spaces
deno task cf inspect group                       # per-user worlds (home→profiles→main)
deno task cf inspect identity did:key:z6MkeZZv…  # one identity: its spaces + scopes it owns

# the per-identity (multiplayer) dimension — scopes within a space
deno task cf inspect users    z6Mkqa41           # identities that touched this space
deno task cf inspect scopes   z6Mkqa41           # space / per-user / per-session scopes
deno task cf inspect overlay  z6Mkqa41 of:fid1:… # a cell across EVERY scope — GROUND TRUTH
deno task cf inspect value-at z6Mkqa41 of:fid1:… --as did:key:z6MkeZZv…   # ≈ APPROX identity view

# conflicts & async — contested cells + anomalous-stale-read detection
deno task cf inspect conflicts z6Mkqa41                  # cells written by ≥2 sessions (multi-user flagged)
deno task cf inspect conflicts z6Mkqa41 of:fid1:…        # writer timeline + ANOMALY analysis

# what's in a space
deno task cf inspect summary  z6Mkqa41
deno task cf inspect entities z6Mkqa41 [--kind piece]
deno task cf inspect piece    z6Mkqa41 of:fid1:… [--code]   # pattern source, input, owned cells
deno task cf inspect hot      z6Mkqa41 --limit 10
deno task cf inspect history  z6Mkqa41 of:fid1:…
deno task cf inspect value-at z6Mkqa41 of:fid1:… --path value/count [--seq N]

# the entity graph (relationships between pieces/cells/modules)
deno task cf inspect graph    z6Mkqa41 [--root of:fid1:… --depth 2] [--dot]

# time travel
deno task cf inspect diff     z6Mkqa41 of:fid1:… --from 7 --to 12
deno task cf inspect timeline z6Mkqa41 [of:fid1:…]          # how a space / one entity grew

# a self-contained HTML explorer (tree + graph + detail) to open in a browser
deno task cf inspect html     z6Mkqa41 --out /tmp/space.html [--app-url https://host]

# cross-space convergence (--all discovered, or --spaces a,b, or --dir)
deno task cf inspect converge      of:fid1:… --all --path value
deno task cf inspect converge-scan --all --json
```

A standalone `cli.ts` entry exists for use outside the `cf` CLI.

## Known characteristics

- **Scheduler tables are usually absent** on disk (present only when
  `persistentSchedulerState` was enabled). The entity-history surface always
  works and every scheduler-dependent query degrades gracefully — absence is
  normal, not a broken DB.
- **Lists and the HTML bundle are capped** for cost; un-analyzed cells are
  marked rather than shown as clean. A count at a round cap may be truncated —
  narrow with flags or a per-entity command.
- **Reads DBs it didn't write**: a corrupt/partial row degrades that one entity,
  not the whole command. If a value looks absent where you expect data, check
  for a decode error before concluding the entity is empty.

## Not yet built

- `ifc` / security-label decoding from stored schemas (CFC labels are surfaced;
  full ifc decode is partial).
- Client-side correlation overlay (connectionId / eventId) for the per-session
  dimension of convergence.
- A shared read-only materializer in memory v2 so reconstruction calls the
  engine directly instead of a parity-tested replica.
