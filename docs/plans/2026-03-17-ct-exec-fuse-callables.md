# `ct exec` + FUSE Callable Files Implementation Plan

> **For agentic workers:** REQUIRED: Use @trycycle-executing to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `ct exec` for mounted callable files, expose pattern tools as `.tool`, make callable files readable with a `#!... exec` first line, and drive help/flag parsing from the resolved callable schema.

**Architecture:** Treat mounted handlers and pattern tools as one FUSE concept: callable files discovered from `childCell.asSchemaFromLinks()`, surfaced as `.handler` or `.tool`, and rendered as readable synthetic files whose first line is a stable `ct` shebang. Persist enough mount metadata for `ct exec` to map an absolute mounted file path back to the owning space, piece, and child cell without talking to the FUSE daemon. Keep execution logic local to the CLI: parse flags from the callable schema, resolve the backing cell, dispatch handlers through existing piece writes, dispatch pattern tools through a minimal runtime-run path, and prove the shipped behavior with a real mounted-filesystem integration script.

**Tech Stack:** Deno 2, Cliffy, `@commontools/piece`, `@commontools/runner`, FUSE low-level bindings, existing CLI integration shell harnesses.

---

## Scope And Invariants

### User-visible behavior

1. Mounted `*.handler` files remain writable and start being readable.
2. Mounted pattern-tool values are surfaced as `*.tool` siblings instead of expanded `pattern/extraParams` directories.
3. Reading either callable file returns text whose first line is `#!<stable-ct-shim> exec`.
4. `ct exec <mounted-callable-file> [invoke|run] [flags]` works for mounted `*.handler` and `*.tool` paths.
5. The verb defaults by callable kind when omitted:
   - handler defaults to `invoke`
   - tool defaults to `run`
6. `ct exec <file> --help` always prints top-level help for that callable.
7. After the verb, schema flags own the namespace. If the input schema has a `help` field, `ct exec <file> run --help` is parsed as that field, not intercepted as CLI help.
8. Tool input flags come from the underlying pattern `argumentSchema`, minus injected `result`, minus already-bound `extraParams`.
9. Tool help shows a best-effort output schema summary, but output-schema heuristics are display-only and must not block execution.
10. Non-mounted paths, stale mounts, non-callable files, and invalid flag/value combinations fail with clear CLI errors instead of stack traces.

### Explicit non-goals for this change

1. Do not make direct `./file.handler` or `./file.tool` execution a release criterion.
2. Do not refactor `packages/runner/src/builtins/llm-dialog.ts` as part of this feature.
3. Do not invent a deep nested flag DSL. Top-level object properties plus a raw JSON escape hatch are enough.

### Important contracts

1. Always call `childCell.asSchemaFromLinks()` before classifying a callable or deriving help.
2. `ct exec` resolves the mounted file from persisted mount metadata plus the mounted directory’s `meta.json`, not from daemon RPC and not from live piece-name matching.
3. The mounted display name under `pieces/` is not stable because FUSE de-dupes names (`foo`, `foo-2`, ...). Use mounted `meta.json` to recover the real piece ID.
4. Mount metadata must exist for both foreground and background mounts. Background-only PID files are insufficient.
5. Persist the mount identity path as an absolute path so later `ct exec` calls do not depend on caller cwd.
6. Use one shared mounted-callable path parser for both:
   - FUSE handler write routing
   - CLI `ct exec` resolution
7. Only top-level callable children under `input/` and `result/` are surfaced as `.handler` / `.tool`.
8. Handler execution must preserve the current write-to-handler behavior: writing a payload to the same piece property path the FUSE flush path uses, then waiting for runtime idle/sync before exiting the CLI.

## File Map

### Create

- `packages/cli/commands/exec.ts`
  - New `ct exec` command entrypoint.
- `packages/cli/lib/exec.ts`
  - Mount lookup, mounted-file resolution, callable-cell lookup, execution dispatch.
- `packages/cli/lib/exec-schema.ts`
  - Schema-to-flag translation, help rendering, argv parsing.
- `packages/cli/test/exec.test.ts`
  - Focused tests for help precedence, schema flags, mount resolution, and execution dispatch.
- `packages/cli/integration/fuse-exec.sh`
  - Real end-to-end FUSE-backed integration script.
- `packages/cli/integration/pattern/fuse-exec.tsx`
  - Minimal deployed pattern with one handler and one pattern tool.
- `packages/fuse/callables.ts`
  - Callable classification, shebang rendering, JSON-sigil replacement.
- `packages/fuse/callable-path.ts`
  - Pure parser for mounted callable paths used by FUSE and CLI.
- `packages/fuse/callable-path.test.ts`
  - Pure parser tests for `pieces/...` and `entities/...` callable paths.

### Modify

- `packages/cli/commands/main.ts`
  - Register `ct exec`.
- `packages/cli/commands/fuse.ts`
  - Always write/remove mount-state files, generate the stable shebang shim, pass the shim path into the daemon, update help text for readable callables and `.tool`.
- `packages/cli/lib/fuse.ts`
  - Replace the PID-only model with mount-state helpers, longest-prefix path lookup, stale-entry cleanup, and shim generation.
- `packages/fuse/types.ts`
  - Replace the handler-only synthetic node with a generalized callable node.
- `packages/fuse/tree.ts`
  - Add `addCallable(...)`.
- `packages/fuse/tree-builder.ts`
  - Replace both handlers and tools with compact sigils in synthesized `.json` siblings.
- `packages/fuse/cell-bridge.ts`
  - Discover callable children via `asSchemaFromLinks()`, skip them from normal expansion, add `.handler` / `.tool`, and reuse the shared path parser for handler writes.
- `packages/fuse/mod.ts`
  - Accept the shim path, make callable files readable, keep handler writes, and return shebang text from `read`.
- `packages/fuse/tree-builder.test.ts`
  - Extend unit coverage for `.tool` synthesis, sigils, and callable reads.
- `packages/cli/test/fuse.test.ts`
  - Cover mount-state lookup, absolute identity persistence, stale cleanup, and shim generation.
- `packages/fuse/README.md`
  - Document `.tool`, readable callable files, and `ct exec`.
- `docs/specs/fuse-filesystem/2-path-scheme.md`
  - Add `.tool` to the mounted layout.
- `docs/specs/fuse-filesystem/3-json-mapping.md`
  - Document `/tool` sigils in synthesized `.json` siblings.
- `docs/specs/fuse-filesystem/4-read-write.md`
  - Update callable read/write semantics and modes.
- `docs/common/workflows/handlers-cli-testing.md`
  - Document `ct exec` against mounted handlers/tools.

## Architecture Decisions

### 1. Generate a stable `ct` shim for the shebang line, but do not gate on direct shell execution

The repo does not ship a real `ct` binary path; developers often launch the CLI via `deno task ct`. Rendered callable files still need a deterministic first line:

```text
#!/absolute/path/to/generated/ct-shim exec
```

Implement `ensureExecShim(...)` in `packages/cli/lib/fuse.ts` and pass the shim path to the FUSE daemon. The shim should be repo-rooted and explicit:

```bash
#!/usr/bin/env bash
exec /absolute/path/to/deno run --allow-net --allow-ffi --allow-read --allow-write --allow-env --allow-run /absolute/path/to/packages/cli/mod.ts "$@"
```

This is required for stable shebang content. It is not a requirement to set executable bits or prove `./file.handler` execution in this change.

### 2. Put mounted-callable path parsing in one pure helper and reuse it everywhere

Create `packages/fuse/callable-path.ts` with a parser for exactly these shapes:

```text
<space>/pieces/<piece-dir>/<input|result>/<name>.handler
<space>/pieces/<piece-dir>/<input|result>/<name>.tool
<space>/entities/<entity-id>/<input|result>/<name>.handler
<space>/entities/<entity-id>/<input|result>/<name>.tool
```

Export a small parsed shape:

```ts
interface MountedCallablePath {
  spaceName: string;
  rootKind: "pieces" | "entities";
  rootName: string;
  cellProp: "input" | "result";
  cellKey: string;
  callableKind: "handler" | "tool";
}
```

Use this helper in both:

1. `packages/fuse/cell-bridge.ts` when routing writes to mounted handlers
2. `packages/cli/lib/exec.ts` when mapping a user-supplied mounted file path back to its callable cell

This avoids the current drift risk where FUSE and CLI would each invent their own path parser.

### 3. Keep callable discovery in FUSE and callable execution in CLI

FUSE should only:

1. classify top-level child cells as `handler`, `tool`, or ordinary values
2. synthesize callable nodes and readable shebang text
3. keep current write-to-handler semantics intact

CLI `ct exec` should:

1. resolve the mounted file path
2. load the backing piece and callable child cell
3. derive help/flags from the resolved schema
4. execute the callable

Do not move execution semantics into FUSE and do not add daemon RPC for lookup.

### 4. Keep tool execution local to `ct exec`; do not refactor runner builtins

`ct exec` only needs a narrow pattern-tool execution path:

```ts
const pattern = callableCell.key("pattern").getRaw() as Pattern | undefined;
const extraParams = callableCell.key("extraParams").get() ?? {};
const result = manager.runtime.getCell(space, crypto.randomUUID(), pattern?.resultSchema, tx);
manager.runtime.run(tx, pattern!, { ...input, ...extraParams }, result);
```

Then wait for the result cell using the same basic timeout shape the current tool path uses and print the completed value as JSON.

Do not make this feature depend on extracting shared helpers from `llm-dialog`. That is separate cleanup and not required to land the user’s request.

### 5. Keep schema flags simple and predictable

For object schemas:

1. one flag per top-level property
2. booleans support `--flag`, `--no-flag`, and `--flag=true|false`
3. arrays/objects are passed as JSON strings
4. required properties are enforced
5. unknown flags are rejected clearly

Always support:

```bash
ct exec <file> run --json '{"query":"oat milk","filters":{"fresh":true}}'
```

`--json` is mutually exclusive with generated flags.

## Task 1: Persist Mount State And Generate The Shebang Shim

**Files:**
- Modify: `packages/cli/lib/fuse.ts`
- Modify: `packages/cli/commands/fuse.ts`
- Test: `packages/cli/test/fuse.test.ts`

- [ ] **Step 1: Extend the existing FUSE CLI tests with failing mount-state and shim cases**

Add focused cases covering:

1. mount-state entries include `mountpoint`, `apiUrl`, `identity`, `pid`, and `startedAt`
2. stored identities are absolute paths, even if mount used a relative `--identity`
3. longest-prefix mount lookup resolves a mounted file path to the correct mount
4. stale mount-state entries are ignored and cleaned up
5. generated shim content points at `packages/cli/mod.ts`
6. `ct fuse --help` text describes readable `.handler` files and `.tool`

Run:

```bash
cd packages/cli
deno test --allow-ffi --allow-read --allow-write --allow-run --allow-env test/fuse.test.ts
```

Expected: FAIL because mount-state helpers and shim generation do not exist yet.

- [ ] **Step 2: Replace the PID-only helpers in `packages/cli/lib/fuse.ts`**

Implement:

```ts
export interface MountStateEntry {
  mountpoint: string;
  apiUrl: string;
  identity: string;
  pid: number;
  startedAt: string;
}

export async function writeMountState(...)
export async function readMountState(...)
export async function readAllMountStates(...)
export async function findMountForPath(absPath: string)
export async function ensureExecShim(...)
```

Keep the mountpoint-hash filename behavior so unmount/status continue to key by absolute mountpoint.

- [ ] **Step 3: Wire `ct fuse mount` to always write mount-state and pass the shim path into the daemon**

For both foreground and background mounts:

1. generate the shim before spawn
2. normalize `options.identity` to an absolute path before persisting it
3. spawn the daemon
4. persist mount-state immediately after spawn
5. pass `--exec-cli <shim>` to `packages/fuse/mod.ts`
6. remove the state file on clean foreground exit
7. update built-in help/examples to mention readable callables and `.tool`

- [ ] **Step 4: Re-run the focused CLI FUSE test**

Run:

```bash
cd packages/cli
deno test --allow-ffi --allow-read --allow-write --allow-run --allow-env test/fuse.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/lib/fuse.ts packages/cli/commands/fuse.ts packages/cli/test/fuse.test.ts
git commit -m "feat: persist fuse mount state for ct exec"
```

## Task 2: Generalize FUSE Synthetic Files Into Readable Callables

**Files:**
- Create: `packages/fuse/callables.ts`
- Create: `packages/fuse/callable-path.ts`
- Create: `packages/fuse/callable-path.test.ts`
- Modify: `packages/fuse/types.ts`
- Modify: `packages/fuse/tree.ts`
- Modify: `packages/fuse/tree-builder.ts`
- Modify: `packages/fuse/cell-bridge.ts`
- Modify: `packages/fuse/mod.ts`
- Test: `packages/fuse/tree-builder.test.ts`

- [ ] **Step 1: Add failing pure tests for mounted callable path parsing**

Cover:

1. `pieces/.../*.handler`
2. `pieces/.../*.tool`
3. `entities/.../*.handler`
4. `entities/.../*.tool`
5. rejection of non-callable paths and nested internal tool paths

Run:

```bash
cd packages/fuse
deno test callable-path.test.ts
```

Expected: FAIL because the shared parser file does not exist yet.

- [ ] **Step 2: Extend `packages/fuse/tree-builder.test.ts` with failing callable-node cases**

Add cases covering:

1. `.tool` entries appear beside ordinary fields
2. callable entries are skipped from normal JSON expansion
3. `.json` siblings replace handlers and tools with compact sigils
4. callable reads return script bytes whose first line starts with `#!` and contains ` exec`
5. handler writes still resolve through both `pieces/...` and `entities/...` mounted callable paths once routing uses the shared parser

Run:

```bash
cd packages/fuse
deno test callable-path.test.ts tree-builder.test.ts
```

Expected: FAIL because the tree only knows handler nodes and the shared parser is missing.

- [ ] **Step 3: Implement the shared parser and generalized callable node**

Implement `packages/fuse/callable-path.ts` and replace the handler-only node shape with:

```ts
type FsNode =
  | { kind: "dir"; ... }
  | { kind: "file"; ... }
  | { kind: "symlink"; ... }
  | {
      kind: "callable";
      callableKind: "handler" | "tool";
      cellKey: string;
      cellProp: "input" | "result";
      script: Uint8Array;
    };
```

Add `addCallable(...)` to `packages/fuse/tree.ts`.

- [ ] **Step 4: Implement callable classification and shebang-backed reads**

In `packages/fuse/callables.ts`:

1. classify top-level child cells as `handler`, `tool`, or normal using `childCell.asSchemaFromLinks()`
2. generate the callable script bytes from the daemon’s `execCli` path
3. replace callable values in `.json` siblings with explicit sigils

Use explicit sigils:

```json
{"/handler":"addItem"}
{"/tool":"search"}
```

- [ ] **Step 5: Update `packages/fuse/cell-bridge.ts` and `packages/fuse/mod.ts`**

In `cell-bridge.ts`:

1. call `asSchemaFromLinks()` on each top-level child in `input` and `result`
2. skip callable children from normal tree expansion
3. add `.handler` or `.tool` synthetic nodes
4. route handler writes through the shared mounted-callable path parser so both `pieces/` and `entities/` callable paths work

In `mod.ts`:

1. accept the passed `--exec-cli` path
2. make callable files readable
3. keep handlers writable
4. reject writes to `.tool` with `EACCES`
5. return the shebang-backed script content from `read`

- [ ] **Step 6: Re-run the focused FUSE tests**

Run:

```bash
cd packages/fuse
deno test callable-path.test.ts tree-builder.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/fuse/callables.ts packages/fuse/callable-path.ts packages/fuse/callable-path.test.ts packages/fuse/types.ts packages/fuse/tree.ts packages/fuse/tree-builder.ts packages/fuse/cell-bridge.ts packages/fuse/mod.ts packages/fuse/tree-builder.test.ts
git commit -m "feat: expose fuse handlers and tools as callables"
```

## Task 3: Build Dynamic Schema Flags And Help For `ct exec`

**Files:**
- Create: `packages/cli/lib/exec-schema.ts`
- Create: `packages/cli/test/exec.test.ts`

- [ ] **Step 1: Add failing parser/help tests for `ct exec`**

Cover:

1. defaulting to `invoke` for handlers and `run` for tools
2. top-level `--help` always works
3. post-verb `--help` is treated as a schema field when the schema has `help`
4. boolean and non-boolean `help` fields both behave correctly
5. primitive flags parse correctly
6. array/object flags parse from JSON strings
7. `--json` is mutually exclusive with generated flags
8. required-field, enum, and unknown-flag errors are readable

Run:

```bash
cd packages/cli
deno test --allow-ffi --allow-read --allow-write --allow-run --allow-env test/exec.test.ts
```

Expected: FAIL because the parser/help layer does not exist yet.

- [ ] **Step 2: Implement `packages/cli/lib/exec-schema.ts`**

Build a focused dynamic CLI layer around a command spec like:

```ts
interface ExecCommandSpec {
  callableKind: "handler" | "tool";
  defaultVerb: "invoke" | "run";
  inputSchema: JSONSchema;
  outputSchemaSummary?: JSONSchema;
}
```

Rules:

1. object schema => one flag per top-level property
2. non-object schema => single `--value <json>` flag
3. booleans support `--flag`, `--no-flag`, and `--flag=true|false`
4. `--json <object>` bypasses generated flags
5. help rendering uses `schemaToTypeString(...)`
6. top-level help lists the callable kind, the available verb, the input schema, and the output-schema summary for tools

- [ ] **Step 3: Render help in the precedence order the user asked for**

Implement:

1. `ct exec <file> --help` => top-level help
2. `ct exec <file> [invoke|run] --help` => schema field `help` if that field exists
3. otherwise post-verb `--help` falls back to command help

Do not model `invoke` / `run` as Cliffy subcommands. `packages/cli/commands/exec.ts` must preserve raw tail args so this precedence works.

- [ ] **Step 4: Re-run the focused parser/help test**

Run:

```bash
cd packages/cli
deno test --allow-ffi --allow-read --allow-write --allow-run --allow-env test/exec.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/lib/exec-schema.ts packages/cli/test/exec.test.ts
git commit -m "feat: add schema-driven parsing for ct exec"
```

## Task 4: Implement `ct exec` Resolution And Execution

**Files:**
- Create: `packages/cli/commands/exec.ts`
- Create: `packages/cli/lib/exec.ts`
- Modify: `packages/cli/commands/main.ts`
- Test: `packages/cli/test/exec.test.ts`

- [ ] **Step 1: Extend `packages/cli/test/exec.test.ts` with failing resolution/execution cases**

Add focused cases for:

1. rejecting non-mounted paths
2. rejecting mounted non-callable files
3. resolving the correct mount by longest-prefix lookup
4. resolving the backing piece ID from sibling `meta.json`, including de-duped display names like `notes-2`
5. resolving mounted callable paths under both `pieces/` and `entities/`
6. calling `asSchemaFromLinks()` on the resolved child cell
7. handler dispatch using the same piece-property path the FUSE flush path uses
8. tool dispatch merging `extraParams` and printing JSON to stdout

Run:

```bash
cd packages/cli
deno test --allow-ffi --allow-read --allow-write --allow-run --allow-env test/exec.test.ts
```

Expected: FAIL because `ct exec` does not exist yet.

- [ ] **Step 2: Implement mount-path resolution and callable lookup in `packages/cli/lib/exec.ts`**

Flow:

```ts
const mount = await findMountForPath(absFilePath);
const target = parseMountedCallablePath(relativePathWithinMount);
const pieceMeta = await readMountedPieceMeta(absFilePath, target);
const manager = await loadManager({
  apiUrl: mount.apiUrl,
  identity: mount.identity,
  space: target.spaceName,
});
const piece = await new PiecesController(manager).get(pieceMeta.id, false);
const rootCell = await piece[target.cellProp].getCell();
const callableCell = rootCell.key(target.cellKey).asSchemaFromLinks();
```

Do not guess piece IDs from mounted directory names.

- [ ] **Step 3: Implement execution dispatch in `packages/cli/lib/exec.ts`**

Handler:

1. derive input from flags or `--json`
2. write through `piece[cellProp].set(value, [cellKey])`
3. wait for `manager.runtime.idle()` and `manager.synced()`
4. exit `0` without a stdout payload

Tool:

1. derive the effective input schema from `pattern.argumentSchema`
2. subtract bound `extraParams` keys from the visible flags
3. create a result cell and run the underlying pattern with `{ ...input, ...extraParams }`
4. wait for the first non-`undefined` result value with a timeout
5. print the completed result as JSON to stdout

Keep this local to `ct exec`; do not refactor `llm-dialog`.

- [ ] **Step 4: Wire the command into `ct`**

Add:

```text
ct exec <mounted-callable-file> [invoke|run] [flags]
```

to `packages/cli/commands/main.ts`, keeping root help terse.

- [ ] **Step 5: Re-run the focused `ct exec` test**

Run:

```bash
cd packages/cli
deno test --allow-ffi --allow-read --allow-write --allow-run --allow-env test/exec.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/commands/exec.ts packages/cli/lib/exec.ts packages/cli/commands/main.ts packages/cli/test/exec.test.ts
git commit -m "feat: add ct exec for mounted callables"
```

## Task 5: Prove The Real User Flow And Update Docs

**Files:**
- Create: `packages/cli/integration/fuse-exec.sh`
- Create: `packages/cli/integration/pattern/fuse-exec.tsx`
- Modify: `packages/fuse/README.md`
- Modify: `docs/specs/fuse-filesystem/2-path-scheme.md`
- Modify: `docs/specs/fuse-filesystem/3-json-mapping.md`
- Modify: `docs/specs/fuse-filesystem/4-read-write.md`
- Modify: `docs/common/workflows/handlers-cli-testing.md`

- [ ] **Step 1: Add a failing real FUSE-backed integration script**

The fixture pattern must expose:

1. one handler with required scalar input
2. one pattern tool with one bound `extraParam`
3. one schema field literally named `help`

The script should:

1. create a temp space and identity
2. deploy the fixture pattern
3. mount FUSE
4. assert `.handler` and `.tool` entries exist
5. read each callable file and assert the first line starts with `#!` and contains ` exec`
6. assert `ct exec <handler-file> --help` and `ct exec <tool-file> --help` show top-level help
7. assert `ct exec <tool-file> run --help <value>` is parsed as the schema field, not intercepted as CLI help
8. execute `ct exec` against the handler and tool with explicit verbs
9. execute `ct exec` without an explicit verb for one handler case and one tool case
10. assert the handler changed piece state
11. assert the tool printed the expected JSON
12. verify legacy `echo '{}' > file.handler` still works
13. exercise at least one callable through `entities/<entity-id>/...`

Run:

```bash
cd packages/cli
API_URL=http://localhost:8000 CT_CLI_INTEGRATION_USE_LOCAL=1 ./integration/fuse-exec.sh
```

Expected: FAIL until the end-to-end surface is complete.

- [ ] **Step 2: Implement the fixture and integration assertions**

Keep the fixture deterministic:

1. no LLM-backed tools
2. no external HTTP
3. tool output should visibly depend on the `help` field so the precedence rule is proven end to end

- [ ] **Step 3: Update docs to match shipped behavior**

Required doc changes:

1. FUSE layout now includes `*.tool`
2. synthesized `.json` siblings render `/tool` sigils
3. callable files are readable and handlers remain writable
4. `ct exec` examples are documented
5. handler-testing docs mention mounted callable execution as a fast local workflow
6. built-in `ct fuse` help no longer describes handlers as write-only

- [ ] **Step 4: Run the focused automated checks**

Run:

```bash
cd packages/fuse
deno test callable-path.test.ts tree-builder.test.ts
```

Run:

```bash
cd packages/cli
deno task test
```

Run:

```bash
cd packages/cli
API_URL=http://localhost:8000 CT_CLI_INTEGRATION_USE_LOCAL=1 ./integration/fuse-exec.sh
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/integration/fuse-exec.sh packages/cli/integration/pattern/fuse-exec.tsx packages/fuse/README.md docs/specs/fuse-filesystem/2-path-scheme.md docs/specs/fuse-filesystem/3-json-mapping.md docs/specs/fuse-filesystem/4-read-write.md docs/common/workflows/handlers-cli-testing.md
git commit -m "docs: document ct exec fuse callables"
```

## Final Verification

- [ ] `ct exec` works for both mounted `.handler` and mounted `.tool` files.
- [ ] Verb omission defaults to `invoke` for handlers and `run` for tools.
- [ ] `ct exec` resolves callable files from both mounted `pieces/...` and mounted `entities/...` paths.
- [ ] Reading a mounted callable file returns a first line shaped like `#!... exec`.
- [ ] Handler write-through (`echo ... > file.handler`) still works.
- [ ] `.tool` hides `pattern/extraParams` internals from the mounted tree and from synthesized `.json` siblings.
- [ ] Tool help uses the normalized argument schema minus bound `extraParams`.
- [ ] Top-level help is always available, and post-verb `--help` becomes the schema field when `help` exists.
