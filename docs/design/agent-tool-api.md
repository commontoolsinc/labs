# Agent Tool API — Cloudflare Sandbox

A compact tool-use interface for LLM agents backed by Cloudflare Sandbox
containers. Designed to be small enough to include in a system prompt or
reference by name.

## Tool Definitions

An agent receives these tools as a JSON schema array. Each tool maps 1:1 to a
Sandbox SDK call.

### `shell`

Run a shell command. Returns stdout, stderr, and exit code.

```json
{
  "name": "shell",
  "description": "Execute a shell command in the sandbox.",
  "inputSchema": {
    "type": "object",
    "properties": {
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
      "port": { "type": "number" }
    },
    "required": ["port"]
  }
}
```

Returns: `{ url: string }`

## Implementation

### Server-side (Cloudflare Worker + Sandbox)

```typescript
import { Sandbox, getSandbox } from "@cloudflare/sandbox";

type ToolResult = { content: string; isError?: boolean };

/** Registry: tool name → handler */
const tools: Record<
  string,
  (sandbox: Sandbox, input: Record<string, unknown>) => Promise<ToolResult>
> = {
  async shell(sandbox, { command, timeout_ms, working_dir }) {
    const cmd = working_dir
      ? `cd ${working_dir} && ${command}`
      : (command as string);
    const result = await sandbox.exec(cmd);
    return {
      content: JSON.stringify({
        stdout: result.stdout,
        stderr: result.stderr ?? "",
        exit_code: result.success ? 0 : 1,
      }),
      isError: !result.success,
    };
  },

  async read_file(sandbox, { path }) {
    const result = await sandbox.readFile(path as string);
    return { content: result.content };
  },

  async write_file(sandbox, { path, content, append }) {
    if (append) {
      const existing = await sandbox.readFile(path as string).catch(() => ({
        content: "",
      }));
      await sandbox.writeFile(path as string, existing.content + content);
    } else {
      await sandbox.writeFile(path as string, content as string);
    }
    return { content: JSON.stringify({ ok: true }) };
  },

  async glob(sandbox, { pattern, cwd }) {
    const dir = (cwd as string) ?? "/home/user";
    const result = await sandbox.exec(`cd ${dir} && ls -d ${pattern} 2>/dev/null`);
    const files = result.stdout.split("\n").filter(Boolean);
    return { content: JSON.stringify({ files }) };
  },

  async browse(sandbox, { port }) {
    const url = await sandbox.exposePort(port as number);
    return { content: JSON.stringify({ url }) };
  },
};

/** Process a single tool call from the LLM. */
export async function handleToolCall(
  sandbox: Sandbox,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const handler = tools[name];
  if (!handler) return { content: `Unknown tool: ${name}`, isError: true };
  try {
    return await handler(sandbox, input);
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
  sandbox: Sandbox,
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
      const result = await handleToolCall(sandbox, block.name, block.input);
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

- **Stateless tools, stateful sandbox.** Each tool call is a pure function of
  its inputs plus sandbox state. The sandbox container persists across calls
  within a session (default 10min idle timeout).
- **No streaming in tools.** Tool results are returned as complete strings. For
  long-running commands, the agent can poll or use `timeout_ms`.
- **Security boundary.** The Cloudflare container is the trust boundary. The
  agent cannot escape it. Network access can be restricted via sandbox config.
- **Compact reference.** The 5 tools above cover ~90% of agent coding tasks.
  Additional tools (e.g. `patch`, `search`) can be added but increase prompt
  size. Prefer composing via `shell` (e.g. `shell` + `grep`).
