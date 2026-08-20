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

**Two at-rest value formats coexist, both handled:** modern `data-model`
codec-json, which carries that codec's prefix tag (ids `of:fid1:…`), and legacy
plain-JSON sigils (ids `of:baedrei…`). `decode.ts` routes on the presence of
that tag; links are recognized in both the legacy sigil form
(`{ "/": { "link@1": {…} } }`) and the modern `FabricLink` form.

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
  lag and optimistic writes aren't visible. A reconstruction failure produces an
  `unknown` verdict instead of treating unavailable data as equal or different.
- **Same id across spaces is usually independent instances**, not replica drift
  (content-addressed ids). The scan labels `cross-space-linked` (real replica →
  drift bug) vs `no-cross-space-link` (likely instance).
- **A `schema` under `$link` is the schema the link stores**, never a stand-in
  for one. A stored schema is a JSON Schema, so `true` (selects every value) and
  `false` (selects none) are values a link can really hold, and they say
  different things about what that link constrains. A schema too large to read
  inline is described by a `$schemaSummary` **beside** `schema` rather than
  under it — top-level keys, byte count as stored, and a truncated digest. The
  slot is what carries the distinction: a link can store a schema of any shape,
  so a summary placed under `schema` could be a schema some link really holds,
  while nothing stored reaches a `$`-prefixed sibling. The two never both
  appear, and neither appearing means the link stores no schema. Different
  digests prove two schemas differ; equal ones make agreement overwhelmingly
  likely without proving it. `--full-depth` writes every schema out in full —
  annotated like any other value, so a sigil-shaped literal under `const` /
  `default` / `enum` reads back as `$link` / `$ref`.

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
deno task cf inspect entities z6Mkqa41 [--kind piece] [--limit 5000] [--require-complete]
deno task cf inspect piece    z6Mkqa41 of:fid1:… [--code]   # pattern source, input, owned cells
deno task cf inspect hot      z6Mkqa41 --limit 10
deno task cf inspect churn    z6Mkqa41 [--bucket 60] [--since '2026-07-22 10:00:00'] [--top 10]
deno task cf inspect history  z6Mkqa41 of:fid1:…
deno task cf inspect value-at z6Mkqa41 of:fid1:… --path value/count [--seq N]
deno task cf inspect value-at z6Mkqa41 of:fid1:… --full-depth # every nested value, every link schema

# the entity graph (relationships between pieces/cells/modules)
deno task cf inspect graph    z6Mkqa41 [--root of:fid1:… --depth 2] [--dot] [--limit 5000]

# time travel
deno task cf inspect diff     z6Mkqa41 of:fid1:… --from 7 --to 12
deno task cf inspect timeline z6Mkqa41 [of:fid1:…]          # how a space / one entity grew

# a self-contained HTML explorer (tree + graph + detail) to open in a browser
deno task cf inspect html     z6Mkqa41 --out /tmp/space.html [--app-url https://host] [--limit 5000]

# cross-space convergence (--all discovered, or --spaces a,b, or --dir)
deno task cf inspect converge      of:fid1:… --all --path value
deno task cf inspect converge-scan --all --json

# rehearsal clones — `cf space` WRITES, so it sits outside inspect's read-only
# contract, but clone.ts + fingerprint.ts live in this package. The operating
# procedure is docs/development/space-clone-rehearsal.md.
deno task cf space clone  <did> --from <snapshot|url> --to <dir>
deno task cf space verify <dir>                 # nonzero exit when content moved
deno task cf space reset  <dir>
deno task cf space fingerprint <space> [--per-entity] [--include-generated]
```

The `cf inspect value-at`, `diff`, and `converge` commands accept `--path-json`
when a path must preserve its segments exactly. The standalone `value-at` and
`converge` commands accept the same option. The value is a JSON array of
strings, such as `--path-json '["value","a/b",""]'`. Use this form for property
names that contain `/` or are empty strings. The shorter `--path value/count`
form splits on `/`. Path options cannot be combined with `--doc`, which selects
the whole document. Array segments use canonical decimal indexes such as `"0"`
and `"1"`; a segment such as `"01"` does not select an array element.

Diff results contain a slash-delimited `path` field and an exact `pathSegments`
JSON string array. Human output keeps the slash form for safe, ordinary paths.
It uses an ASCII-escaped JSON array for ambiguous or terminal-unsafe property
names. Value inspection JSON includes `pathExists`, which distinguishes a
missing property from a stored `undefined` value.

Diffs compare stored values rather than their display annotations. When two
different values have the same annotation, the change includes
`annotationCollision` and the stored value kind for each side.

### Remote (`--remote`) — inspect a staging/server without SSH

Any command takes `--remote [url]` (defaults to `CF_API_URL`). Instead of
reading on-disk DBs, it downloads a **read-only SQLite snapshot** from the
server's dump endpoint into a local cache (`~/.cache/cf-inspect/<host>/`), then
inspects it fully offline. Requests are signed with `--identity` / `CF_IDENTITY`
(CF1 first-party auth); the server gates access to an allowlist of DIDs.

```bash
export CF_IDENTITY=./me.key
deno task cf inspect spaces  --remote https://rapids.saga-castor.ts.net   # list dumpable spaces
deno task cf inspect summary z6Mkqa41 --remote https://rapids…            # fetch + inspect one
deno task cf inspect pull --all       --remote https://rapids…            # cache them all, then
deno task cf inspect group                                                #   inspect offline
```

The dump endpoint is **off by default** and is a **staging-only** debugging
tool: enable it per environment on the server (`MEMORY_DUMP_ENABLED=true`,
allowlist via `MEMORY_DUMP_DIDS` / `MEMORY_SERVICE_DIDS`); it **hard-refuses to
mount under `ENV=production`** with no override. The real boundary is the
tailnet perimeter + opt-in-off-by-default (staging is Tailscale-only); the prod
refusal is belt-and-suspenders. See `packages/toolshed/routes/storage/memory/`.

A standalone `cli.ts` entry exists for use outside the `cf` CLI (local only;
`--remote` requires the `cf` CLI for request signing).

## Known characteristics

- **The scheduler basis index is the only durable scheduler state** besides the
  watermark machinery (serving-loop.md §3b). The summary surface reports its
  presence and row count; a pre-migration snapshot without the table degrades
  gracefully — absence is a store from before the migration, not a broken DB.
- **Space-wide scans are capped** at `--limit` (5,000 by default) for cost, and
  every one of them says so: `entities`, `graph`, and `html` note a capped
  result on stderr in both human and `--json` mode, `graph --json` also carries
  an `extent`, and the HTML header marks the page. Silence means the result IS
  the whole set. `entities --kind` selects during the scan, so `--limit` counts
  the entities of that kind rather than the entities scanned to find them.
  `--require-complete` turns an incomplete result into a nonzero exit with
  nothing on stdout, for a caller whose output is a backup or a rollback payload
  and who cannot afford to miss a notice. A `--limit` that is not a whole number
  of entities is refused, since a cap no count can reach is a cap that never
  applies.
- **Not every gap is a cap.** A scan that enumerates an entity it cannot
  reconstruct reports it as `extent.unreadable` rather than folding it into
  `truncated`, because raising `--limit` does not recover one. `entities` never
  has any: it returns a row for an unreadable entity rather than dropping it.
- **A scan sees what a read sees.** Every space-wide scan enumerates through
  `visibleEntityRows`, and `listScopes` and `contentFingerprint` read through
  the same branch chain — a fingerprint hashes the values ITS branch reads, or
  it certifies a parent's content under a child's name. `visibleEntityRows`
  walks branch ancestry the way `reconstructDocument` does — a child branch
  lists the entities it inherited at the fork, not only the ones written on it —
  and drops entities whose visible head is a `delete`. `entities` is the
  exception that keeps tombstones, because it describes the space's records;
  that is why its `extent.total` can exceed `graph`'s over the same space.
- **The other caps are silent**: `history` / `hot` / `conflicts` row limits, and
  the HTML stale-read pass, which caps per bundle and marks un-analyzed cells
  rather than showing them clean. There a count at a round cap may be truncated
  — narrow with flags or a per-entity command.
- **Reads DBs it didn't write**: cross-space comparisons identify an unavailable
  view and return `unknown`. Per-entity diffs stop with the reconstruction error
  instead of reporting the value as absent.

## Not yet built

- `ifc` / security-label decoding from stored schemas (CFC labels are surfaced;
  full ifc decode is partial).
- Client-side correlation overlay (connectionId / eventId) for the per-session
  dimension of convergence.
- A shared read-only materializer in memory v2 so reconstruction calls the
  engine directly instead of a parity-tested replica.
