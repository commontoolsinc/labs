# State Inspector — Model Unification (the comprehension turn)

> Status: design doc / latest thinking. Written 2026-06-28 before starting the
> next phase. Grounded in code investigation (oracle + explore) and direct
> probing of a real modern space DB. Supersedes the guesswork-level entity model
> in the M1–M3 code.

## Why this doc

The state-inspector has shipped a usable autopsy + convergence + `cf inspect`
surface (PRs #4375 → #4376 → #4377 → #4386 → #4393). Dogfooding a real
freshly-created notes space exposed that our **entity model was guessed, not
known** — we classified by the shape of `doc.value` and showed raw JSON for
anything we didn't recognize.

The north star has also sharpened: this is a **comprehension tool to help the
whole team understand the Common Fabric stack** — what a space is, what pieces /
patterns / cells / streams are and how they relate, and how state got to where it
is — **not** a vanity-stats tool. To earn that, the tool must be *fluent* in the
real model. This doc writes down that model from ground truth, then sequences the
work to make the tool speak it.

## Part 1 — The reframe

Comprehension over stats. Every feature is judged by: *does it help a teammate
(or an agent) understand what they're looking at?* That reorders priorities — the
**unified entity/space model**, the **graph**, **time travel**, and a **visual
surface** are the spine; counts are supporting detail.

## Part 2 — The entity model (ground truth)

### 2.1 An entity's stored document is a TREE of top-level paths

Memory v2 stores one document (`is`) per entity id. The cell layer addresses
**paths inside that one document**. The reactive value lives at path `["value"]`;
the **control plane lives at sibling top-level meta paths** on the *same* entity
(`packages/runner/src/cell.ts:1833-1859`; `packages/api/index.ts:324-345`
`MetaField`).

Top-level paths an entity document can carry:

| Path | Meaning |
| --- | --- |
| `value` | the reactive value (a cell's contents) |
| `argument` | SigilLink → the piece's **input cell** |
| `result` | SigilLink → the **owning piece's result cell** (ownership back-link) |
| `pattern` | SigilLink → the pattern cell |
| `patternIdentity` | `{ identity, symbol }` — the **durable piece → pattern(module) pointer** |
| `internal` | manifest array `[{ partialCause, link }]` of owned child cells |
| `schema` | the result's JSONSchema |
| `cfc` | CFC (information-flow) label map + `schemaHash` |
| `slug` | piece slug metadata |

**The core bug in our current tool:** we only ever read `doc.value`. We are blind
to the entire control plane — ownership, input cells, and the piece→pattern link.
To be fluent we must read the **whole `is` document** and classify by *which
top-level paths exist*.

### 2.2 Entity kinds, by path-set (real counts from one modern space)

Probing the notes space (145 entities, all `scope_key='space'`, modern regime)
gives the actual distribution of top-level key-combinations:

| Count | Key combination | What it is |
| --- | --- | --- |
| 7 | `{argument, internal, patternIdentity, schema, value}` | **Piece** — a running pattern instance (result cell + full lineage) |
| 72 | `{result, value}` | **Owned cell** — a cell belonging to a piece, with a value |
| 19 | `{result}` | **Owned cell, value-less** — lineage/ownership node (our old "empty"!) |
| 38 | `{value}` | **Free cell** — a standalone cell owned by no piece |
| 9 | `{cfc, value}` | a cell carrying an information-flow label |

Layered on top, by the shape of `value`:
- `{ $stream: true }` → **stream** (write-only event channel; 20 of them)
- `{ code, filename, identity, imports, kind }` → **module** (pattern source; 18)
- `{ ifc, properties, type }` → **schema** stored as a cell value (`ifc` = CFC)
- `$UI` / `$NAME` / `$TILE_UI` / `$FS` present → a **piece's result** value

So: **cells and streams are the fundamental units. A piece is a result cell with
lineage meta (`argument`+`patternIdentity`+`internal`+`schema`). Cells/streams may
be owned by a piece (`result` back-link) or free-floating.**

### 2.3 Piece anatomy

A modern piece is rooted at its **result cell**:

```
            patternIdentity {identity, symbol}      →  module entity (source code)
           /
  PIECE  ─┼─ argument  → input cell
  (result │
   cell)  ├─ schema    → result JSONSchema
           ├─ internal  → [ owned child cells … ]   (each carries result → back here)
           └─ value     → { $UI, $NAME, …pattern outputs }
```

- **Input cell** = the `argument` link. **Result cell** = the entity itself (its
  `value`). **Pattern source** = follow `patternIdentity.identity` to the module
  entity, whose `code`/`filename` hold the TS source; `symbol` selects the export.
- Ownership tree: every owned cell's `result` link points back to its piece;
  `internal` is the piece's manifest of them.

### 2.4 Modules / patterns

Module entities (`packages/runner/src/compilation-cache/cell-cache.ts`):
- `kind: "source"` → `{ identity, code (TS), filename, imports:[{specifier,link}] }`
- `kind: "compiled"` → emitted JS + optional sourceMap
- `identity` = content hash of the module (`computeModuleHashes`, `cf:module/<hash>`),
  recomputed/verified on read. `imports[].link` → SigilLinks to dependency modules
  (transitive closure). One `.tsx` → many module entities; one module → many
  exports, hence `patternIdentity = {identity, symbol}`.
- There is **no separate "recipe" entity** — "recipe"/"spell"/"charm" are legacy
  names for pattern/pattern/piece.

### 2.5 Symbols, schemas, envelopes

- `$UI`/`$NAME`/`$TYPE`/`$FS`/`$TILE_UI`/`$CHIP_UI` are **plain string constants**
  (`builder/types.ts:82-90`), not serialized Symbols. `$stream` is a separate
  `StreamValue` marker.
- `ifc` = Information-Flow-Control labels; object cells shaped `{ifc,properties,type}`
  are **JSONSchemas stored as values**, not data.
- Two at-rest envelopes (our decoder already routes the first by the `fvj1:` tag):
  modern codec `{"/Link@1":…}` / `{"/Hash@1":…}` inside `fvj1:`; legacy plain-JSON
  `{"/":{"link@1":…}}`. Both decode to inert link data offline.

### 2.6 Two regimes — handle both

- **Modern (post-#3522 "Remove Process Cell"):** the layout above. Our notes space
  is modern (7 pieces all carry `patternIdentity`).
- **Legacy (pre-#3522):** a separate **process/source cell** whose `value` carries
  `{ $TYPE: <pattern-id string>, resultRef, argument?, spell?, source? }`; the
  result cell has a `source` → process cell. The `$TYPE: ba4jcbp…` we saw in older
  DBs is this legacy pattern-id (a module/pattern hash), **not** a schema hash.
- The tool must classify pieces in **both** regimes (`patternIdentity` OR
  legacy `$TYPE`/`resultRef`). `packages/shell/src/lib/debug-utils.ts:269-291`
  only recognizes the legacy keys today — we should do better.

## Part 3 — The multi-space model

A user's state is spread across **several spaces**, and "understand all implicated
spaces" means grouping them, not inspecting one DB in isolation.

### 3.1 Space kinds

| Space | DID derivation | Holds |
| --- | --- | --- |
| **Home** | = the user's identity DID | registry of the user: `profiles[]` (cross-space links), favorites, default profile, MRU, self-model, `site_table` |
| **Profile** (per profile) | anonymous `ProfileHome.inSpace()` (frame-cause derived; CT-1650 forbade name-derived) | a profile's name/avatar/bio/elements |
| **Main / pattern** | arbitrary (e.g. `createSession({spaceName})`) | shared pattern instance data |
| **PerUser scope** | NOT a separate DB — `scope_key = 'user:<userDID>'` rows **inside** a space DB | `PerUser<T>` cells |
| **PerSession scope** | NOT a separate DB — `scope_key = 'session:<userDID>:<sessionId>'` rows inside a space DB | `PerSession<T>` cells |

**Correction to an earlier assumption:** PerUser / PerSession are `scope_key`
**partitions within a space DB**, not separate files. The reactive readers
(`PerSpace`/`PerUser`/`PerSession`) read only their matching `scope_key` rows
(`packages/memory/v2/engine.ts:51-79,146-183`). The same cell id can have one row
per scope in the same DB.

So the 4 SQLite files from creating one space are **4 separate spaces** (the main
space + placeholder home/profile/session **spaces** pre-created and still empty),
**not** per-user/per-session partitions.

### 3.2 Recovering the implicated-space group from storage

On-disk signals (each verifiable offline):
1. **Home `profiles[]` cell** → cross-space links `{id, space, path}` to profile spaces.
2. **`commit.session_id`** = `session:did:key:<DID>:<uuid>` — the embedded `<DID>`
   is a related (session/partition) space; we already surface this.
3. **Cross-space links** anywhere: values whose link carries a `"space"` ≠ self.
4. **Home `site_table`** → `{did, host}` entries (host hints / known spaces).

### 3.3 Open questions (don't assert — verify before building)

- Exact `session_id` format and whether the embedded DID is always a real space
  file vs. a principal. (Flagged uncertain by the investigation.)
- The empty-DB lifecycle: precisely what pre-creates the placeholder space files
  and what first-write populates them.
- Profile → home is one-way in storage (no reverse index); recovering the home
  from a profile DB needs the home DB or an external hint.

## Part 4 — What "fluent" requires of the inspector

1. **Read the whole `is` document**, not just `doc.value`. Expose all top-level
   paths (value + meta).
2. **Classify by path-set** (piece / owned-cell / free-cell / stream / module /
   schema), in both modern and legacy regimes. Retire the `$NAME`-string heuristic
   that undercounts pieces.
3. **Resolve lineage**: piece → input (`argument`), piece → pattern
   (`patternIdentity` → module → `code`/`filename`), owned cell → owner (`result`),
   piece → manifest (`internal`).
4. **Render pattern source** for a piece (follow `patternIdentity` to the module).
5. **Group implicated spaces** across DBs (§3.2), so "a user's world" is one view.

## Part 5 — Roadmap (sequenced; comprehension-first)

1. **Model unification (foundation).** ✅ **DONE** — `model.ts`: whole-document
   read + path-set classification (piece / module / stream / schema / owned-cell
   / free-cell, modern + legacy regimes) + lineage resolution (`argument` →
   input, `patternIdentity` → module by `value.identity`, `result` → owner,
   `internal` → owned cells). `entities` rewired onto it (now finds all 7 pieces,
   not 4); new `cf inspect piece <id>` shows a piece's pattern source, input,
   result/schema keys, and owned cells. Verified end-to-end on the real notes
   space.
2. **Space grouping.** ✅ **DONE** — `grouping.ts` + `cf inspect group`.
   Discovers + groups local space DBs into per-user worlds (home → profiles →
   main) from §3.2 signals (home `profiles[]` cross-space links,
   `commit.session_id` principal, cross-space links). Placeholder (0-commit) and
   absent (referenced, no local DB) spaces marked. Compact by default,
   `--did <prefix>` expands one user. Signals verified against the real cache
   (137 user groups; clean home→profiles→main trees).
3. **`graph` command.** ✅ **DONE** — `graph.ts` + `cf inspect graph`. Entity
   graph from the unified model: nodes = pieces/modules/streams/schemas/cells
   (fluent labels); edges = `pattern` (patternIdentity→module) + `argument` +
   `owns` (internal manifest) + `link` (data links, cross-space marked).
   `--root/--depth` for a neighborhood, `--dot` for Graphviz. Verified on the
   notes space (147 nodes / 227 edges).
4. **Time travel.** ✅ **DONE** — `timetravel.ts` + `cf inspect diff` /
   `timeline`. `diffValues`/`diffEntity` (structural value diff across two seqs;
   from defaults to birth), `entityTimeline` (write-by-write), `spaceTimeline`
   (growth: per-commit created/touched + cumulative).
5. **Visual surface.** ✅ **DONE** — `html.ts` + `cf inspect html`. One
   self-contained HTML file (Overview / Pieces / Entities / Graph / Timeline)
   over the same JSON; per-piece graph neighborhood as inline SVG, growth
   sparkline, entity filter; dark-mode aware, no external resources. Verified in
   a real browser (Playwright).

Open cross-cutting items: handle legacy + modern regimes everywhere; decode the
modern `{"/Link@1":…}` envelope as carefully as the legacy sigil; keep every
command `--json` for agents.

## Appendix — evidence

Top-level doc key-combinations in the real modern notes space (145 entities):

```
 72  {result, value}                                         owned cells (valued)
 38  {value}                                                 free cells
 19  {result}                                                owned cells (value-less / lineage)
  9  {cfc, value}                                            labeled cells
  7  {argument, internal, patternIdentity, schema, value}    pieces
```

Key code references: `packages/api/index.ts:324-345` (MetaField), `packages/runner/src/cell.ts:1833-1859`
(meta paths), `packages/runner/src/runner.ts:~935-987` (argument/internal/patternIdentity/schema writes),
`packages/runner/src/compilation-cache/cell-cache.ts:286-557` (module docs),
`packages/runner/src/harness/module-identity.ts:117-182` (module identity hash),
`packages/memory/v2/engine.ts:51-79` (scope_key), `packages/runner/src/builder/types.ts:82-90` ($-symbol constants).
