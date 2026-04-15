import { assertEquals } from "@std/assert";
import { createToolOutputId } from "../src/contracts/tool-result.ts";
import { bashTool } from "../src/tools/bash.ts";
import { readFileTool } from "../src/tools/read-file.ts";
import { writeFileTool } from "../src/tools/write-file.ts";
import type { HarnessToolContext } from "../src/tools/types.ts";
import type {
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxRuntime,
  SandboxShellRequest,
} from "../src/sandbox/types.ts";

class FakeSandboxRuntime implements SandboxRuntime {
  readonly kind = "docker-runsc-cfc" as const;
  readonly calls: Array<
    | { type: "run"; request: SandboxCommandRequest }
    | { type: "runShell"; request: SandboxShellRequest }
  > = [];

  constructor(
    private readonly shellResult: SandboxCommandResult = {
      stdout: "",
      stderr: "",
      exitCode: 0,
    },
  ) {}

  resolvePath(path: string): string {
    return path.startsWith("/") ? path : `/workspace/${path}`;
  }

  defaultWorkingDirectory(): string {
    return "/workspace";
  }

  async run(request: SandboxCommandRequest): Promise<SandboxCommandResult> {
    this.calls.push({ type: "run", request });
    return this.shellResult;
  }

  async runShell(request: SandboxShellRequest): Promise<SandboxCommandResult> {
    this.calls.push({ type: "runShell", request });
    return this.shellResult;
  }
}

const createContext = (sandbox: SandboxRuntime): HarnessToolContext => ({
  runId: "run-1",
  cfcEnforcementMode: "observe",
  sandbox,
  nextOutputId(toolId) {
    return createToolOutputId("run-1", toolId, 1);
  },
});

Deno.test("bash tool executes the command through the sandbox shell runtime", async () => {
  const sandbox = new FakeSandboxRuntime({
    stdout: "ok\n",
    stderr: "",
    exitCode: 0,
  });
  const output = await bashTool.invoke(createContext(sandbox), {
    command: "pwd",
    cwd: "repo",
    timeoutMs: 1000,
  });

  assertEquals(output, {
    outputId: "run-1:bash:1",
    stdout: "ok\n",
    stderr: "",
    exitCode: 0,
  });
  assertEquals(sandbox.calls, [{
    type: "runShell",
    request: {
      command: "pwd",
      cwd: "repo",
      timeoutMs: 1000,
    },
  }]);
});

Deno.test("read_file tool resolves relative paths into the sandbox workspace", async () => {
  const sandbox = new FakeSandboxRuntime({
    stdout: "hello",
    stderr: "",
    exitCode: 0,
  });
  const output = await readFileTool.invoke(createContext(sandbox), {
    path: "notes/todo.txt",
    maxBytes: 32,
  });

  assertEquals(output, {
    outputId: "run-1:read_file:1",
    path: "/workspace/notes/todo.txt",
    content: "hello",
  });
  assertEquals(sandbox.calls[0], {
    type: "runShell",
    request: {
      command: [
        "set -eu",
        'if [ ! -f "$1" ]; then',
        '  echo "file not found: $1" >&2',
        "  exit 1",
        "fi",
        'if [ -n "$2" ]; then',
        '  exec head -c "$2" "$1"',
        "fi",
        'exec cat "$1"',
      ].join("\n"),
      args: ["/workspace/notes/todo.txt", "32"],
    },
  });
});

Deno.test("write_file tool supports append mode and passes content over stdin", async () => {
  const sandbox = new FakeSandboxRuntime();
  const output = await writeFileTool.invoke(createContext(sandbox), {
    path: "notes/log.txt",
    content: "line one\n",
    mode: "append",
    createParents: true,
  });

  assertEquals(output, {
    outputId: "run-1:write_file:1",
    path: "/workspace/notes/log.txt",
    mode: "append",
  });
  assertEquals(sandbox.calls[0], {
    type: "runShell",
    request: {
      command: [
        "set -eu",
        'path="$1"',
        'mode="$2"',
        'create_parents="$3"',
        'if [ "$create_parents" = "true" ]; then',
        '  mkdir -p "$(dirname "$path")"',
        "fi",
        'case "$mode" in',
        "  replace)",
        '    cat > "$path"',
        "    ;;",
        "  append)",
        '    cat >> "$path"',
        "    ;;",
        "  *)",
        '    echo "unsupported write mode: $mode" >&2',
        "    exit 2",
        "    ;;",
        "esac",
      ].join("\n"),
      args: ["/workspace/notes/log.txt", "append", "true"],
      stdinText: "line one\n",
    },
  });
});
