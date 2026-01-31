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

Sandboxes map into the reactive pattern system at two levels:

1. **One-off sandboxes** — fire-and-forget execution, result flows into a cell.
   The sandbox is discarded after the command completes. Think `computed()` but
   backed by a container.

2. **Persistent sandboxes** — a long-lived cell that represents a running
   container. The agent (or pattern) can issue commands over time. Think
   `Writable<>` — you read its state and send it commands.

#### Primitive: `sandbox()` capability

A new built-in capability alongside `generateText` and `generateObject`:

```tsx
import { sandbox } from "common:capabilities/sandbox";
```

##### One-off execution

Returns a reactive cell that resolves to the command output. The container is
created, runs the command, and is destroyed. No sandbox management required.

```tsx
// Simple: run a command, get stdout as a cell
const result = sandbox({
  command: "python3 -c 'print(2**256)'",
  image: "python:3.12",
});
// result.get() → { stdout: "115792...", stderr: "", exit_code: 0 }
```

This is sugar for: create sandbox → exec → read result → destroy. The cell is
pending until the command completes, then reactive updates stop.

Internally this compiles to a handler that calls the Worker API. The runtime
treats it like any other async cell — UI shows a loading state until it
resolves.

##### One-off with file I/O

For commands that produce file artifacts, use `files` to declare what to
extract:

```tsx
const build = sandbox({
  commands: [
    "npm init -y",
    "npm install typescript",
    "echo 'export const x: number = 42;' > index.ts",
    "npx tsc --outDir dist",
  ],
  files: ["dist/index.js", "dist/index.d.ts"],
  image: "node:22",
});
// build.get() → {
//   stdout: "...",
//   exit_code: 0,
//   files: {
//     "dist/index.js": "\"use strict\";\nObject.defineProperty...",
//     "dist/index.d.ts": "export declare const x: number;\n"
//   }
// }
```

The `files` array tells the runtime which paths to `readFile` before tearing
down the container. Results land in the cell as a `Record<string, string>`.

##### Persistent sandbox as a cell

A persistent sandbox is a `Writable` cell. It stays alive and accepts commands
over time via a `Stream`. This is the natural fit for an LLM agent that needs
to issue many commands in a loop.

```tsx
import { sandbox, type SandboxCell } from "common:capabilities/sandbox";

export default pattern<{ task: string }, { sandbox: SandboxCell }>(
  ({ task }) => {
    // Create a persistent sandbox — stays alive across handler calls
    const sb = sandbox.persistent({ image: "node:22" });

    // sb is a cell with shape:
    // {
    //   status: "running" | "sleeping" | "destroyed",
    //   history: Array<{ command: string, stdout: string, exit_code: number }>,
    //   previewUrl: string | null,
    // }

    // Issue commands via the exec stream
    const setupResult = sb.exec("git clone https://github.com/user/repo && cd repo && npm install");

    // Use in LLM tools — this is the key integration point
    const answer = generateText({
      prompt: task,
      tools: {
        shell: sb.tool("shell"),      // pre-bound to this sandbox
        readFile: sb.tool("read_file"),
        writeFile: sb.tool("write_file"),
        browse: sb.tool("browse"),
      },
    });

    return {
      [NAME]: "Dev Agent",
      [UI]: (
        <div>
          <div>{answer}</div>
          <div>Sandbox: {sb.status}</div>
          {sb.previewUrl && <iframe src={sb.previewUrl} />}
        </div>
      ),
      sandbox: sb,
      answer,
    };
  },
);
```

The `.tool(name)` method returns a tool definition compatible with
`generateText`'s `tools` parameter — it has the right `description`,
`inputSchema`, and a `handler` that routes to this specific sandbox instance.
This means the LLM's tool calls go directly to the right container without
the agent needing to specify a sandbox name.

#### Multi-sandbox pattern

For agents that need multiple sandboxes, use `sandbox.pool()`:

```tsx
const pool = sandbox.pool();

// The LLM gets sandbox management tools automatically
const answer = generateText({
  prompt: "Build a frontend in Node and a backend in Python, then combine them",
  tools: {
    ...pool.tools(),
    // Expands to: shell, read_file, write_file, glob, browse,
    //             sandbox_create, sandbox_list, transfer
    // Each tool accepts the `sandbox` param from the schema above
  },
});
```

`pool.tools()` returns all 8 tool definitions from the Tool Definitions section
above. The LLM controls which sandboxes exist and routes commands to them via
the `sandbox` parameter in each tool call.

The pool itself is a cell:

```tsx
pool.get()
// → {
//   sandboxes: {
//     "frontend": { status: "running", image: "node:22" },
//     "backend": { status: "running", image: "python:3.12" },
//   }
// }
```

#### Extracting files into cells

The bridge between sandbox filesystems and the cell world:

```tsx
// Watch a file in a persistent sandbox — cell updates when file changes
const config = sb.watch("/home/user/app/config.json", { parse: "json" });
// config.get() → { port: 3000, debug: true }

// One-time read into a cell
const readme = sb.readFile("/home/user/app/README.md");
// readme.get() → "# My App\n..."

// Write a cell's value into the sandbox
sb.writeFile("/home/user/app/data.json", JSON.stringify(someCell.get()));
```

`sb.watch()` is reactive — it polls or uses inotify under the hood. When the
file changes in the sandbox, the cell updates, which can trigger downstream
`computed()` or re-render UI. This connects the sandbox's mutable filesystem
to the pattern's reactive graph.

#### Summary of API surface in patterns

| API | Mode | Returns | Sandbox lifetime |
|-----|------|---------|-----------------|
| `sandbox({ command })` | One-off | `Cell<ExecResult>` | Destroyed after command |
| `sandbox({ commands, files })` | One-off | `Cell<ExecResult & { files }>` | Destroyed after extraction |
| `sandbox.persistent({ image })` | Persistent | `SandboxCell` | Until pattern is destroyed |
| `sandbox.pool()` | Multi | `SandboxPoolCell` | Until pattern is destroyed |
| `sb.exec(cmd)` | — | `Cell<ExecResult>` | — |
| `sb.tool(name)` | — | Tool definition for `generateText` | — |
| `sb.watch(path)` | — | `Cell<string>` (reactive) | — |
| `sb.readFile(path)` | — | `Cell<string>` | — |
| `sb.writeFile(path, content)` | — | `void` | — |
| `pool.tools()` | — | All 8 tool definitions | — |

#### Type definitions

```typescript
interface ExecResult {
  stdout: string;
  stderr: string;
  exit_code: number;
}

interface SandboxCell extends Cell<SandboxState> {
  exec(command: string): Cell<ExecResult>;
  tool(name: "shell" | "read_file" | "write_file" | "glob" | "browse"): LLMToolSchema;
  watch(path: string, opts?: { parse?: "json" | "text" }): Cell<unknown>;
  readFile(path: string): Cell<string>;
  writeFile(path: string, content: string): void;
  destroy(): void;
}

interface SandboxState {
  status: "running" | "sleeping" | "destroyed";
  history: ExecResult[];
  previewUrl: string | null;
}

interface SandboxPoolCell extends Cell<{ sandboxes: Record<string, SandboxState> }> {
  get(name: string): SandboxCell;
  tools(): Record<string, LLMToolSchema>;
}
```

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
