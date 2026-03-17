# `ct exec` + FUSE Callable Files Implementation Plan

> **For agentic workers:** REQUIRED: Use @trycycle-executing to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make mounted FUSE `.handler` files and new `.tool` files first-class CLI entrypoints by adding `ct exec <file> ...`, shebang-backed readable/executable callable files, schema-derived flag parsing/help, and real pattern-tool execution.

**Architecture:** Treat mounted handlers and pattern tools as one FUSE concept: callable files with a kind (`handler` or `tool`), a mounted path, a generated shebang payload, and an exact backing cell. `ct exec` resolves the mounted path through persisted mount metadata, reads mounted piece metadata to recover the stable piece ID behind that path, introspects the backing cell with `asSchemaFromLinks()`, derives the effective command schema (`invoke` for handlers, `run` for tools), then dispatches through the existing piece/runtime stack. Reuse extracted runner callable-execution helpers for pattern-tool completion/serialization instead of open-coding a second `runtime.run(...)` flow in the CLI. Use a generated exec shim rather than guessing the user’s `ct` invocation so mounted files are actually executable from the shell in this repo’s `deno task ct` world.

**Tech Stack:** Deno 2, Cliffy, `@commontools/piece`, `@commontools/runner`, FUSE low-level bindings, existing CLI integration shell harnesses.

---

## Scope And Invariants

### User-visible behavior

1. Mounted `*.handler` files remain writable and still invoke handlers on flush, but they also become readable and executable.
2. Mounted pattern-tool values are no longer exposed as expanded `pattern/extraParams` directories. They appear as `*.tool` siblings beside normal result/input fields.
3. Reading either a `*.handler` or `*.tool` file returns a script whose first line is `#!<generated-ct-shim> exec`.
4. Executing a mounted callable directly works because the file mode is executable and the shebang points at a real shim:

```bash
/tmp/ct/home/pieces/demo/result/addItem.handler --title "Buy milk"
/tmp/ct/home/pieces/demo/result/search.tool --query "oat milk"
```

5. `ct exec <file> ...` also works directly:

```bash
ct exec /tmp/ct/home/pieces/demo/result/addItem.handler --title "Buy milk"
ct exec /tmp/ct/home/pieces/demo/result/search.tool --query "oat milk"
```

6. Explicit verbs are supported and are the only documented core commands:
   - handler: `invoke`
   - tool: `run`
7. The verb is optional when omitted; `ct exec` defaults to the callable’s only real action:
   - handler defaults to `invoke`
   - tool defaults to `run`
8. `ct exec <file> --help` always prints top-level help for that callable, including schema and the available core command.
9. After the verb, generated schema flags own the namespace. If the input schema has a `help` field, `ct exec <file> run --help` is parsed as that schema field using the normal flag rules for its type (`true` for boolean help flags, a required value for non-boolean help fields), not as CLI help. Top-level help remains available at `ct exec <file> --help`.
10. Tool input flags come from the underlying pattern’s `argumentSchema` minus injected `result` and minus already-bound `extraParams`.
11. Tool help shows both input schema and a best-effort output schema. The output display is heuristic-only and must not block execution.
12. Non-mounted paths, stale mounts, non-callable files, and invalid flag/value combinations fail with clear CLI errors instead of stack traces.

### Important contracts

1. The mounted path is the stable identity for `ct exec`; there is no daemon RPC for path resolution.
2. The mounted piece directory name is not a stable piece identifier because FUSE de-dupes duplicate names (`foo`, `foo-2`, ...). `ct exec` must recover the real piece ID from mounted metadata (`meta.json` in that piece directory), not by re-deriving a name match from live space contents.
3. `ct exec` must resolve mount metadata for both foreground and background mounts. The current background-only PID file behavior is insufficient and must be replaced with always-on mount state.
4. Persist the mount identity as an absolute path. Relative `--identity` values are valid at mount time but would break later `ct exec` calls launched from a different cwd.
5. The exact cell used for schema discovery is the callable child cell, not the piece root. Always call `childCell.asSchemaFromLinks()` before classifying or rendering help.
6. Handler execution must stay semantically aligned with existing write-to-handler behavior: write the payload through the same piece property path the FUSE flush path uses, then wait for runtime/piece sync.
7. Tool execution must stay semantically aligned with existing `patternTool(...)` runtime behavior: run the underlying pattern with `input + extraParams`, wait for the result cell using the same completion semantics as the runner’s existing tool path, then serialize/print the resulting value with the same runner serializer.

### Boundaries to keep sharp

1. Only mounted FUSE callable files are in scope for `ct exec`. Reject normal files like `result/title` and reject arbitrary repo files.
2. Only top-level callable entries in `input/` and `result/` are surfaced as `.handler` / `.tool` siblings. Do not recurse into nested pattern-tool internals.
3. `ct exec` should support object-shaped schemas with generated flags plus a raw JSON escape hatch. Do not invent a large nested flag DSL.

## File Map

### Create

- `packages/cli/commands/exec.ts`
  - New `ct exec` command definition.
- `packages/cli/lib/exec.ts`
  - Mount resolution, callable-path parsing, backing-cell lookup, execution dispatch.
- `packages/cli/lib/exec-schema.ts`
  - Schema-to-flag spec builder, parser, help renderer.
- `packages/cli/test/exec.test.ts`
  - Focused tests for mount-path parsing, command defaulting, help precedence, and schema flag parsing.
- `packages/cli/integration/fuse-exec.sh`
  - Real end-to-end FUSE-backed integration script.
- `packages/cli/integration/pattern/fuse-exec.tsx`
  - Minimal deployed pattern exposing one handler and one pattern tool for integration coverage.
- `packages/fuse/callables.ts`
  - Callable classification helpers for FUSE (`handler` vs `tool`), shebang payload generation, JSON sigil replacement.
- `packages/runner/src/callable-execution.ts`
  - Shared callable execution + serialization helpers reused by `ct exec` and `llm-dialog` so pattern-tool result waiting does not drift.
- `packages/runner/src/tool-schema.ts`
  - Shared schema helpers reused by `ct exec` and `llm-dialog` for stripping injected fields, deriving tool input schema, and describing output schema heuristically.
- `packages/runner/test/callable-execution.test.ts`
  - Characterization tests for callable result waiting and serialization behavior.
- `packages/runner/test/tool-schema.test.ts`
  - Characterization tests for tool-schema derivation and output-schema heuristics.

### Modify

- `packages/cli/commands/main.ts`
  - Register the new `exec` command and brief top-level help text.
- `packages/cli/commands/fuse.ts`
  - Always write/remove mount-state files, generate the executable shim, and pass the shim path into the FUSE daemon.
- `packages/cli/lib/fuse.ts`
  - Replace the narrow PID-file model with a mount-state model that includes `identity`, `pid`, and `execShimPath`; add longest-prefix mount lookup and shim generation helpers.
- `packages/fuse/types.ts`
  - Replace the handler-only synthetic node with a generalized callable node type.
- `packages/fuse/tree.ts`
  - Add `addCallable(...)` and path bookkeeping for callable nodes.
- `packages/fuse/tree-builder.ts`
  - Generalize stream-only replacement helpers so `.json` siblings can replace both handlers and tools with compact sigils.
- `packages/fuse/cell-bridge.ts`
  - Discover callable child cells via `asSchemaFromLinks()`, skip them from normal tree expansion, create `.handler` / `.tool` nodes, and keep handler writes working.
- `packages/fuse/mod.ts`
  - Accept the passed exec-shim path, expose callable files as readable/executable, keep handler writes, and return script content from `read`.
- `packages/fuse/tree-builder.test.ts`
  - Extend the existing unit coverage for callable node synthesis, `.tool` sigils, and shebang-backed reads.
- `packages/cli/test/fuse.test.ts`
  - Cover mount-state encoding/lookup and shim generation.
- `packages/runner/src/builtins/llm-dialog.ts`
  - Reuse the extracted shared callable helpers instead of keeping a second divergent normalization/execution path.
- `packages/runner/src/index.ts`
  - Export the new runner callable helpers for the CLI package.
- `packages/fuse/README.md`
  - Document `.tool`, readable/executable callable files, and `ct exec`.
- `docs/specs/fuse-filesystem/2-path-scheme.md`
  - Add `.tool` to the mounted layout.
- `docs/specs/fuse-filesystem/3-json-mapping.md`
  - Document `/tool` sigils in synthesized `.json` siblings.
- `docs/specs/fuse-filesystem/4-read-write.md`
  - Update callable file modes and read semantics.
- `docs/common/workflows/handlers-cli-testing.md`
  - Document mounted-handler execution via `ct exec`.

## Architecture Decisions

### 1. Generate a real exec shim and pass it into FUSE

Do not try to infer a literal `ct` binary path from the current process. In this repo, developers commonly run `ct` via `deno task ct`, which has no stable executable path suitable for a shebang.

Use this steady-state design instead:

```ts
interface MountStateEntry {
  mountpoint: string;
  apiUrl: string;
  identity: string;
  pid: number;
  startedAt: string;
  execShimPath: string;
}
```

`ct fuse mount` must:

1. Build or refresh an executable shim under `~/.ct/fuse/bin/`.
2. Normalize the mount identity path to an absolute path before it is persisted or passed onward.
3. Spawn the FUSE daemon in both foreground and background modes.
4. Persist `MountStateEntry` immediately after spawn.
5. Pass `--exec-cli <shim>` to `packages/fuse/mod.ts`.
6. Remove the mount-state file on clean exit.

The shim itself should be repo-rooted and explicit:

```bash
#!/usr/bin/env bash
exec /absolute/path/to/deno run --allow-net --allow-ffi --allow-read --allow-write --allow-env --allow-run /absolute/path/to/packages/cli/mod.ts "$@"
```

That makes the mounted shebang deterministic, independent of caller cwd, and usable by direct execution.

### 2. Unify `.handler` and `.tool` as one FUSE node kind

Do not bolt `.tool` on as a second special-case path that duplicates all `open/read/getattr` logic. Replace the current handler-only synthetic node with a generalized callable node:

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

Mode rules:

1. `handler`: readable + writable + executable
2. `tool`: readable + executable, not writable

This keeps `mod.ts` simple and makes the read path and help path identical for both callable kinds.

### 3. Resolve the backing callable by mount path plus mounted metadata, not by daemon state

`ct exec` should not talk to the running daemon. It should:

1. Resolve the absolute user-supplied path.
2. Find the longest matching mounted `mountpoint` from persisted mount-state files.
3. Parse the relative path under that mountpoint.
4. Require the shape:

```text
<space>/pieces/<piece>/<input|result>/<name>.handler
<space>/pieces/<piece>/<input|result>/<name>.tool
```

5. Read `<mountpoint>/<space>/pieces/<piece>/meta.json` from the mounted filesystem and extract the real piece ID for that directory.
6. Load the `PieceManager` for that `space` using the mount’s `apiUrl` and absolute `identity`.
7. Resolve the piece controller by piece ID, not directory name.
8. Resolve the exact child cell with `piece[input|result].getCell().key(name)`.

The same segment parser logic should power both:

1. FUSE’s write-to-handler routing
2. CLI `ct exec`

Keep the path-shape parsing in one pure helper so the mapping cannot drift. CLI piece-ID recovery is a separate step that intentionally uses mounted metadata because only the mounted filesystem knows how duplicate display names were de-duped.

### 4. Derive tool schemas from the underlying pattern, not from the wrapper object

For a pattern tool, the callable cell’s linked schema identifies that it is a tool, but the effective CLI input schema is not the wrapper `{ pattern, extraParams }`.

Use this derivation:

```ts
const toolCell = childCell.asSchemaFromLinks();
const schema = toolCell.getAsNormalizedFullLink().schema;

const pattern = toolCell.key("pattern").getRaw() as Pattern | undefined;
const extraParams = toolCell.key("extraParams").get() ?? {};

const inputSchema = stripBoundExtraParams(
  stripInjectedResult(pattern?.argumentSchema ?? schema),
  Object.keys(extraParams),
);
```

Tool output help should come from `pattern.resultSchema`, with a documented heuristic:

1. If the result schema is an object containing only the common async wrapper keys `pending`, `error`, and `result`, display `result`.
2. If the schema is an object with a single required success payload key, prefer that payload.
3. Otherwise show the raw `resultSchema`.

Base the heuristic on real examples already in-tree:

1. `packages/patterns/notes/note.tsx`
2. `packages/patterns/system/omnibox-fab.tsx`
3. `packages/patterns/deep-research.tsx`

The heuristic is display-only. Execution always uses the real pattern.

### 5. Keep schema flags simple: top-level properties + `--json`

Do not invent a full nested flag language. For object inputs:

1. Generate one flag per top-level property.
2. Scalars parse as scalars.
3. Arrays/objects parse as JSON strings.
4. Booleans support `--flag`, `--no-flag`, and `--flag=true|false`.
5. Required properties are enforced.
6. Unknown flags are rejected with a targeted message.

Always support a raw escape hatch:

```bash
ct exec <file> run --json '{"query":"oat milk","filters":{"fresh":true}}'
```

`--json` is mutually exclusive with generated flags.

This preserves the user’s requested schema-derived flags while keeping the implementation robust and debuggable.

## Task 1: Persist Mount State And Generate The Exec Shim

**Files:**
- Modify: `packages/cli/lib/fuse.ts`
- Modify: `packages/cli/commands/fuse.ts`
- Test: `packages/cli/test/fuse.test.ts`

- [ ] **Step 1: Extend the existing FUSE CLI tests with a failing mount-state + exec-shim case**

Add cases covering:

1. mount-state entries now include `identity`, `pid`, and `execShimPath`
2. longest-prefix mount resolution for a mounted file path
3. stored identities are absolute paths, even when the mount command was given a relative key path
4. generated shim content is executable text pointing at `packages/cli/mod.ts`
5. stale mount-state entries are ignored so `ct exec` cannot attach to a dead mount

Run:

```bash
cd packages/cli
deno test --allow-ffi --allow-read --allow-write --allow-run --allow-env test/fuse.test.ts
```

Expected: FAIL because mount-state fields and shim helpers do not exist yet.

- [ ] **Step 2: Replace the narrow PID helpers with mount-state helpers in `packages/cli/lib/fuse.ts`**

Implement:

```ts
export interface MountStateEntry {
  mountpoint: string;
  apiUrl: string;
  identity: string;
  pid: number;
  startedAt: string;
  execShimPath: string;
}

export async function writeMountState(...)
export async function readMountState(...)
export async function readAllMountStates(...)
export async function findMountForPath(absPath: string)
export async function ensureExecShim(...)
```

Keep the mountpoint-hash filename behavior so state cleanup remains stable. `findMountForPath(...)` must reject stale entries before returning a match.

- [ ] **Step 3: Wire `ct fuse mount` to always write mount-state entries**

For both foreground and background mounts:

1. generate the shim before spawning
2. resolve `options.identity` to an absolute path before writing state or spawning the daemon
3. spawn the daemon
4. persist the mount-state entry
5. pass `--exec-cli <shim>` to the daemon
6. on clean foreground exit, remove the state file

Do not regress `ct fuse status` or `ct fuse unmount`.

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
git commit -m "feat: persist fuse mount state for exec"
```

## Task 2: Generalize FUSE Synthetic Files Into Readable/Executable Callables

**Files:**
- Create: `packages/fuse/callables.ts`
- Modify: `packages/fuse/types.ts`
- Modify: `packages/fuse/tree.ts`
- Modify: `packages/fuse/tree-builder.ts`
- Modify: `packages/fuse/cell-bridge.ts`
- Modify: `packages/fuse/mod.ts`
- Test: `packages/fuse/tree-builder.test.ts`

- [ ] **Step 1: Add failing tests for `.tool` synthesis, callable sigils, and shebang-backed reads**

Extend `packages/fuse/tree-builder.test.ts` to cover:

1. `.tool` entries appear beside ordinary fields
2. callable entries are skipped from normal JSON expansion
3. `.json` siblings replace tools with a compact sigil
4. callable nodes carry script content whose first line is the passed shebang

Run:

```bash
cd packages/fuse
deno test tree-builder.test.ts
```

Expected: FAIL because the FUSE tree only knows handler nodes today.

- [ ] **Step 2: Replace the handler-only node kind with a callable node**

Implement `addCallable(...)` in `packages/fuse/tree.ts` and update `packages/fuse/types.ts` accordingly. Keep the stored `cellKey` / `cellProp` so handler writes still route through the piece controller.

- [ ] **Step 3: Add callable classification helpers in `packages/fuse/callables.ts`**

This helper should:

1. classify a child cell as `handler`, `tool`, or normal
2. build the mounted script bytes from the daemon’s `execCli` path
3. replace callable entries in `.json` siblings with explicit sigils
4. let `CellBridge` pass in the exact top-level callable keys it discovered from `asSchemaFromLinks()` so `.tool` replacement does not depend on raw `{ pattern, extraParams }` value-shape guessing

Use explicit sigils:

```json
{"/handler":"addItem"}
{"/tool":"search"}
```

- [ ] **Step 4: Update `CellBridge` to discover callable children via `asSchemaFromLinks()`**

For each top-level child in `input` and `result`:

1. resolve the child cell
2. call `asSchemaFromLinks()`
3. classify it via the shared helper
4. skip callable children from normal tree expansion
5. add `.handler` or `.tool` synthetic nodes with the generated script

Do not rely on raw `pattern/extraParams` object shape alone for mounted classification.

- [ ] **Step 5: Update `mod.ts` callable semantics**

Implement:

1. `getattr` / `read` / `open` support for readable/executable callable nodes
2. handler callables remain writable
3. tool callables reject writes with `EACCES`

Mode constants should reflect reality:

1. callable handler: owner/group `rwx`
2. callable tool: owner/group `rx`

- [ ] **Step 6: Re-run the focused FUSE test**

Run:

```bash
cd packages/fuse
deno test tree-builder.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/fuse/types.ts packages/fuse/tree.ts packages/fuse/tree-builder.ts packages/fuse/callables.ts packages/fuse/cell-bridge.ts packages/fuse/mod.ts packages/fuse/tree-builder.test.ts
git commit -m "feat: expose fuse callables for handlers and tools"
```

## Task 3: Extract Shared Callable Schema And Execution Helpers

**Files:**
- Create: `packages/runner/src/callable-execution.ts`
- Create: `packages/runner/src/tool-schema.ts`
- Create: `packages/runner/test/callable-execution.test.ts`
- Create: `packages/runner/test/tool-schema.test.ts`
- Modify: `packages/runner/src/builtins/llm-dialog.ts`
- Modify: `packages/runner/src/index.ts`

- [ ] **Step 1: Add failing runner tests for callable schema derivation and execution semantics**

Cover:

1. stripping injected `result`
2. subtracting bound `extraParams` keys from the visible tool input schema
3. preserving handler input schemas unchanged
4. unwrapping common async result wrappers for output help
5. waiting for a pattern-tool result cell with the same timeout/completion behavior `llm-dialog` uses today
6. serializing the completed result with the same runner serializer instead of ad-hoc `JSON.stringify`

Run:

```bash
cd packages/runner
deno test test/tool-schema.test.ts test/callable-execution.test.ts
```

Expected: FAIL because the shared helper files do not exist yet.

- [ ] **Step 2: Extract the shared logic into `packages/runner/src/tool-schema.ts` and `packages/runner/src/callable-execution.ts`**

Move or re-home the logic that currently lives inline in `llm-dialog`:

```ts
export function stripInjectedResult(schema: unknown): JSONSchema
export function normalizeCallableInputSchema(schema: unknown): JSONSchema
export function isPatternToolSchema(schema: JSONSchema | undefined): boolean
export function derivePatternToolInputSchema(...)
export function describePatternToolOutputSchema(...)
export async function executeCallablePattern(...)
export async function executeCallableHandler(...)
export function serializeCallableResult(...)
```

`executeCallablePattern(...)` must factor the non-LLM-specific subset of the existing `handleInvoke(...)` path: merge `extraParams`, create the result cell, wait for a result value with timeout, and serialize the finished value with the current runner serializer. Do not let `ct exec` become a second, weaker implementation based on `runtime.idle()` plus `JSON.stringify`.

- [ ] **Step 3: Switch `llm-dialog` to the shared helpers and export them**

Replace the inline normalization path in `buildToolCatalog(...)` and the callable execution path in `handleInvoke(...)` so `llm-dialog` and `ct exec` cannot drift on which fields are exposed, how tool results settle, or how results are serialized. Re-export the helper(s) from `packages/runner/src/index.ts` so the CLI can import them through `@commontools/runner`.

- [ ] **Step 4: Re-run the focused runner tests**

Run:

```bash
cd packages/runner
deno test test/tool-schema.test.ts test/callable-execution.test.ts test/llm-dialog-helpers.test.ts test/schema-format.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/runner/src/callable-execution.ts packages/runner/src/tool-schema.ts packages/runner/src/builtins/llm-dialog.ts packages/runner/src/index.ts packages/runner/test/callable-execution.test.ts packages/runner/test/tool-schema.test.ts
git commit -m "refactor: share callable runner helpers"
```

## Task 4: Build Dynamic Schema Flags And Help For `ct exec`

**Files:**
- Create: `packages/cli/lib/exec-schema.ts`
- Create: `packages/cli/test/exec.test.ts`

- [ ] **Step 1: Add failing parser/help tests for `ct exec` schema behavior**

Cover these cases in `packages/cli/test/exec.test.ts`:

1. defaulting to `invoke` for handlers and `run` for tools
2. top-level `--help` always works
3. post-verb `--help` is treated as an ordinary schema flag when the input schema has a `help` field, including a non-boolean `help` field that requires a value
4. top-level primitive flags parse correctly
5. array/object flags parse from JSON strings
6. `--json` is mutually exclusive with generated flags
7. required fields and enum validation errors are readable

Run:

```bash
cd packages/cli
deno test --allow-ffi --allow-read --allow-write --allow-run --allow-env test/exec.test.ts
```

Expected: FAIL because the parser/help machinery does not exist yet.

- [ ] **Step 2: Implement `packages/cli/lib/exec-schema.ts`**

Build a focused dynamic CLI layer:

```ts
interface ExecCommandSpec {
  verb: "invoke" | "run";
  inputSchema: JSONSchema;
  outputSchema?: JSONSchema;
  flags: Array<{
    name: string;
    flag: `--${string}`;
    type: "string" | "number" | "boolean" | "json";
    required: boolean;
    description?: string;
  }>;
}
```

Rules:

1. object schema => one flag per top-level property
2. non-object schema => single `--value <json>` flag
3. booleans support `--flag` and `--no-flag`
4. `--json <object>` bypasses generated flags
5. help rendering uses `schemaToTypeString(...)` for compact schema sections
6. `packages/cli/commands/exec.ts` must hand raw tail args to this parser instead of modeling `invoke` / `run` as Cliffy subcommands, otherwise Cliffy will steal post-verb `--help` before schema parsing can see it

- [ ] **Step 3: Render help in the precedence order the user asked for**

Implement:

1. `ct exec <file> --help` => top-level help
2. `ct exec <file> [invoke|run] --help` => schema field `help` if that field exists, parsed with the same rules as any other generated flag
3. otherwise post-verb `--help` falls back to command help

Document that top-level help is the always-available escape hatch.

- [ ] **Step 4: Re-run the focused `ct exec` test**

Run:

```bash
cd packages/cli
deno test --allow-ffi --allow-read --allow-write --allow-run --allow-env test/exec.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/lib/exec-schema.ts packages/cli/test/exec.test.ts
git commit -m "feat: add schema-driven exec flags and help"
```

## Task 5: Implement `ct exec` Path Resolution And Execution

**Files:**
- Create: `packages/cli/commands/exec.ts`
- Modify: `packages/cli/commands/main.ts`
- Create: `packages/cli/lib/exec.ts`

- [ ] **Step 1: Extend the `ct exec` tests with failing resolution/execution behavior**

Add focused cases for:

1. rejecting non-mounted paths
2. rejecting mounted non-callable files
3. resolving the backing piece ID from sibling `meta.json`, including de-duped display names like `notes-2`
4. resolving the backing piece and cell from a mounted `.handler` path
5. resolving the backing piece and cell from a mounted `.tool` path
6. explicit verb override still working
7. tool execution delegates to the shared runner callable helper instead of a CLI-local `runtime.run(...)` path

Keep these pure or lightly mocked; the real runtime path is covered in Task 6.

Run:

```bash
cd packages/cli
deno test --allow-ffi --allow-read --allow-write --allow-run --allow-env test/exec.test.ts
```

Expected: FAIL because there is no `ct exec` implementation.

- [ ] **Step 2: Implement mount-path resolution and callable lookup in `packages/cli/lib/exec.ts`**

Flow:

```ts
const mount = await findMountForPath(absFilePath);
const target = parseMountedCallablePath(mount.mountpoint, absFilePath);
const pieceMeta = await readMountedPieceMeta(target);
const manager = await loadManager({ apiUrl: mount.apiUrl, identity: mount.identity, space: target.spaceName });
const piece = await new PiecesController(manager).get(pieceMeta.id, false);
const rootCell = await piece[target.cellProp].getCell();
const callableCell = rootCell.key(target.cellKey).asSchemaFromLinks();
```

Do not guess piece IDs from mounted directory names and do not use daemon-only state.

- [ ] **Step 3: Implement the execution dispatch**

Handler:

1. derive input from flags / `--json`
2. invoke handlers by reusing the same piece-property write semantics as the FUSE flush path (`piece[cellProp].set(value, [cellKey])`)
3. wait for `manager.runtime.idle()` and then `manager.synced()` so `ct exec` sees the same completed handler effects that `ct piece call` already waits for
4. exit `0` with no stdout payload unless there is an intentional CLI message on stderr

Tool:

1. derive `pattern`, `extraParams`, and effective input schema
2. dispatch through the shared runner callable helper extracted in Task 3
3. wait for the result cell using the same timeout/completion semantics as the existing runner tool path
4. print the shared-helper serialized JSON to stdout only

Do not reimplement this with `runtime.idle()` plus `JSON.stringify(...)`; that path is weaker than the runner behavior already in production.

- [ ] **Step 4: Wire the command into `ct`**

Add `exec` to `packages/cli/commands/main.ts`, keeping the root help terse. In `packages/cli/commands/exec.ts`, parse the argv tail yourself (or the Cliffy equivalent that preserves raw args) instead of delegating `invoke` / `run` / `--help` handling to nested Cliffy commands:

```text
ct exec <mounted-callable-file> [invoke|run] [flags]
```

- [ ] **Step 5: Re-run the focused CLI test**

Run:

```bash
cd packages/cli
deno test --allow-ffi --allow-read --allow-write --allow-run --allow-env test/exec.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/commands/exec.ts packages/cli/commands/main.ts packages/cli/lib/exec.ts packages/cli/test/exec.test.ts
git commit -m "feat: add ct exec for mounted callables"
```

## Task 6: Prove The Real User Flow And Update Docs

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

1. one handler with required scalar flags
2. one pattern tool with one bound `extraParam`
3. one schema field literally named `help` with a non-boolean type to prove post-verb `--help` is treated as a schema flag, not intercepted as CLI help

The script should:

1. create a temp space and identity
2. deploy the fixture pattern
3. mount FUSE
4. assert `.handler` and `.tool` entries exist
5. `cat` each file and assert the first line starts with `#!` and contains ` exec`
6. assert both `ct exec <handler-file> --help` / `ct exec <tool-file> --help` and direct `<handler-file> --help` / `<tool-file> --help` show top-level help
7. assert both `ct exec <tool-file> run --help <value>` and direct `<tool-file> run --help <value>` are passed through as the schema field, not intercepted as CLI help
8. execute the mounted handler file directly
9. execute the mounted tool file directly
10. execute `ct exec` against both the handler and tool files with explicit verbs
11. assert the handler changed piece state
12. assert the tool printed the expected JSON
13. verify legacy `echo '{}' > file.handler` still works

Run:

```bash
cd packages/cli
API_URL=http://localhost:8000 CT_CLI_INTEGRATION_USE_LOCAL=1 ./integration/fuse-exec.sh
```

Expected: FAIL until the end-to-end surface is complete.

- [ ] **Step 2: Implement the fixture and integration assertions**

Keep the fixture minimal and deterministic. Avoid LLM-backed tools or external HTTP in this test. Make the tool result visibly depend on the input `help` field so the script can prove the user’s `run --help` precedence rule end to end.

- [ ] **Step 3: Update docs to match the shipped behavior**

Required doc changes:

1. FUSE layout now includes `*.tool`
2. synthesized `.json` siblings now render tools as `/tool` sigils instead of exposing raw wrapper internals
3. callable files are readable/executable
4. direct execution and `ct exec` examples are documented
5. handler-testing docs mention mounted handler execution as a fast local workflow

- [ ] **Step 4: Run the focused automated checks**

Run:

```bash
cd packages/fuse
deno test tree-builder.test.ts
```

Run:

```bash
cd packages/runner
deno test test/tool-schema.test.ts test/callable-execution.test.ts test/llm-dialog-helpers.test.ts test/schema-format.test.ts
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
git commit -m "docs: document exec-backed fuse callables"
```

## Final Verification

- [ ] `ct exec` works with explicit and implicit verbs for both `.handler` and `.tool`.
- [ ] Direct execution of mounted callable files works from the shell for both `.handler` and `.tool` because the files are executable and their first line is the generated shebang.
- [ ] Handler write-through (`echo ... > file.handler`) still works unchanged.
- [ ] `.tool` hides `pattern/extraParams` internals from the mounted tree.
- [ ] Tool help uses the normalized argument schema minus bound `extraParams`.
- [ ] Top-level help is always available, and post-verb `--help` becomes the schema field when `help` exists, both in `ct exec` and through direct file execution.
- [ ] Foreground mounts are discoverable by `ct exec`, not just background mounts.
