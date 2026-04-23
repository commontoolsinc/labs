import { assertEquals, assertRejects } from "@std/assert";
import { normalize } from "@std/path/posix";
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
    private readonly shellResults: SandboxCommandResult[] = [{
      stdout: "",
      stderr: "",
      exitCode: 0,
    }],
  ) {}

  resolvePath(path: string, cwd = this.defaultWorkingDirectory()): string {
    return normalize(path.startsWith("/") ? path : `${cwd}/${path}`);
  }

  isPathWithinWorkspace(path: string): boolean {
    return path === "/workspace" || path.startsWith("/workspace/");
  }

  defaultWorkingDirectory(): string {
    return "/workspace";
  }

  run(request: SandboxCommandRequest): Promise<SandboxCommandResult> {
    this.calls.push({ type: "run", request });
    return Promise.resolve(
      this.shellResults.shift() ?? { stdout: "", stderr: "", exitCode: 0 },
    );
  }

  runShell(request: SandboxShellRequest): Promise<SandboxCommandResult> {
    this.calls.push({ type: "runShell", request });
    return Promise.resolve(
      this.shellResults.shift() ?? { stdout: "", stderr: "", exitCode: 0 },
    );
  }
}

const createContext = (
  sandbox: SandboxRuntime,
  initialCurrentDir = "/workspace",
): HarnessToolContext => {
  let currentDir = initialCurrentDir;
  let sequence = 0;
  return {
    runId: "run-1",
    cfcEnforcementMode: "observe",
    get currentDir() {
      return currentDir;
    },
    sandbox,
    resolvePath(path: string) {
      return sandbox.resolvePath(path, currentDir);
    },
    setCurrentDir(path: string) {
      currentDir = sandbox.resolvePath(path, currentDir);
    },
    nextOutputId(toolId) {
      sequence += 1;
      return createToolOutputId("run-1", toolId, sequence);
    },
  };
};

Deno.test("bash tool executes the command through the sandbox shell runtime", async () => {
  const sandbox = new FakeSandboxRuntime([{
    stdout: "ok\n",
    stderr: "",
    exitCode: 0,
  }]);
  const context = createContext(sandbox);
  const output = await bashTool.invoke(context, {
    command: "pwd",
    cwd: "repo",
    timeoutMs: 1000,
  });

  assertEquals(output, {
    outputId: "run-1:bash:1",
    stdout: "ok\n",
    stderr: "",
    exitCode: 0,
    cwd: "/workspace/repo",
  });
  assertEquals(sandbox.calls, [{
    type: "runShell",
    request: {
      command: [
        '__cf_harness_cwd_marker="__CF_HARNESS_CWD__run-1:bash:1__"',
        'trap \'__cf_harness_status=$?; trap - EXIT; printf "%s%s" "$__cf_harness_cwd_marker" "$(pwd)"; exit "$__cf_harness_status"\' EXIT',
        "pwd",
      ].join("\n"),
      cwd: "/workspace/repo",
      timeoutMs: 1000,
    },
  }]);
  assertEquals(context.currentDir, "/workspace/repo");
});

Deno.test("read_file tool resolves relative paths from the session currentDir", async () => {
  const sandbox = new FakeSandboxRuntime([{
    stdout: "hello",
    stderr: "",
    exitCode: 0,
  }]);
  const output = await readFileTool.invoke(
    createContext(sandbox, "/workspace/.ops"),
    {
      path: "../notes/todo.txt",
      maxBytes: 32,
    },
  );

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

Deno.test("read_file tool rejects non-integer maxBytes", async () => {
  const sandbox = new FakeSandboxRuntime();

  await assertRejects(
    () =>
      readFileTool.invoke(createContext(sandbox), {
        path: "notes/todo.txt",
        maxBytes: 1.5,
      }),
    Error,
    "read_file maxBytes must be a non-negative integer",
  );

  assertEquals(sandbox.calls, []);
});

Deno.test("read_file tool rejects missing files instead of returning empty content", async () => {
  const sandbox = new FakeSandboxRuntime([{
    stdout: "",
    stderr: "file not found: /workspace/notes/missing.txt",
    exitCode: 1,
  }]);

  await assertRejects(
    () =>
      readFileTool.invoke(createContext(sandbox), {
        path: "notes/missing.txt",
      }),
    Error,
    "read_file failed for /workspace/notes/missing.txt: file not found: /workspace/notes/missing.txt",
  );
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

Deno.test("write_file uses the cwd established by an earlier bash call", async () => {
  const sandbox = new FakeSandboxRuntime([
    { stdout: "", stderr: "", exitCode: 0 },
    { stdout: "", stderr: "", exitCode: 0 },
  ]);
  const context = createContext(sandbox);

  await bashTool.invoke(context, {
    command: "pwd",
    cwd: "repo",
  });
  await writeFileTool.invoke(context, {
    path: "notes/log.txt",
    content: "line one\n",
  });

  assertEquals(context.currentDir, "/workspace/repo");
  assertEquals(sandbox.calls[1], {
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
      args: ["/workspace/repo/notes/log.txt", "replace", "false"],
      stdinText: "line one\n",
    },
  });
});

Deno.test("write_file tool rejects nonzero shell exits", async () => {
  const sandbox = new FakeSandboxRuntime([{
    stdout: "",
    stderr: "permission denied",
    exitCode: 13,
  }]);

  await assertRejects(
    () =>
      writeFileTool.invoke(createContext(sandbox), {
        path: "notes/log.txt",
        content: "line one\n",
      }),
    Error,
    "write_file failed for /workspace/notes/log.txt: permission denied",
  );
});
