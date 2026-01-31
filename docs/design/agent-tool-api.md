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

### Integration with Common Tools runtime

To expose this as a pattern tool (using the existing `generateText` API):

```tsx
import { generateText } from "common:capabilities/llm";

// A sandbox-backed tool exposed to the pattern's LLM call
const result = generateText({
  prompt: "Set up a Node.js project and run the tests",
  tools: {
    shell: {
      description: "Run a shell command",
      inputSchema: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
      handler: async ({ command }) => {
        // Delegate to sandbox via service binding
        const res = await env.AGENT_SANDBOX.fetch("/tool/shell", {
          method: "POST",
          body: JSON.stringify({ command }),
        });
        return res.json();
      },
    },
  },
});
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
