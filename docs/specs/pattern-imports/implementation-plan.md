# Pattern Imports — Implementation Plan

Implements `docs/specs/pattern-imports/README.md`. **Read the spec first**;
this plan tells you *how*, the spec tells you *what and why*. When this plan
and the spec disagree, stop and ask — do not improvise.

## How to work this plan

- Work milestones strictly in order (M0 → M1 → M2). Within a milestone, tasks
  are ordered by dependency; do not reorder.
- Every task is red-green: write the listed tests first, watch them fail for
  the right reason, then implement. Run the package's test task
  (`deno task test` in the package dir) before moving on.
- Commit per task (small, coherent commits). Pre-commit hooks misbehave in
  worktrees for new files; verify locally, then `git commit --no-verify`.
- Use `deno task cf check <fixture>.tsx --show-transformed --no-run` when you
  need to see what the compiler actually emitted.
- **Do not modify any file not listed in a task without flagging it.** If you
  find yourself needing to, the plan missed something — say so in the commit
  message and keep the deviation minimal.
- M3/M4 are sketched for orientation only. Do not start them.

## Decisions already made — do not relitigate

These were settled in the spec + design review. Implement as stated:

1. **One grammar, no type tag**: `cf:<ref>`, `cf:/<space>/<ref>`,
   `cf://<host>/<space>/<ref>`, trailing `@<pin>`. Resolution chases pointers
   to an entry-module identity.
2. **Pin-in-source** (rewrite the import specifier at pin time). No lockfile
   side-table. No pin resolution at compile time for stored programs.
3. **Imported subtrees keep their published identities.** Mounted files hash
   with their original authored paths (per-subtree prefix strip), so
   identities, cache docs, and live modules dedupe with the already-deployed
   pattern. This is Strategy A; the "fresh identities per importer" variant
   (A′) was considered and rejected (no dedupe, divergent CFC provenance).
4. **Self-contained bundles**: imported modules ARE compiled and emitted as
   part of the importer's record graph (no lazy cross-bundle loading at
   evaluation time). Dedup happens via identity (cache hits, idempotent
   write-back, `modulesByIdentity`), not via emission-skipping.
5. **Source set stays per-program**: an importer's source docs do NOT link to
   the imported subtree's source docs (the `cf:` specifier itself carries the
   target identity; loaders parse it). The **compiled** set DOES link across
   the boundary (it has no Merkle-union verification, and the link gives the
   warm loader the full closure for free).
6. **No service endpoints.** All resolution and fetch are cell reads through
   the compiling runtime's storage session.
7. **v1 limitation**: an imported subtree whose modules use root-absolute
   internal imports (`import … from "/utils.ts"`) is rejected at fetch time
   with a clear error. Relative (`./`, `../`) imports only inside subtrees.
8. **CFC provenance of fetched source is follow-up work** (spec § Security).
   Do not build label propagation now; do not silently strip it either —
   the write-back path reuses existing write machinery so labels flow (or
   fail) exactly as any cell write does today.

## Architecture recap (what plugs in where)

```
authored source ──pretransformProgramForModules──► /<id>/-prefixed program
      │                                                  (engine.ts:227)
      ▼
engine.resolve(resolver)  ◄── FabricAwareResolver wraps EngineProgramResolver   [M1.4]
      │                        • intercepts cf: specifiers
      │                        • loadVerifiedSourceClosure(space, hash)  (cell-cache.ts)
      │                        • mounts files at /~cf/<hash>/<storedFilename>
      ▼
resolved program (authored ∪ mounted files)
      │
      ├─ computeFabricModuleIdentities: authored set stripped /<id>,            [M1.3]
      │  each subtree stripped /~cf/<hash> → PUBLISHED identities, merged map
      │
      ├─ compiler.compileToModules(..., { specifierAliases })                   [M1.1]
      │     TypeScriptHost maps "cf:…" → mounted entry path (type-check)
      │
      ├─ compileSourcesToRecords(..., { specifierAliases, identityByPath })     [M1.2]
      │     record resolutions: "cf:…" → "cf:module/<published-identity>"
      │
      └─ CacheableModule[]: mounted modules carry original filenames;           [M1.5]
         importer modules gain fabric edges {specifier, targetIdentity}
              │
              ├─ writeSourceDocs: fabric edges NOT stored as links              [M1.6]
              └─ writeCompiledDocs: fabric edges stored as links (warm walk)
```

Reload paths:
- **Warm** (compiled docs): `loadCompiledClosure` follows the fabric link →
  full closure → `evaluateCachedModules`. Verify this works; small fixes only.
  [M1.7]
- **Cold** (source docs): importer closure excludes subtrees by design; the
  same `FabricAwareResolver` wrapped around `compileResolvedToRecordGraph`'s
  resolver re-fetches each subtree by the hash in the specifier. [M1.7]

## Glossary (use these exact terms in code comments)

- **fabric ref / fabric specifier** — an authored import specifier under the
  `cf:` grammar (`cf:pattern:<hash>`, `cf:/kitchen/todo-list@<hash>`, …).
- **pin** — the trailing `@<hash>` entry-module identity on a mutable ref.
- **hash** — 43 base64url chars (`[A-Za-z0-9_-]`, case-SENSITIVE, no
  padding), the unprefixed output of `hashStringOf`/`hashOf`
  (`packages/data-model/src/value-hash.ts:553`). NOT hex — e.g.
  `Avcny13Rj8q-2ClANy_-k0ikWWQcXx7QTdsiqGfrC1c`. Never lowercase or
  otherwise normalize a hash.
- **terminal identity** — the entry-module identity a ref resolves to.
- **subtree** — the source closure of one imported pattern (its own program).
- **mount** — a subtree's files spliced into a compilation under
  `/~cf/<terminalIdentity>/<storedFilename>`.
- **fabric edge** — an import edge whose specifier is a fabric ref; external
  for Merkle identity, aliased for type-check and record resolution.
- **authored set** — the importer's own files (everything not under `/~cf/`).

---

## M0 — Grammar and policy (pure functions, no I/O)

### M0.1 New file: `packages/runner/src/sandbox/fabric-import-specifier.ts`

```ts
// Shown for illustration only.
export interface FabricRef {
  /** Toolshed host (authority); only present in the cf://host/... form. */
  host?: string;
  /** Space name or DID; absent = the compiling space. */
  space?: string;
  ref:
    | { kind: "slug"; slug: string }
    // "of" = entity URI (stored/spelled "of:fid1:<hash>"); "pattern" =
    // entry-module identity ("pattern:<hash>"). hash is the bare base64url
    // part (no "fid1:" tag) in both cases.
    | { kind: "uri"; scheme: "of" | "pattern"; hash: string };
  /** Path inside the target program (phase 4; parsed, rejected downstream). */
  subpath?: string;
  /** Trailing @<hash> pin (base64url — see glossary; never normalized). */
  pin?: string;
}

export class FabricRefError extends Error {
  constructor(message: string, readonly specifier: string) { /* … */ }
}

/**
 * Parse an import specifier under the cf: reference grammar.
 * - Returns undefined when the specifier does not start with "cf:" —
 *   callers treat it as not-a-fabric-ref (relative import, runtime module…).
 * - THROWS FabricRefError when it starts with "cf:" but is malformed or
 *   reserved. A cf:-prefixed specifier is never silently ignored.
 */
export function parseFabricRef(specifier: string): FabricRef | undefined;

/** True iff parseFabricRef returns a value (false for undefined OR throw). */
export function isFabricImportSpecifier(specifier: string): boolean;

/** Canonical string for a ref (parse(format(r)) deep-equals r). */
export function formatFabricRef(ref: FabricRef): string;

/**
 * The identity a ref resolves to WITHOUT touching any mutable pointer:
 * the pin if present, else the hash of a pattern: URI ref, else undefined
 * (meaning: resolution requires the chase — M2).
 */
export function pinnedIdentity(ref: FabricRef): string | undefined;

/** Re-format with a (new) pin set; used by the pin-rewrite tooling (M2.3). */
export function withPin(ref: FabricRef, pin: string): FabricRef;
```

Parsing algorithm — implement exactly this order:

1. If the specifier does not start with `"cf:"`, return `undefined`.
2. Strip `"cf:"`. Call the remainder `rest`.
3. **Reserved namespaces** (emitted/internal — never authored): if `rest`
   starts with `"module/"` or `"cache-root/"`, throw
   `FabricRefError("'cf:module/…' / 'cf:cache-root/…' are compiler-internal
   namespaces and cannot be imported", specifier)`.
4. **Pin**: if `rest` contains `"@"`, split at the LAST `"@"`. The right part
   must match `HASH_RE` (below) or throw (`"malformed pin"`). The left part
   replaces `rest`.
5. **Authority/space prefix**:
   - `rest` starts with `"//"`: strip it; split on `"/"`; first segment is
     `host` (must be non-empty, must contain no `"@"`; validate loosely:
     `/^[a-z0-9.-]+(:\d+)?$/i`, throw otherwise); the SECOND segment is the
     space (required in this form — throw `"host-qualified refs require a
     space"` if fewer than 3 segments); remaining segments per step 6.
   - `rest` starts with a single `"/"`: strip it; first segment is `space`;
     remaining segments per step 6.
   - otherwise: no host, no space; all of `rest` per step 6.
6. **Ref + subpath**: of the remaining `"/"`-separated segments, the FIRST is
   the ref token; the rest (joined by `"/"`) is `subpath` (omit when empty).
   - Ref token contains `":"` → URI form. Accepted shapes (hash part must
     match `HASH_RE`):
     - `pattern:<hash>` → `{ scheme: "pattern", hash }`
     - `of:fid1:<hash>` → `{ scheme: "of", hash }` (what `toURI` emits —
       `packages/runner/src/uri-utils.ts:12`; the `fid1:` tag is required
       inside `of:`)
     - `fid1:<hash>` → alias for `of:fid1:<hash>` (the shell's bare piece-id
       form); `formatFabricRef` canonicalizes to `of:fid1:<hash>`.
     Anything else with a colon throws `"unsupported cell URI scheme"`
     (including `of:<hash>` without the `fid1:` tag, and `data:`).
   - No colon → slug form: validate with `validateSlug` from
     `packages/runner/src/slugs.ts` (re-throw its message wrapped in
     FabricRefError).
7. **Space validation**: if present and not a DID (`/^did:[a-z0-9]+:.+$/`),
   it must validate as a slug (space *names* share the slug grammar — spec
   § Specifier syntax). Throw otherwise.
8. **Consistency**: a `pattern:` URI ref with a pin whose hash differs from
   the URI hash throws `"conflicting pin"`. (Equal is allowed, normalized to
   pin-absent by `formatFabricRef`.)

`HASH_RE`: **base64url, exactly 43 chars, case-sensitive**:
`/^[A-Za-z0-9_-]{43}$/`. This is the unprefixed `hashStringOf` output
(SHA-256 → 43 unpadded base64url chars; `value-hash.ts:553`) — NOT hex.
Add two canary unit tests pinning the real formats so a future hash-encoding
change fails here first:
1. feed a REAL module identity from `computeModuleHashes` (import it, hash a
   tiny one-file program) → `HASH_RE` matches, and
   `parseFabricRef("cf:pattern:" + h)` succeeds;
2. feed a REAL entity URI from `createRef(...)`+`toURI(...)`
   (`uri-utils.ts`) → it has the `of:fid1:` shape and
   `parseFabricRef("cf:/somespace/" + uri)` succeeds.
Never lowercase, trim, or re-encode hashes anywhere in parsing or
formatting — they compare byte-exact.

### M0.2 Policy: `packages/runner/src/sandbox/runtime-module-policy.ts`

Extend `isAllowedAuthoredImportSpecifier` (line 25):

```ts
// Shown at module scope.
export function isAllowedAuthoredImportSpecifier(specifier: string): boolean {
  if (specifier.startsWith("cf:")) {
    try { return parseFabricRef(specifier) !== undefined; }
    catch { return false; }
  }
  return isRuntimeModuleIdentifier(specifier) ||
    ALLOWED_LOCAL_IMPORT_PREFIXES.some((p) => specifier.startsWith(p));
}
```

`isAllowedCompiledDependencySpecifier` (line 32) composes the same predicate —
verify it needs no separate change (it delegates). Grep for every caller of
both functions and read each call site; list them in the commit message with
a one-line "unaffected because…" each. (Expected: the SES compiled-body
verifier and the authored-import check; if you find more, flag it.)

### M0.3 Tests: `packages/runner/test/fabric-import-specifier.test.ts`

Table-driven. Minimum cases (✓ = parses, ✗ = throws, ∅ = undefined):

| Specifier | Expect |
|---|---|
| `./foo.ts`, `commonfabric`, `npm:x` | ∅ |
| `cf:todo-list` | ✓ slug, no space |
| `cf:todo-list/schemas` | ✓ slug + subpath `schemas` |
| `cf:/kitchen/todo-list` | ✓ space `kitchen` |
| `cf:/kitchen/todo-list/a/b.ts` | ✓ subpath `a/b.ts` |
| `cf:/did:key:z6Mk…/todo-list` | ✓ DID space |
| `cf://host.example/kitchen/todo-list` | ✓ host + space |
| `cf://host.example:8000/kitchen/todo-list` | ✓ host with port |
| `cf://host.example/todo-list` | ✗ host requires space |
(`<b64u43>` below = a 43-char base64url hash, e.g.
`Avcny13Rj8q-2ClANy_-k0ikWWQcXx7QTdsiqGfrC1c` — note it exercises uppercase,
`-`, and `_`.)

| `cf:/kitchen/todo-list@<b64u43>` | ✓ pin |
| `cf:todo-list@abc` (too short) | ✗ malformed pin |
| `cf:todo-list@<b64u43 with "=" appended>` | ✗ malformed pin (no padding) |
| `cf:todo-list@<44 chars>` | ✗ malformed pin (length) |
| `cf:pattern:<b64u43>` | ✓ uri/pattern; `pinnedIdentity` = hash |
| `cf:pattern:<b64u43, hex-only chars>` | ✓ (hex-looking hashes are legal base64url) |
| `cf:pattern:<b64u43>@<same>` | ✓ normalizes (format drops pin) |
| `cf:pattern:<b64uA>@<b64uB>` | ✗ conflicting pin |
| `cf:pattern:<UPPERCASED b64u43>@<original>` | ✗ conflicting pin (case-sensitive — no normalization) |
| `cf:/kitchen/of:fid1:<b64u43>` | ✓ uri/of |
| `cf:of:fid1:<b64u43>` | ✓ uri/of, no space |
| `cf:fid1:<b64u43>` | ✓ uri/of alias; formats as `cf:of:fid1:<b64u43>` |
| `cf:of:<b64u43>` (no fid1 tag) | ✗ unsupported cell URI scheme |
| `cf:data:abc` | ✗ unsupported cell URI scheme |
| `cf:module/<b64u43>` | ✗ reserved |
| `cf:cache-root/x` | ✗ reserved |
| `cf:Has_Upper` | ✗ slug grammar |
| `cf:` / `cf:/` / `cf://` | ✗ |
| `cf:/kitchen/` (empty ref) | ✗ |

Round-trip: for every ✓ case, `parseFabricRef(formatFabricRef(parse(s)))`
deep-equals `parse(s)`. Policy tests: each ✓ case is allowed, each ✗/∅
`cf:`-prefixed case is rejected by `isAllowedAuthoredImportSpecifier`.

**Acceptance M0**: new tests green; full `packages/runner` suite green
(policy change must not break existing import tests).

---

## M1 — `cf:pattern:<hash>` end-to-end, same space

Scope guard: in M1 the resolver handles ONLY refs where
`pinnedIdentity(ref) !== undefined` and `ref.host === undefined`. Everything
else throws `"fabric ref requires resolution of a mutable pointer — not yet
supported (M2)"` or `"cross-host fabric refs not yet supported (M3)"`.
Subpaths throw `"subpaths not yet supported (M4)"`.

### M1.1 js-compiler: specifier aliases for type resolution

File: `packages/js-compiler/typescript/compiler.ts`.

1. Add to `TypeScriptCompilerOptions` (line 227):
   ```ts
   // Shown as interface or class members.
   /**
    * Maps an import specifier (verbatim text) to a program file name. Used
    * for scheme-prefixed specifiers (cf:…) that the path-join and
    * runtime-module rules cannot resolve. The target MUST be a file in the
    * program.
    */
   specifierAliases?: ReadonlyMap<string, string>;
   ```
2. Thread it into the `TypeScriptHost` constructor (line 123) and use it in
   `resolveModuleNameLiterals` (line 176) — check the alias map FIRST (before
   the relative-path branch; alias text is exact, so order is safe — but
   first keeps the dispatch obvious):
   ```ts
   // Shown for illustration only.
   const aliased = this.specifierAliases?.get(name);
   if (aliased !== undefined) {
     return {
       resolvedModule: {
         resolvedFileName: aliased,
         extension: aliased.endsWith(".tsx") ? ts.Extension.Tsx : ts.Extension.Ts,
       },
     };
   }
   ```
3. Also accept aliases in `resolveProgram`'s config? **No** — resolution of
   fabric specifiers happens in the runner's resolver wrapper (M1.4); the
   js-compiler's `resolveProgram` sees them resolve successfully via
   `graph.resolveSource` and never consults the unresolved-module policy.
   Do not touch `resolver.ts`.

Tests: `packages/js-compiler/test/` — find the existing compiler test file
and add: a two-file program where `/main.tsx` imports `"x-scheme:thing"` and
`specifierAliases` maps it to `/dep.tsx`; assert type-checking sees `/dep.tsx`
exports (a deliberate type error through the alias must be reported), and the
emitted body for `/main.tsx` contains `require("x-scheme:thing")` (the alias
affects type resolution, NOT emitted specifier text).

### M1.2 Record graph: alias resolutions

File: `packages/runner/src/sandbox/module-record-compiler.ts`.

1. Add `specifierAliases?: ReadonlyMap<string, string>` to
   `CompileSourcesOptions`.
2. In the per-source resolutions loop (the
   `internal → cf:module/… / runtimeModules → cf:runtime/… / unknown` chain),
   insert an alias branch BEFORE the unknown-external fallback:
   ```ts
   // Shown for illustration only.
   } else if (options.specifierAliases?.has(spec)) {
     const target = options.specifierAliases.get(spec)!;
     const targetSpecifier = specifierByPath.get(target);
     if (targetSpecifier === undefined) {
       throw new Error(`specifier alias '${spec}' → '${target}' does not name a program file`);
     }
     resolutions[spec] = targetSpecifier;
   }
   ```
3. Mirror the alias in the `export * from` walk (`resolveFullExports`): the
   star-target resolution uses `findInternalTarget`; add the same alias check
   so `export * from "cf:pattern:<h>"` re-exports correctly.

Tests: extend the existing module-record-compiler test file: program of
`/a.tsx` (imports `"cf:pattern:<b64u43>"`, any valid-shape hash) +
`/~cf/<h>/main.tsx`, alias map +
an `identityByPath` where the mounted file's identity is a fixed fake hash;
assert the record for `/a.tsx` has
`resolutions["cf:pattern:…"] === "cf:module/<fake>"`, and a star-re-export
variant surfaces the mounted file's export names.

### M1.3 Per-subtree identities: `computeFabricModuleIdentities`

File: `packages/runner/src/sandbox/module-record-compiler.ts` (next to
`computeModuleIdentities`).

```ts
// Shown for illustration only.
export const FABRIC_MOUNT_ROOT = "/~cf/";

export interface FabricMount {
  /** Terminal identity the subtree was fetched by (and must hash back to). */
  entryIdentity: string;
  /** Mounted path of the subtree's entry file. */
  entryPath: string;          // `${FABRIC_MOUNT_ROOT}${entryIdentity}${storedEntryFilename}`
  /** The fabric specifiers that resolve to this mount (≥1). */
  specifiers: string[];
}

/**
 * Identity map for a program containing fabric mounts. Authored files hash
 * with `idPrefix` stripped (status quo); each mount's files hash as their own
 * standalone program with `/~cf/<entryIdentity>` stripped, so they reproduce
 * their PUBLISHED identities. Throws if a mount's entry does not hash back to
 * `entryIdentity` (integrity failure — wrong bytes mounted).
 */
export function computeFabricModuleIdentities(
  sources: Source[],
  mounts: readonly FabricMount[],
  options: { idPrefix?: string; runtimeFingerprint?: string } = {},
): Map<string, string>;
```

Implementation:
1. Partition `sources` by name: each file under
   `${FABRIC_MOUNT_ROOT}${m.entryIdentity}/` belongs to mount `m`; everything
   else is the authored set. A file under `FABRIC_MOUNT_ROOT` matching NO
   mount → throw (corrupt assembly).
2. Authored set → `computeModuleIdentities(authored, options)` unchanged.
   (The fabric edges inside authored sources resolve as EXTERNAL deps because
   the mounted file names never match the specifier — this is what folds the
   pin into the importer's hash. Do not "fix" that.)
3. Each mount → `computeModuleIdentities(mountFiles,
   { idPrefix: `/~cf/${m.entryIdentity}`, runtimeFingerprint })`.
   **Note**: subtree files may themselves contain fabric specifiers
   (transitive imports) — those are external deps within the subtree
   computation, exactly as they were when the subtree was published. Files of
   a TRANSITIVE mount are NOT part of this mount's partition (they live under
   their own `/~cf/<h2>/` prefix).
4. Verify `result.get(m.entryPath) === m.entryIdentity`; throw with both
   values on mismatch.
5. Merge all maps (key sets are disjoint by construction) and return.

Tests (new file `packages/runner/test/fabric-module-identity.test.ts`):
- Two-file subtree published standalone (compute identities with no prefix),
  then the same files mounted under `/~cf/<entry>/…` inside a host program →
  identities identical to standalone; authored file's identity changes when
  (only) the pin hash inside its specifier text changes.
- Mount entry mismatch (tampered byte) → throws.
- File under `/~cf/` with no matching mount → throws.
- Two mounts whose subtrees both contain `/main.tsx` → no interference.

### M1.4 The resolver wrapper: `FabricAwareResolver`

New file: `packages/runner/src/harness/fabric-resolver.ts`.

```ts
// Shown for illustration only.
export interface FabricResolutionContext {
  runtime: Runtime;          // this.ctRuntime from the engine
  space: MemorySpace;        // the cell-cache space of this compile
}

export class FabricAwareResolver implements ProgramResolver {
  constructor(inner: ProgramResolver, ctx: FabricResolutionContext) {}
  main(): Promise<Source>;                       // delegate
  resolveSource(id: string): Promise<Source | undefined>;
  /** Mounts + alias map accumulated during the resolve walk. */
  mounts(): FabricMount[];
  specifierAliases(): Map<string, string>;
}
```

`resolveSource(identifier)` behavior, in order:

1. If `identifier` starts with `FABRIC_MOUNT_ROOT`: serve from the internal
   `mountedFiles: Map<path, Source>`; return `undefined` if absent (lets the
   normal missing-import error fire with the mounted path in it).
2. `parseFabricRef(identifier)`:
   - `undefined` → delegate to `inner.resolveSource`.
   - throws → re-throw (policy already rejects these; belt and suspenders).
3. Fabric ref:
   a. Scope checks (M1): `host` set → throw M3 message; `subpath` set → throw
      M4 message; `pinnedIdentity(ref)` undefined → throw M2 message.
      `ref.space` set and ≠ compiling space → M1: throw
      `"cross-space fabric refs not yet supported (M2)"`.
   b. Dedupe: if a mount for this identity exists, register the specifier on
      it and return the SAME entry Source object already returned before
      (identity-keyed `mountByIdentity` map).
   c. Depth guard: more than 32 distinct mounts in one compile → throw
      `"fabric import graph too deep/large"` (runaway-recursion backstop —
      transitive mounts arrive through this same method as the walk reaches
      mounted files' own fabric specifiers).
   d. Fetch: open a read tx exactly like `replicateClosures` does
      (`packages/runner/src/pattern-manager.ts:620` — `runtime.edit()` /
      `finally tx.abort?.(…)`), call `loadVerifiedSourceClosure(runtime,
      ctx.space, hash, tx)`. `undefined` → throw
      `"source for pattern:<hash> not found in space <space> (or failed
      integrity verification)"`.
   e. **Root-absolute import check** (decision 7): for every doc, run
      `collectImportSpecifiers` (from `@commonfabric/js-compiler`); any
      specifier starting with `"/"` → throw `"imported pattern <hash> uses
      root-absolute imports; not supported"`. (Relative and fabric and
      runtime-module specifiers pass.)
   f. Mount: for each doc, `mountedFiles.set("/~cf/" + hash + doc.filename,
      { name: …, contents: doc.code })`. Entry path =
      `/~cf/<hash><entryFilename>` where `entryFilename` comes from
      `verifySourceDocs`'s `entryFilename` (already returned inside
      `loadVerifiedSourceClosure` — if not surfaced, extend
      `loadVerifiedSourceClosure` to return `{ docs, entryFilename }`; check
      its callers: `replicateClosures` and the pattern-manager cold path —
      adjust both destructurings).
   g. Record `FabricMount` + alias (`identifier → entryPath`); return the
      entry Source.

Pitfalls to encode as comments + tests:
- The walk calls `resolveSource` with the verbatim specifier text (bare
  specifiers pass through `resolveSpecifier` unchanged —
  `packages/js-compiler/typescript/resolver.ts:97`). Two files importing the
  same text → `sources.has(identifier)` dedupes upstream; two DIFFERENT
  texts pinning the same hash (e.g. `cf:pattern:<h>` and a pinned slug form
  in M2) → step (b) returns the same Source object, and `resolveProgram`
  stores it under BOTH identifiers → **duplicate entries in
  `program.files`**. Therefore M1.5 must dedupe `moduleFiles` by name (see
  there). Write the test now (two import lines, same hash) and let it go
  green in M1.5.
- Authored programs must not collide with the mount root: in
  `compileToRecordGraph` authored names carry the `/<id>/` prefix so they
  can't start with `/~cf/`; in `compileResolvedToRecordGraph` they are
  unprefixed stored names — add an explicit guard in M1.5: any AUTHORED
  input file (pre-resolve) named under `/~cf/` → throw.

Unit tests (`packages/runner/test/fabric-resolver.test.ts`): use an
in-process runtime (mirror the setup of existing cell-cache tests — find
`cell-cache` or `compile-cache` test files and copy their runtime/space
bootstrap). Seed source docs by running `writeSourceDocs` with a small
hand-built module set. Cover: fetch+mount happy path; missing hash; tampered
doc (flip a byte in a stored cell → verification failure surfaces as
not-found error); root-absolute rejection; dedupe-by-identity; M2/M3/M4
scope errors.

### M1.5 Engine integration

File: `packages/runner/src/harness/engine.ts`.

1. Add to `TypeScriptHarnessProcessOptions`
   (`packages/runner/src/harness/types.ts:21`):
   ```ts
   // Shown as interface or class members.
   /**
    * Enables fabric (cf:) imports for this compile: the space whose cell
    * cache fabric refs are fetched from / verified against. Absent → any
    * fabric specifier in the program is a compile error ("fabric imports
    * require a space context").
    */
   fabricImports?: { space: MemorySpace };
   ```
2. `compileToRecordGraph` (engine.ts:212):
   - Wrap the resolver (line 228):
     ```ts
     // Shown for illustration only.
     const engineResolver = new EngineProgramResolver(mappedProgram, this.ctRuntime.staticCache);
     const resolver = options.fabricImports
       ? new FabricAwareResolver(engineResolver, { runtime: this.ctRuntime, space: options.fabricImports.space })
       : engineResolver;
     ```
     When `fabricImports` is absent, fabric specifiers reach
     `isUnresolvedModuleOk` and throw `Could not resolve…` — wrap that into
     the friendlier error: BEFORE resolving, scan `mappedProgram` files with
     `collectImportSpecifiers` for `cf:`-parsing specifiers and throw
     `"fabric imports require a space context (options.fabricImports)"` if
     found without the option. (Cheap, explicit, testable.)
   - After `this.resolve(resolver)`: collect
     `const mounts = options.fabricImports ? resolver.mounts() : []` and
     `const aliases = …specifierAliases()`.
   - **Dedupe `moduleFiles` by `name`** after the `.d.ts` filter, asserting
     equal contents on duplicates (see M1.4 pitfall):
     ```ts
     // Shown for illustration only.
     const byName = new Map<string, Source>();
     for (const f of moduleFiles) {
       const prev = byName.get(f.name);
       if (prev !== undefined && prev.contents !== f.contents) throw new Error(…);
       byName.set(f.name, f);
     }
     const uniqueModuleFiles = [...byName.values()];
     ```
   - Guard: any file of the ORIGINAL `program.files` (pre-pretransform input)
     named under `/~cf/` → throw `"/~cf/ is a reserved namespace"`.
   - Identity computation (line 242): replace `computeModuleIdentities(…)`
     with `computeFabricModuleIdentities(uniqueModuleFiles, mounts,
     { idPrefix: \`/${id}\` })`. (With zero mounts it must behave byte-for-byte
     like today — M1.3 guarantees it; add a regression assertion to an
     existing engine test rather than trusting it.)
   - Pass `specifierAliases: aliases` into BOTH `compiler.compileToModules`
     (line 282) and `compileSourcesToRecords` (line 324).
   - Fabric edges into write-back descriptors (line 407): `importEdges` comes
     from `resolveModuleImports` whose `externalDeps` include fabric
     specifiers. Extend the `modules` mapping:
     ```ts
     // Shown for illustration only.
     const fabricEdges = (importEdges.get(file.name)?.externalDeps ?? [])
       .filter((s) => isFabricImportSpecifier(s))
       .map((s) => {
         const target = aliases.get(s);
         if (target === undefined) throw new Error(`unresolved fabric specifier '${s}' survived compile`);
         return { specifier: s, targetIdentity: identityByPath.get(target)! };
       });
     // imports: [...internalDeps-mapped, ...fabricEdges]
     ```
   - `filename` for mounted files (line 422): `stripModuleIdPrefix(file.name,
     id)` only strips `/<id>`; mounted names need the mount prefix stripped
     instead. Write a small helper
     `storedFilenameFor(name, id, mounts)` → authored: status quo; mounted:
     `name.slice(("/~cf/" + m.entryIdentity).length)`.
3. `compileResolvedToRecordGraph` (engine.ts:454): same wrapper + same merged
   identity computation + same aliases into `compileToModules` + same fabric
   edges, with `idPrefix` ABSENT for the authored set (stored names are
   prefix-free) and `space` from a new optional parameter
   `options?: { fabricImports?: { space: MemorySpace } }`. The caller
   (pattern-manager, M1.7) threads the space it already has. NOTE: this path
   builds no record graph itself — it returns `CacheableModule[]`; the
   emitted set now contains mounted modules too, which is exactly what the
   cached-module evaluator needs (self-contained closure).

Tests (`packages/runner/test/fabric-imports-engine.test.ts`, in-process
runtime):
- Seed: compile + write-back a small two-file pattern P (existing engine
  compile helpers; mirror how `esm-*`/cell-cache tests drive
  `compileToRecordGraph` + `writeSourceDocs`/`writeCompiledDocs`). Record its
  `entryIdentity`.
- Importer I with `import { x } from "cf:pattern:<P-entry>"`:
  - compiles; record graph contains a record keyed
    `cf:module/<P-entry>`; I's record resolutions map the specifier to it.
  - `modules` write-back set: P's modules appear with their ORIGINAL
    filenames + identities; I's entry carries the fabric edge.
  - Evaluation: I's exports work; P's pattern callable through I.
  - Type error variant: I uses a wrong member name → compile fails with a TS
    diagnostic naming the member (proves real type-checking through the
    alias).
  - Identity sensitivity: byte-change P → republish under new hash; I pinned
    to OLD hash still compiles to the OLD identity (reads old docs); I with
    the NEW hash has a different module identity than the old I.
  - No `fabricImports` option → the friendly "requires a space context"
    error.
  - Same hash imported via two specifier texts → compiles (dedupe), one
    record.
  - Transitive: P itself imports `cf:pattern:<Q>` → I→P→Q compiles and
    evaluates; Q mounted once.
  - `--show-transformed` path (`getTransformedProgram`) includes mounted
    files (smoke assertion: a mounted filename appears).

### M1.6 Cache write-back: source-side link filtering

File: `packages/runner/src/compilation-cache/cell-cache.ts`.

1. `storedImportRefs` (line 119): skip fabric edges when building SOURCE
   links:
   ```ts
   // Shown for illustration only.
   const refs = module.imports
     .filter((imp) => !isFabricImportSpecifier(imp.specifier))
     .map(…);
   ```
   `unreachedRoots` (line 96) stays UNTOUCHED — it must keep seeing fabric
   edges as reachability (otherwise every mounted module gets a synthetic
   root link from the importer's entry, dragging subtrees back into the
   importer's source closure — the exact thing decision 5 forbids).
2. **Compiled side**: find `writeCompiledDocs` / the compiled-doc builder in
   this file (below the source-set section). Confirm which import list it
   stores. Required end state: compiled docs DO carry fabric edges as links
   (`{specifier: "cf:pattern:…", link → compiledDocKey(rtv, <identity>)}`).
   If it shares `storedImportRefs`, give that function an
   `{ includeFabricEdges: boolean }` parameter rather than duplicating it.
3. `verifySourceDocs` needs NO change (importer closures no longer contain
   subtree docs). Add a regression test proving it: write back an importer's
   modules, `loadVerifiedSourceClosure(importerEntry)` → returns ONLY the
   importer's own docs, verification ok, and the importer doc's stored
   imports contain no fabric specifier.

Tests (extend the existing cell-cache test file): the regression above; plus
compiled-closure walk: `loadCompiledClosure(importerEntry)` returns importer
AND subtree compiled docs (fabric link followed); plus `replicateClosures`
of an importer — **expected to fail or lose the subtree** (source closure
excludes it). Fix inside `replicateClosures`: after replicating the
importer's closure, parse each replicated source doc's external specifiers
(`collectImportSpecifiers` + `isFabricImportSpecifier` + `pinnedIdentity`)
and recurse per subtree identity (visited-set on identities). Test: replicate
importer to a second space → importer loads cold in that space.

### M1.7 Reload paths (warm + cold)

File: `packages/runner/src/pattern-manager.ts`.

1. Locate the by-identity load (`loadPatternByIdentity`, ~line 985) and read
   it END TO END before changing anything. Identify:
   - the warm branch (`loadCompiledClosure` → `evaluateCachedModules`-style
     evaluation), and
   - the cold branch (`loadVerifiedSourceClosure` →
     `compileResolvedToRecordGraph`).
2. **Warm**: with M1.6 the compiled closure includes subtree docs. Follow the
   code from closure → records and verify the record builder maps the fabric
   edge's specifier to `cf:module/<identity>` using the STORED import edges
   (the same mechanism internal edges use). If it re-derives resolutions from
   specifier text + `findInternalTarget` instead, extend it with a branch:
   "specifier parses as fabric ref → resolution = `cf:module/<stored edge
   identity>`". Add a test before touching code: deploy importer (M1.5 test
   helper), drop the in-memory pattern cache (new runtime instance on the
   same storage — mirror how resume tests do this; see
   `resume-by-identity`-named tests), `loadPatternByIdentity(importerEntry)`
   → warm load works.
3. **Cold**: force the cold path (bump
   `COMPILE_CACHE_RUNTIME_VERSION` in the test via its option/parameter if
   injectable, or write source docs only) → `compileResolvedToRecordGraph`
   must receive `{ fabricImports: { space } }` from this call site. The
   FabricAwareResolver inside it refetches subtrees (they exist in the same
   space). Test: cold load of the importer works, and the recompiled module
   identities EQUAL the originals (assert on returned `entryIdentity` and a
   spot-check module).
4. Eviction/`addressableByIdentity`: no changes — but add one test: after
   importer evaluation, `artifactFromIdentitySync(<P-entry>, <symbol>)`
   resolves (proves imported modules registered under their published
   identities → op-by-identity / `$patternRef` referencing imported patterns
   works).

### M1.8 CLI surfacing

Files: `packages/cli/lib/dev.ts`, `packages/cli/commands/dev.ts`.

- `cf check`/`cf dev` compile via `engine.compileToRecordGraph` (dev.ts:52).
  Thread `fabricImports: { space }` only when the dev session has a space
  (inspect how `dev.ts` builds the runtime and whether a space/identity is
  configured; if none, leave the option absent — the M1.5 friendly error then
  tells the user why). Add `--space <did>` plumbing ONLY if it already exists
  in the command's option surface; otherwise leave a TODO comment referencing
  M2 (do not invent new CLI flags in M1).
- Acceptance: a fixture pattern with a fabric import produces the
  "requires a space context" error through `cf check` (snapshot the message),
  not a raw `Could not resolve` error.

**Acceptance M1** (run all): new test files green; full
`packages/runner`, `packages/js-compiler`, `packages/cli` suites green;
the M1.5 end-to-end test demonstrates: compile, type-check, evaluate,
write-back, warm reload, cold reload, cross-runtime resume, tamper rejection.

---

## M2 — Mutable refs (slug / piece / of:) + pinning

### M2.1 Generic slug→cell resolution in runner

`packages/piece/src/slugs.ts:108` (`resolveSlugTargetCell`) is the model; it
uses only `runtime` + `space`. Lift it:

- New: `packages/runner/src/slug-resolution.ts` —
  `resolveSlugTargetCell(runtime: Runtime, space: MemorySpace, slug: string):
  Promise<Cell<unknown>>` — copy the body, replacing `manager.runtime`/
  `manager.getSpace()`; move `SlugResolutionError` here and re-export from
  the piece package for compatibility.
- `packages/piece/src/slugs.ts` delegates to it (keep its piece-specific
  `resolvePieceAddress` checks where they are).
- Tests: move/duplicate the existing piece slug-resolution tests' generic
  cases to a runner test; piece suite must stay green untouched otherwise.

### M2.2 The chase: ref → terminal identity

New: `packages/runner/src/fabric-ref-resolution.ts`.

```ts
// Shown for illustration only.
export interface FabricChaseResult {
  entryIdentity: string;
  /** Human-readable hops for errors/tooling, e.g.
   *  ["slug:todo-list", "piece:of:…", "patternMeta:of:…", "entryIdentity:…"] */
  chain: string[];
}

export async function resolveFabricRefToIdentity(
  runtime: Runtime,
  compilingSpace: MemorySpace,
  ref: FabricRef,
): Promise<FabricChaseResult>;
```

Algorithm (spec § Resolution rule — implement hops exactly):

1. Space: `ref.space` undefined → `compilingSpace`; a DID → use as-is; a name
   → M2 throws `"space names require name→DID resolution (open question 2);
   use a DID"` (names are NOT in M2 scope — spec open question).
2. Start cell:
   - slug → M2.1 resolver (wrap `SlugResolutionError` with the chain so far).
   - `of:` URI → reconstruct the entity id from the parsed hash via the
     `uri-utils.ts` helpers (`fromURI("of:fid1:" + hash)` / the `{"/": id}`
     shape — mirror an existing `getCellFromEntityId` call site rather than
     hand-building the string), then `sync()`.
   - `pattern:` → already terminal (return immediately; callers normally
     short-circuit via `pinnedIdentity` and never get here).
3. Piece hop: if the cell has pattern metadata — use the SAME accessors the
   runner uses (`getPatternIdentityRef` / `getPatternId` around
   `packages/runner/src/runner.ts:4137`; export them if module-private):
   - `patternIdentity` present → its `.identity` IS the terminal identity;
     append hops; done.
   - else `patternId` present → load the pattern meta cell by that URI
     (mirror how `PatternManager` reads meta cells — `patternMetaSchema`),
     continue at 4.
   - neither, and the cell itself is not a pattern meta cell → throw
     `"cf:… does not resolve to a pattern (chain: …)"`.
4. Pattern-meta hop: `entryIdentity` field present → done. Absent → throw
   `"pattern meta for cf:… has no entryIdentity (legacy pattern; re-deploy
   it)"`. (Computing it from `program` requires a full pretransform+hash
   pass — deliberately out of scope; the error names the remedy.)

No cycle guard needed (≤3 hops, no recursion).

Tests (`packages/runner/test/fabric-ref-resolution.test.ts`): build, in an
in-process runtime: a pattern meta cell with `entryIdentity`; a fake piece
cell carrying `meta("pattern")`/`meta("patternIdentity")` (use the real
setters from runner.ts — find `setMetaRaw("pattern", …)` usage at
runner.ts:901 and mirror it); slug → piece; slug → pattern meta directly;
slug → plain data cell (error + chain); missing slug; `of:` directly to meta
cell; piece with only legacy `patternId`; meta without `entryIdentity`
(error message).

### M2.3 Pin rewriting (byte-precise source surgery)

New: `packages/runner/src/fabric-pin-rewrite.ts`.

```ts
// Shown for illustration only.
export interface PinRewrite { specifier: string; pinned: string; line: number }

/**
 * Rewrite fabric import/export/import-type specifiers in ONE source text.
 * `resolvePin(ref)` returns the identity to pin (or null = leave untouched).
 * Returns the new text + the rewrites performed. MUST only change the
 * string-literal spans — byte-identical elsewhere (no reprinting).
 */
export async function rewriteFabricPins(
  contents: string,
  resolvePin: (ref: FabricRef, specifier: string) => Promise<string | null>,
): Promise<{ contents: string; rewrites: PinRewrite[] }>;
```

Implementation: `ts.createSourceFile`, walk EXACTLY the three node shapes
`collectImportSpecifiers` walks (import decl / export-from / ImportTypeNode —
copy that visitor, `packages/js-compiler/typescript/resolver.ts:127`),
collect `{ literal.getStart()+1, literal.end-1, text }` spans, compute
replacements with `formatFabricRef(withPin(ref, pin))`, apply BACK TO FRONT
on the original string. Skip non-fabric specifiers; skip refs where
`pinnedIdentity` already matches; error on a fabric ref inside a dynamic
`import()` expression? — dynamic imports are unsupported by the compiler
(resolver.ts comment) so they cannot occur in valid programs; ignore.

Tests: fixtures with weird-but-valid formatting (multiline imports, comments
between clause and specifier, `export * from`, `import type`, single vs
double quotes — PRESERVE the original quote character: detect from the
literal's raw text). Assert byte-identity outside the replaced spans
(compare prefix/suffix slices, not just "compiles").

### M2.4 Engine: unpinned refs in dev mode

- `TypeScriptHarnessProcessOptions.fabricImports` gains
  `allowUnpinned?: boolean` and the engine threads it into
  `FabricAwareResolver`.
- Resolver step (a) update: ref with no `pinnedIdentity` →
  - `allowUnpinned` false/absent → throw `"unpinned fabric import 'cf:…';
    pin it (cf deps update) or deploy to pin"`.
  - true → run M2.2's chase, then proceed exactly as a pinned ref with the
    chased identity; record `{ specifier, resolvedIdentity, chain }` in a new
    `resolvedPins()` accessor.
  - cross-space (`ref.space` a DID ≠ compiling space): fetch via
    `loadVerifiedSourceClosure(runtime, refSpace, …)` — the storage session
    routes; CFC caveat is documented follow-up (decision 8). The write-back
    then copies the docs into the compiling space (this is `replicateClosures`
    semantics through the normal compile path — no extra code, but ADD a test
    asserting it happens, and a `logger.info` naming source space → dest
    space for the provenance audit trail).
- Engine surfaces `resolvedPins` in `compileToRecordGraph`'s return value
  (additive field).

Tests: unpinned + allowUnpinned=false → error; =true → compiles and
`resolvedPins` carries the chain; pinned ref never touches the slug (delete
the slug cell after pinning, recompile → still works).

### M2.5 CLI: pin-on-deploy + `cf deps update`

Read `packages/cli/` command structure first (mirror an existing command's
file layout, e.g. how `dev.ts` registers).

- **Deploy pinning**: find the deploy path (`cf` skill docs:
  `pattern-deploy`; the CLI command that writes a pattern's program to the
  pattern meta). Before writing the program: run `rewriteFabricPins` over
  every file, with `resolvePin` = M2.2 chase via the connected runtime; if
  any rewrite happened, print each (`pinned cf:/kitchen/todo-list →
  @AvcnyZ…`). The STORED program is the pinned one. Deploying with an
  unresolvable ref fails the deploy with the chase's error.
- **`cf deps update [file] [--import <specifier>]`**: new command; operates
  on the local working files (filesystem), not deployed state: parse, chase
  every mutable fabric ref (or just `--import`), rewrite pins in place,
  print a per-file diff summary. `--check` flag: exit non-zero if any pin
  would change (CI freshness gate).
- **`cf dev`/`cf check`**: pass `allowUnpinned: true` + print
  `resolvedPins` ("resolved cf:… → <hash> (not pinned — deploy or run cf
  deps update)").

Tests: CLI-level tests follow whatever harness existing cli tests use (look
in `packages/cli` for test conventions; if commands are thin over lib
functions, test the lib functions and add one smoke test per command).

### M2.6 End-to-end snapshot-semantics test (the spec's core scenario)

One integration test (runner-level, in-process, two "deploys"):

1. Deploy pattern P v1; create piece from it; assign slug `dep`.
2. Author importer I with `cf:dep` (unpinned); simulate deploy: pin → assert
   source now contains `cf:dep@<v1-entry>`; deploy I; run it.
3. Update the piece to P v2 (new pattern meta + `patternIdentity`).
4. Recompile/reload I from its stored program: byte-identical behavior,
   SAME module identities as step 2 (assert hash equality), v1 code still
   runs.
5. Re-pin (M2.3 with the chase): only the import line differs; new identity;
   v2 code runs.
6. Re-point the slug at an unrelated data cell: pinned I still loads (pin
   never re-reads the slug); a fresh unpinned resolve now fails with the
   "does not resolve to a pattern" chain error.

**Acceptance M2**: all the above green; full repo test suite green
(`deno task test` at root, or at minimum runner + js-compiler + piece + cli).

---

## M3 / M4 — sketches only (do NOT implement)

- **M3 cross-host + publish**: `cf publish` (write source docs + meta + slug
  to a target space), host-qualified refs (needs dynamic space→host routes —
  spec open question 8; `spaceHostMap` is interim), CFC label propagation for
  fetched source (spec § Security), possible public-pattern HTTP endpoint
  (spec open question 7 — left open).
- **M4 subpaths + npm vendoring**: subpath = alias to a non-entry mounted
  file (grammar already parses it); `npm:` = fetch via esm.sh → vendor as a
  content-addressed source set → same rails.

## Invariants checklist (the reviewer will check every one)

1. A compile with zero fabric imports is byte-for-byte unchanged (identities,
   records, cache docs, behavior). Guard: run the existing engine + cache
   test suites untouched; they must pass without edits (any needed edit =
   design smell, stop and flag).
2. A mounted module's computed identity ALWAYS equals the identity it was
   fetched by (M1.3 throws otherwise) — never trust, always recompute.
3. The importer's module identity changes iff its own bytes change — and the
   pin is part of its bytes. No identity input lives outside `program.files`.
4. Source closures never span programs; compiled closures may (links).
5. Fabric specifiers never appear in: emitted record KEYS (only
   `cf:module/<hash>`), source-doc links, slug cells. They appear verbatim
   in: authored source, record `resolutions` keys, compiled require() calls,
   CacheableModule/compiled-doc import edges.
6. Every error message names the failing specifier and (where applicable) the
   chain of hops — copy the exact strings from this plan.
7. No new HTTP surface, no new authz checks — reads go through normal cell
   reads and fail with normal authz errors.
8. `/~cf/` is reserved: authored files under it are rejected everywhere.

## Risk register (check early, in this order)

| Risk | Check | Fallback |
|---|---|---|
| Injected helper module (`transformInjectHelperModule` → `transformCfDirective`) references a path that breaks under mount prefixing | FIRST test in M1.4: mount a closure produced by a real `compileToRecordGraph` write-back (which contains whatever the helper injects), not a hand-built one | If the helper import is non-relative and path-ambiguous: serve it from the wrapper by suffix-matching within the requesting subtree — but ESCALATE first; this needs a design look |
| `loadCompiledClosure` verifies link/edge consistency in a way fabric links violate | M1.6 compiled-walk test before any M1.7 work | Teach its check the fabric branch (same shape as verifySourceDocs partition — but escalate; the compiled set's integrity model is CFC labels, changes there are security-sensitive |
| `evaluateCachedModules` record building can't map fabric edges | M1.7 step 2 test-first | Small resolution branch keyed on `isFabricImportSpecifier` |
| Engine cache-hit (`fullHit`) misbehaves with mounted identities | M1.5 test: SECOND compile of the importer is a full hit (no TS compile — assert via the `compile-cache-hit` log or `esmCacheStats`) | — |
| TS extension inference for mounted entry (`.tsx` vs `.ts`) | M1.1 alias test uses a `.tsx` target | use stored filename's real extension (already in plan) |
| `validateSource` / emit-stem ambiguity with mounted names | M1.5 e2e covers; stems differ by mount dir | — |

## What NOT to do

- Do NOT modify `computeModuleHashes` / `module-identity.ts`. All fabric
  awareness lives a layer above (M1.3 partitions, then calls it).
- Do NOT rewrite specifier text in stored/authored source anywhere except
  the explicit pin-rewrite tool (M2.3) invoked by deploy/`deps update`.
- Do NOT add fabric links to SOURCE docs or "fix" `verifySourceDocs` to
  union across programs.
- Do NOT re-pretransform mounted sources (they are stored post-pretransform;
  they enter via the resolver, which naturally skips pretransform).
- Do NOT thread a space through globals/singletons — it rides options.
- Do NOT touch CFC label code paths in this work (decision 8); if a test
  fails on labels, stop and escalate rather than loosening a check.
- Do NOT introduce new CLI flags beyond `cf deps update`'s listed ones.
