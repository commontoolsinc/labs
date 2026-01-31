# Agent Tool API — Implementation Plan

Implementation plan for the sandbox agent tool API described in
[agent-tool-api.md](./agent-tool-api.md). Work is organized bottom-up:
infrastructure first, then built-ins, then pattern integration, then tests.

---

## Phase 1: Cloudflare Worker + Sandbox Backend

The HTTP service that manages sandbox containers. No pattern system dependency.

- [ ] **1.1 Project scaffolding**
  - Create `packages/sandbox-worker/` with Cloudflare Worker project structure
  - Add `wrangler.toml` with Sandbox Durable Object binding
  - Add `@cloudflare/sandbox` SDK dependency
  - Set up TypeScript config extending repo conventions

- [ ] **1.2 SandboxPool class**
  - Implement `SandboxPool` (lazy `Map<string, Sandbox>`, keyed by
    `${sessionId}:${name}`)
  - `get(name)` — get-or-create sandbox by name
  - `list()` — return active sandbox names + metadata
  - `destroy(name)` — tear down a specific sandbox
  - `destroyAll()` — session cleanup

- [ ] **1.3 Tool handler registry**
  - Implement `handleToolCall(pool, name, input) → ToolResult`
  - Implement individual tool handlers:
    - [ ] `shell` — exec with working_dir and timeout support
    - [ ] `read_file` — readFile with offset/limit
    - [ ] `write_file` — writeFile with append mode
    - [ ] `glob` — ls-based file listing
    - [ ] `browse` — exposePort, return URL
    - [ ] `sandbox_create` — ensure sandbox exists with image
    - [ ] `sandbox_list` — delegate to pool.list()
    - [ ] `transfer` — single file and recursive (tar) modes

- [ ] **1.4 HTTP routing layer**
  - `POST /tool/:name` — route to handleToolCall, JSON request/response
  - `POST /session` — create session, return session ID
  - `DELETE /session/:id` — destroy all sandboxes in session
  - `proxyToSandbox` pass-through for direct sandbox access
  - Auth: validate session tokens (design TBD, placeholder middleware)

- [ ] **1.5 File binding protocol**
  - Implement `writeInputFiles(sandbox, files)` — iterate files map, write
    cell-valued entries to sandbox before exec
  - Implement `readOutputFiles(sandbox, files)` — iterate files map, read
    `"text"`/`"json"` entries from sandbox after exec, parse as appropriate
  - Integrate into `shell` handler: write inputs → exec → read outputs
  - Return output files in `result.files`

- [ ] **1.6 Session lifecycle**
  - Idle timeout: track last activity per sandbox, sleep after configurable
    duration (default 10min)
  - Session expiry: clean up all sandboxes when session is destroyed
  - Reconnection: allow resuming a session by ID if sandboxes are still alive

---

## Phase 2: `exec()` Built-in

One-off sandbox execution as a pattern built-in, modeled after `fetchData()`.

- [ ] **2.1 Built-in registration**
  - Add `exec` to `packages/runner/src/builtins/index.ts` built-in registry
  - Define input/output JSON schemas:
    - Input: `{ command: string | string[], image?: string, files?: Record<string, any> }`
    - Output: `{ pending: boolean, result: ExecResult, error: any }`

- [ ] **2.2 Core exec action**
  - Implement `exec()` action function in `packages/runner/src/builtins/exec.ts`
  - Follow `fetchData` implementation pattern:
    - Read `inputsCell` to get command, image, files
    - Set `pending = true`
    - Call Worker API: write input files → exec commands → read output files
    - Set `result`, clear `pending`
    - Handle errors → set `error`, clear `pending`
    - Abort on input change (new AbortController per invocation)
  - Support `command` as string (single) or string[] (sequential execution)

- [ ] **2.3 File binding resolution**
  - At exec time, resolve `files` map entries:
    - Value is `Cell`/`OpaqueRef` → read `.get()`, serialize, send as input file
    - Value is `"text"` or `"json"` → mark as output, include in read-back list
    - Value is a plain string (not `"text"`/`"json"`) → treat as static input
      file content
  - Include resolved output files in `result.files`

- [ ] **2.4 Reactive re-execution**
  - Ensure `exec` re-runs when any reactive input changes:
    - `command` (if wrapped in `computed()`)
    - Any cell referenced in `files` map inputs
    - `image` (if reactive)
  - Abort in-flight request on re-trigger (same as `fetchData` abort logic)

- [ ] **2.5 Worker API client**
  - Create `packages/runner/src/builtins/sandbox-client.ts`
  - HTTP client for the sandbox Worker from Phase 1
  - Methods: `execWithFiles(sessionId, { command, image, files }) → ExecResult`
  - Handle session creation transparently (create-on-first-use)
  - Configuration: Worker URL from runtime config / environment

---

## Phase 3: `sandbox()` Built-in

Persistent sandbox as a built-in with `run` stream, modeled after `llmDialog`.

- [ ] **3.1 Built-in registration**
  - Add `sandbox` to built-in registry
  - Define schemas:
    - Input: `{ image?: string, files?: Record<string, any> }`
    - Output: `{ pending: boolean, status: string, history: ExecResult[],
      files: Record<string, any>, run: Stream, destroy: Stream }`

- [ ] **3.2 Stream setup (following llmDialog pattern)**
  - Create result cell with `{ $stream: true }` markers for `run` and `destroy`
  - Register `run` stream handler via `runtime.scheduler.addEventHandler`:
    - On `run.send({ command, files? })`:
      - Set `pending = true`
      - Resolve per-command file bindings (if any)
      - Call Worker API: exec command in persistent sandbox
      - Append `{ command, ...result }` to `history`
      - Set `pending = false`
  - Register `destroy` stream handler:
    - Call Worker API to destroy sandbox
    - Set `status = "destroyed"`

- [ ] **3.3 Persistent session management**
  - On first `sandbox()` call: create Worker session + sandbox, store session ID
    in internal cell (like llmDialog's `requestId`)
  - On pattern stop (`addCancel`): destroy sandbox via Worker API
  - Handle sandbox sleep/wake transparently

- [ ] **3.4 Continuous file bindings**
  - Input bindings (cell → file):
    - Set up reactive subscription on each cell-valued `files` entry
    - On cell change → call Worker `write_file` to update sandbox file
  - Output bindings (file → cell):
    - Polling strategy: periodically call Worker `read_file`, update
      `result.files[path]` cell if content changed
    - Alternative: use sandbox exec `inotifywait` + long-poll (evaluate
      feasibility with Cloudflare Sandbox)
    - Parse as `"json"` or `"text"` per binding declaration

- [ ] **3.5 `tools()` method**
  - Return LLM tool definitions (same JSON schemas from design doc) with
    handlers pre-bound to this sandbox's `run` stream
  - `shell` tool → `run.send({ command })`
  - `read_file` tool → exec `cat` via `run`, parse output
  - `write_file` tool → exec `cat > file` via `run` with file binding
  - `glob` tool → exec `ls -d` via `run`
  - `browse` tool → Worker `browse` API call
  - Ensure tool results are returned to the LLM (integrate with
    llmToolExecutionHelpers flow)

---

## Phase 4: TypeScript Compiler Integration

Make the built-ins work with the existing pattern compilation pipeline.

- [ ] **4.1 Transformer support**
  - Update `packages/ts-transformers/` to recognize `exec()` and `sandbox()`
    calls
  - Compile file bindings: distinguish cell references from string literals
    at transform time
  - Ensure `computed()` expressions inside `files` maps are handled correctly

- [ ] **4.2 Module builder integration**
  - Add `exec` and `sandbox` to `packages/runner/src/builder/module.ts`
  - Wire up argument schemas so the reactive graph connects inputs correctly
  - Ensure `exec` creates a node with correct read/write dependency tracking

- [ ] **4.3 Type exports**
  - Add `ExecResult`, `SandboxState`, and related types to
    `packages/api/index.ts`
  - Export `exec` and `sandbox` type signatures alongside `fetchData` and
    `computed`
  - Ensure `OpaqueRef` unwrapping works for `result.files` property access

---

## Phase 5: Testing

- [ ] **5.1 Worker unit tests**
  - Test `SandboxPool` lifecycle (create, get, list, destroy)
  - Test each tool handler with mocked Sandbox SDK
  - Test file binding resolution (input write, output read, JSON parsing)
  - Test transfer (single file + recursive)
  - Test error handling (command failure, file not found, sandbox not found)

- [ ] **5.2 `exec()` built-in tests**
  - Test basic command execution (pending → result)
  - Test reactive re-execution on input change
  - Test abort on input change during in-flight request
  - Test file bindings: cell inputs written, outputs read back
  - Test static string inputs (scripts) vs cell inputs
  - Test error propagation
  - Test `command` as string vs string[]

- [ ] **5.3 `sandbox()` built-in tests**
  - Test `run.send()` → pending → history append → pending clear
  - Test `destroy.send()` → status change
  - Test continuous input file bindings (cell change → file rewrite)
  - Test continuous output file bindings (file change → cell update)
  - Test `tools()` returns valid LLM tool schemas
  - Test pattern lifecycle (addCancel cleans up sandbox)

- [ ] **5.4 Integration tests**
  - Test `exec()` in a compiled pattern (end-to-end)
  - Test `sandbox()` in a compiled pattern with `run` stream
  - Test `sandbox().tools()` with `generateText` (LLM tool loop)
  - Test `exec → computed → exec` pipeline chaining
  - Test `fetchData → exec` composition

- [ ] **5.5 Mock sandbox for local dev**
  - Create `packages/sandbox-worker/src/mock.ts` — in-memory sandbox that
    uses local shell execution (for dev/test without Cloudflare)
  - Configurable via environment flag (`SANDBOX_MODE=mock`)
  - Implement same `Sandbox` interface: `exec`, `readFile`, `writeFile`

---

## Phase 6: Documentation & Patterns

- [ ] **6.1 Developer documentation**
  - Add `docs/common/capabilities/sandbox.md` — usage guide for `exec()` and
    `sandbox()` with examples
  - Add `docs/common/concepts/sandbox.md` — explanation of file bindings,
    persistent vs one-off, stream model
  - Update `docs/common/INTRODUCTION.md` — mention sandbox capability

- [ ] **6.2 Example patterns**
  - Python runner (basic `exec`, reactive re-run)
  - TypeScript compiler (file bindings, input + output)
  - Interactive REPL (persistent `sandbox`, `run` stream, history)
  - CSV pipeline (multi-stage `exec` chain via `computed`)
  - Dev server with live config (continuous file bindings)
  - LLM coding agent (persistent `sandbox` + `generateText` + `tools()`)

---

## Dependency Graph

```
Phase 1 (Worker)
  │
  ├──▶ Phase 2 (exec built-in) ──▶ Phase 4 (compiler)
  │                                     │
  └──▶ Phase 3 (sandbox built-in) ──────┘
                                        │
                                        ▼
                                  Phase 5 (tests)
                                        │
                                        ▼
                                  Phase 6 (docs)
```

Phases 2 and 3 can proceed in parallel once Phase 1 is complete.
Phase 4 depends on both 2 and 3. Phase 5 can start partially during 2/3.

## Open Questions

- [ ] **Auth model**: How are sandbox sessions authenticated? Worker-to-Worker
  service binding (no auth needed) vs external HTTP (needs tokens)?
- [ ] **Image selection**: Can Cloudflare Sandbox use arbitrary Docker images,
  or is there a fixed set? Affects `image` parameter design.
- [ ] **Output file polling**: What interval for continuous output bindings?
  Is inotify-over-exec viable in Cloudflare Sandbox?
- [ ] **Binary files**: Current design is text-only for file bindings. Do we
  need base64 encoding for binary files (images, compiled artifacts)?
- [ ] **Cost/limits**: Cloudflare Sandbox pricing model — per-container,
  per-minute, per-exec? Affects idle timeout defaults and pool size limits.
- [ ] **Streaming stdout**: Should `exec()` support streaming partial stdout
  (like `fetchData`'s partial results), or is complete-on-finish sufficient?
