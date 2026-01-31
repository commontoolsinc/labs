# Agent Tool API — Cloudflare Sandbox

A compact tool-use interface for LLM agents backed by Cloudflare Sandbox
containers. Designed to be small enough to include in a system prompt or
reference by name.

## Concepts

An agent session manages a **pool** of named sandboxes. Every filesystem tool
takes an optional `sandbox` parameter (defaults to `"default"`). The agent can
spin up specialized sandboxes (one for a build, one for a database, one for
tests) and move files between them.

```
┌─────────────────────────────────────┐
│            Agent Loop               │
│                                     │
│  tool_use: shell                    │
│    { sandbox: "builder", ... }  ────┼──▶  Sandbox "builder"
│                                     │
│  tool_use: shell                    │
│    { sandbox: "db", ... }       ────┼──▶  Sandbox "db"
│                                     │
│  tool_use: transfer                 │
│    { from: "builder",               │
│      to: "db", ... }           ────┼──▶  read "builder" → write "db"
└─────────────────────────────────────┘
```

## Tool Definitions

An agent receives these tools as a JSON schema array. Each tool maps 1:1 to a
Sandbox SDK call. All filesystem/exec tools accept an optional `sandbox` field
(string, defaults to `"default"`).

### `shell`

Run a shell command. Returns stdout, stderr, and exit code.

```json
{
  "name": "shell",
  "description": "Execute a shell command in the sandbox.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "sandbox": { "type": "string", "default": "default" },
      "command": { "type": "string" },
      "timeout_ms": { "type": "number", "default": 30000 },
      "working_dir": { "type": "string", "default": "/home/user" }
    },
    "required": ["command"]
  }
}
```

Returns: `{ stdout: string, stderr: string, exit_code: number }`

### `read_file`

```json
{
  "name": "read_file",
  "description": "Read a file from the sandbox filesystem.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "sandbox": { "type": "string", "default": "default" },
      "path": { "type": "string" },
      "offset": { "type": "number", "description": "Byte offset" },
      "limit": { "type": "number", "description": "Max bytes to read" }
    },
    "required": ["path"]
  }
}
```

Returns: `{ content: string, size: number }`

### `write_file`

```json
{
  "name": "write_file",
  "description": "Write content to a file in the sandbox.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "sandbox": { "type": "string", "default": "default" },
      "path": { "type": "string" },
      "content": { "type": "string" },
      "append": { "type": "boolean", "default": false }
    },
    "required": ["path", "content"]
  }
}
```

Returns: `{ ok: true, size: number }`

### `glob`

```json
{
  "name": "glob",
  "description": "List files matching a glob pattern.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "sandbox": { "type": "string", "default": "default" },
      "pattern": { "type": "string" },
      "cwd": { "type": "string", "default": "/home/user" }
    },
    "required": ["pattern"]
  }
}
```

Returns: `{ files: string[] }`

### `browse`

Expose a sandbox port and return a preview URL. Useful for running dev servers
or viewing generated HTML.

```json
{
  "name": "browse",
  "description": "Expose a port from the sandbox and return a public URL.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "sandbox": { "type": "string", "default": "default" },
      "port": { "type": "number" }
    },
    "required": ["port"]
  }
}
```

Returns: `{ url: string }`

### `sandbox_create`

Create (or ensure) a named sandbox with an optional Docker image.

```json
{
  "name": "sandbox_create",
  "description": "Create a named sandbox. No-op if it already exists.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "sandbox": { "type": "string" },
      "image": { "type": "string", "default": "node:22" },
      "sleep_after_ms": { "type": "number", "default": 600000 }
    },
    "required": ["sandbox"]
  }
}
```

Returns: `{ sandbox: string, created: boolean }`

### `sandbox_list`

```json
{
  "name": "sandbox_list",
  "description": "List all active sandboxes in this session.",
  "inputSchema": { "type": "object", "properties": {} }
}
```

Returns: `{ sandboxes: [{ name: string, image: string, status: "running" | "sleeping" }] }`

### `transfer`

Copy a file (or directory tree) between two sandboxes. The data passes through
the Worker — sandboxes don't talk to each other directly.

```json
{
  "name": "transfer",
  "description": "Copy files between sandboxes.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "from_sandbox": { "type": "string" },
      "from_path": { "type": "string" },
      "to_sandbox": { "type": "string" },
      "to_path": { "type": "string" },
      "recursive": { "type": "boolean", "default": false }
    },
    "required": ["from_sandbox", "from_path", "to_sandbox", "to_path"]
  }
}
```

Returns: `{ ok: true, bytes: number }`

For large transfers, prefer `shell` with tar piping (see Implementation notes).

## Implementation

### Server-side (Cloudflare Worker + Sandbox)

```typescript
import { Sandbox, getSandbox } from "@cloudflare/sandbox";

type ToolResult = { content: string; isError?: boolean };

/**
 * SandboxPool manages named sandboxes for a single agent session.
 * Each sandbox is a Cloudflare container identified by a session-scoped name.
 */
class SandboxPool {
  private sandboxes = new Map<string, Sandbox>();

  constructor(
    private ns: DurableObjectNamespace<Sandbox>,
    private sessionId: string,
  ) {}

  /** Get or create a sandbox by name. */
  get(name: string = "default"): Sandbox {
    let sb = this.sandboxes.get(name);
    if (!sb) {
      sb = getSandbox(this.ns, `${this.sessionId}:${name}`);
      this.sandboxes.set(name, sb);
    }
    return sb;
  }

  list(): { name: string }[] {
    return [...this.sandboxes.keys()].map((name) => ({ name }));
  }
}

/** Registry: tool name → handler */
const tools: Record<
  string,
  (pool: SandboxPool, input: Record<string, unknown>) => Promise<ToolResult>
> = {
  async shell(pool, { sandbox, command, timeout_ms, working_dir }) {
    const sb = pool.get(sandbox as string);
    const cmd = working_dir
      ? `cd ${working_dir} && ${command}`
      : (command as string);
    const result = await sb.exec(cmd);
    return {
      content: JSON.stringify({
        stdout: result.stdout,
        stderr: result.stderr ?? "",
        exit_code: result.success ? 0 : 1,
      }),
      isError: !result.success,
    };
  },

  async read_file(pool, { sandbox, path }) {
    const result = await pool.get(sandbox as string).readFile(path as string);
    return { content: result.content };
  },

  async write_file(pool, { sandbox, path, content, append }) {
    const sb = pool.get(sandbox as string);
    if (append) {
      const existing = await sb.readFile(path as string).catch(() => ({
        content: "",
      }));
      await sb.writeFile(path as string, existing.content + content);
    } else {
      await sb.writeFile(path as string, content as string);
    }
    return { content: JSON.stringify({ ok: true }) };
  },

  async glob(pool, { sandbox, pattern, cwd }) {
    const sb = pool.get(sandbox as string);
    const dir = (cwd as string) ?? "/home/user";
    const result = await sb.exec(`cd ${dir} && ls -d ${pattern} 2>/dev/null`);
    const files = result.stdout.split("\n").filter(Boolean);
    return { content: JSON.stringify({ files }) };
  },

  async browse(pool, { sandbox, port }) {
    const url = await pool.get(sandbox as string).exposePort(port as number);
    return { content: JSON.stringify({ url }) };
  },

  async sandbox_create(pool, { sandbox, image }) {
    const sb = pool.get(sandbox as string);
    // Ensure container is running (exec a no-op to wake it)
    if (image) {
      // Image selection would be configured at DO binding level;
      // here we just ensure the sandbox exists.
      await sb.exec("true");
    }
    return {
      content: JSON.stringify({ sandbox, created: true }),
    };
  },

  async sandbox_list(pool) {
    return { content: JSON.stringify({ sandboxes: pool.list() }) };
  },

  async transfer(pool, { from_sandbox, from_path, to_sandbox, to_path, recursive }) {
    const src = pool.get(from_sandbox as string);
    const dst = pool.get(to_sandbox as string);

    if (recursive) {
      // tar stream: read from source, write to dest
      const tar = await src.exec(`tar -cf - -C $(dirname ${from_path}) $(basename ${from_path})`);
      await dst.writeFile("/tmp/_transfer.tar", tar.stdout);
      await dst.exec(`mkdir -p $(dirname ${to_path}) && tar -xf /tmp/_transfer.tar -C $(dirname ${to_path}) && rm /tmp/_transfer.tar`);
      return { content: JSON.stringify({ ok: true }) };
    }

    const file = await src.readFile(from_path as string);
    await dst.writeFile(to_path as string, file.content);
    return {
      content: JSON.stringify({ ok: true, bytes: file.content.length }),
    };
  },
};

/** Process a single tool call from the LLM. */
export async function handleToolCall(
  pool: SandboxPool,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const handler = tools[name];
  if (!handler) return { content: `Unknown tool: ${name}`, isError: true };
  try {
    return await handler(pool, input);
  } catch (err: any) {
    return { content: err.message, isError: true };
  }
}
```

### Agent loop (sketch)

```typescript
import Anthropic from "@anthropic-ai/sdk";

const TOOL_SCHEMAS = [
  /* the JSON schemas from above */
];

async function agentLoop(
  client: Anthropic,
  pool: SandboxPool,
  userMessage: string,
) {
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userMessage },
  ];

  while (true) {
    const response = await client.messages.create({
      model: "claude-sonnet-4-5-20250514",
      max_tokens: 4096,
      tools: TOOL_SCHEMAS,
      messages,
    });

    // Collect text + tool_use blocks
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      // Done — return final text
      return response.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
    }

    // Execute each tool call
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      const result = await handleToolCall(pool, block.name, block.input);
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: result.content,
        is_error: result.isError,
      });
    }

    messages.push({ role: "user", content: toolResults });
  }
}
```

### Integration with Common Tools Patterns

Sandbox operations are **built-ins** at the same level as `computed()`,
`fetchData()`, and `lift()`. They follow the same conventions:

- Imported from `"commontools"`
- Accept reactive inputs (cells / `OpaqueRef`)
- Return `OpaqueRef<{ pending, result, error }>` (like `fetchData`)
- Re-execute when reactive inputs change
- Compose freely with `computed()` and each other

```tsx
import { exec, readSandboxFile, writeSandboxFile, sandbox } from "commontools";
```

#### `exec()` — the core built-in

The direct analog of `fetchData()` but for shell commands. Takes reactive
params, returns `{ pending, result, error }`.

```tsx
exec(params: Opaque<{
  command: string | string[];     // single command or sequence
  image?: string;                 // default: "node:22"
  files?: string[];               // paths to extract after execution
  result?: ExecResult;            // type hint for result schema
}>) → OpaqueRef<{ pending: boolean; result: ExecResult; error: any }>
```

Where:

```typescript
interface ExecResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  files?: Record<string, string>; // populated if `files` was specified
}
```

Usage is identical to `fetchData` — you call it in the pattern body, it returns
a reactive reference, and you read `.result`, `.pending`, `.error` in JSX or
downstream `computed()` calls.

##### Basic examples

```tsx
import { exec, computed } from "commontools";

export default pattern<{ code: string }>(({ code }) => {
  // Runs Python. Re-executes when `code` changes.
  const run = exec({
    command: computed(() => `python3 -c '${code.get()}'`),
    image: "python:3.12",
  });

  return {
    [NAME]: "Python Runner",
    [UI]: (
      <div>
        {run.pending && <ct-loader />}
        {run.result && <pre>{run.result.stdout}</pre>}
        {run.error && <pre class="error">{run.error}</pre>}
      </div>
    ),
  };
});
```

##### Multi-step with file extraction

```tsx
export default pattern<{ sourceCode: string }>(({ sourceCode }) => {
  const build = exec({
    command: [
      "npm init -y",
      "npm install typescript",
      computed(() => `cat <<'SRC' > index.ts\n${sourceCode.get()}\nSRC`),
      "npx tsc --outDir dist",
    ],
    files: ["dist/index.js", "dist/index.d.ts"],
    image: "node:22",
  });

  return {
    [NAME]: "TypeScript Compiler",
    [UI]: (
      <div>
        {build.pending && <ct-loader show-elapsed />}
        {build.result?.files && (
          <div>
            <h3>Compiled JS</h3>
            <pre>{build.result.files["dist/index.js"]}</pre>
          </div>
        )}
      </div>
    ),
    js: computed(() => build.result?.files?.["dist/index.js"] ?? ""),
    dts: computed(() => build.result?.files?.["dist/index.d.ts"] ?? ""),
  };
});
```

##### Composing exec with computed and fetchData

These built-ins compose the same way `computed` and `fetchData` do — through
reactive dependencies:

```tsx
export default pattern<{ repoUrl: string }>(({ repoUrl }) => {
  // 1. Fetch the repo metadata (existing built-in)
  const meta = fetchData({
    url: computed(() => `https://api.github.com/repos/${repoUrl.get()}`),
    mode: "json",
  });

  // 2. Clone and count lines (sandbox built-in)
  const stats = exec({
    command: computed(() =>
      `git clone --depth 1 https://github.com/${repoUrl.get()} /tmp/repo && ` +
      `find /tmp/repo -name '*.ts' | xargs wc -l | tail -1`
    ),
    image: "alpine/git",
  });

  // 3. Combine both with computed (plain built-in)
  const summary = computed(() => ({
    name: meta.result?.name ?? "loading...",
    stars: meta.result?.stargazers_count ?? 0,
    tsLines: parseInt(stats.result?.stdout ?? "0"),
  }));

  return {
    [NAME]: computed(() => `Repo: ${summary.get().name}`),
    [UI]: (
      <div>
        <p>Stars: {summary.stars}</p>
        <p>TypeScript lines: {summary.tsLines}</p>
      </div>
    ),
    summary,
  };
});
```

No special wiring — `exec` is just another node in the reactive graph.

#### `readSandboxFile()` and `writeSandboxFile()`

For when you only need file I/O without running commands. Same shape as
`fetchData`.

```tsx
readSandboxFile(params: Opaque<{
  sandbox: string;                // sandbox name (from a persistent sandbox)
  path: string;
  mode?: "text" | "json";
}>) → OpaqueRef<{ pending: boolean; result: string | object; error: any }>

writeSandboxFile(params: Opaque<{
  sandbox: string;
  path: string;
  content: string;
}>) → OpaqueRef<{ pending: boolean; result: { ok: true }; error: any }>
```

#### `sandbox()` — persistent sandbox built-in

For long-lived containers. Returns a handle with `.exec()` that itself returns
the same `{ pending, result, error }` shape.

```tsx
sandbox(params: Opaque<{
  image?: string;
}>) → OpaqueRef<SandboxHandle>

interface SandboxHandle {
  status: "running" | "sleeping" | "destroyed";
  name: string;
  exec(command: string): OpaqueRef<{ pending: boolean; result: ExecResult; error: any }>;
  readFile(path: string): OpaqueRef<{ pending: boolean; result: string; error: any }>;
  writeFile(path: string, content: string): OpaqueRef<{ pending: boolean; result: { ok: true }; error: any }>;
  tools(): Record<string, LLMToolSchema>;  // for generateText integration
}
```

##### Interactive REPL pattern

```tsx
import { sandbox, handler, Writable } from "commontools";

export default pattern<
  { language: "python" | "node" },
  { history: ExecResult[] }
>(({ language }) => {
  const sb = sandbox({
    image: computed(() => language.get() === "python" ? "python:3.12" : "node:22"),
  });

  const history = Writable.of<ExecResult[]>([]);

  const run = handler<{ command: string }>(({ command }) => {
    const result = sb.exec(command);
    // result has .pending, .result, .error — same as exec()
    history.push(result.result);
  });

  return {
    [NAME]: "Shell",
    [UI]: (
      <div>
        {history.map((entry) => (
          <div>
            <pre>{entry.stdout}</pre>
            {entry.stderr && <pre class="stderr">{entry.stderr}</pre>}
          </div>
        ))}
        <common-input onsubmit={run} placeholder="$ " />
      </div>
    ),
    history,
    run,
  };
});
```

##### Pipeline: exec → computed → exec

Chaining sandbox calls through `computed` is the natural way to build
multi-stage pipelines:

```tsx
export default pattern<{ csvUrl: string }>(({ csvUrl }) => {
  // Stage 1: fetch CSV
  const csv = fetchData({ url: csvUrl, mode: "text" });

  // Stage 2: process with Python (only runs when csv.result is ready)
  const analysis = exec({
    command: computed(() => {
      const data = csv.result;
      if (!data) return "echo 'waiting for data'";
      return `python3 -c "
import json, csv, io, sys
rows = list(csv.DictReader(io.StringIO('''${data}''')))
print(json.dumps({'count': len(rows), 'cols': list(rows[0].keys()) if rows else []}))"`;
    }),
    image: "python:3.12",
  });

  // Stage 3: generate chart with R (only runs when analysis is ready)
  const chart = exec({
    command: computed(() => {
      const stats = analysis.result;
      if (!stats || stats.exit_code !== 0) return "echo 'waiting'";
      return `Rscript -e "cat(jsonlite::toJSON(list(ready=TRUE)))"`;
    }),
    files: ["/tmp/chart.svg"],
    image: "r-base:latest",
  });

  return {
    [NAME]: "CSV Analyzer",
    [UI]: (
      <div>
        {csv.pending && <div>Fetching CSV... <ct-loader /></div>}
        {analysis.pending && <div>Analyzing... <ct-loader /></div>}
        {chart.pending && <div>Charting... <ct-loader /></div>}
        {chart.result?.files && (
          <div innerHTML={chart.result.files["/tmp/chart.svg"]} />
        )}
      </div>
    ),
  };
});
```

Each stage waits for its upstream dependency through `computed()`. No special
sequencing — the reactive graph handles it.

##### With LLM tools

A persistent sandbox plugs into `generateText` the same way `patternTool`
does:

```tsx
const sb = sandbox({ image: "node:22" });

const answer = generateText({
  prompt: task,
  tools: {
    ...sb.tools(),
    // Expands to: shell, read_file, write_file, glob, browse
    // Each pre-bound to this sandbox instance
  },
});
```

#### Summary: built-in family

| Built-in | Analogous to | Inputs | Returns |
|----------|-------------|--------|---------|
| `computed(fn)` | — | closure over cells | `OpaqueRef<T>` |
| `fetchData({ url })` | — | reactive URL | `OpaqueRef<{ pending, result, error }>` |
| `exec({ command })` | `fetchData` | reactive command + image | `OpaqueRef<{ pending, result, error }>` |
| `readSandboxFile({ sandbox, path })` | `fetchData` | sandbox name + path | `OpaqueRef<{ pending, result, error }>` |
| `writeSandboxFile({ sandbox, path, content })` | `fetchData` | sandbox name + path + content | `OpaqueRef<{ pending, result, error }>` |
| `sandbox({ image })` | `Writable.of()` | reactive image | `OpaqueRef<SandboxHandle>` |

All follow the same contract: reactive inputs in, `OpaqueRef` out, automatic
re-execution on dependency change, `pending`/`result`/`error` for async status.

## Design Notes

- **Stateless tools, stateful sandboxes.** Each tool call is a pure function of
  its inputs plus sandbox state. Containers persist across calls within a session
  (default 10min idle timeout). The `SandboxPool` lazily creates containers on
  first use — no upfront allocation.
- **Sandboxes are isolated from each other.** They share no filesystem or
  network namespace. `transfer` is the only way to move data between them, and
  it routes through the Worker. For bulk transfers, use `shell` with tar/gzip.
- **No streaming in tools.** Tool results are returned as complete strings. For
  long-running commands, the agent can poll or use `timeout_ms`.
- **Security boundary.** Each Cloudflare container is its own trust boundary.
  The agent cannot escape it. Network access can be restricted per-sandbox.
- **Compact reference.** The 8 tools above cover ~95% of multi-sandbox agent
  tasks. The `sandbox` param defaults to `"default"` so single-sandbox use
  cases don't pay any complexity cost.

### Example multi-sandbox workflow

```
Agent: "Build the frontend and backend separately, then combine"

1. sandbox_create({ sandbox: "frontend", image: "node:22" })
2. sandbox_create({ sandbox: "backend", image: "python:3.12" })
3. shell({ sandbox: "frontend", command: "npm create vite@latest app -- --template react && cd app && npm install && npm run build" })
4. shell({ sandbox: "backend", command: "pip install fastapi uvicorn && mkdir app" })
5. write_file({ sandbox: "backend", path: "/home/user/app/main.py", content: "..." })
6. transfer({ from_sandbox: "frontend", from_path: "/home/user/app/dist", to_sandbox: "backend", to_path: "/home/user/app/static", recursive: true })
7. shell({ sandbox: "backend", command: "cd /home/user/app && uvicorn main:app --host 0.0.0.0 --port 8000 &" })
8. browse({ sandbox: "backend", port: 8000 })
```
