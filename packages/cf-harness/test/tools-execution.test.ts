import { assertEquals, assertRejects } from "@std/assert";
import { normalize } from "@std/path/posix";
import type { CfcSandboxResult } from "@commonfabric/runner/cfc";
import { createToolOutputId } from "../src/contracts/tool-result.ts";
import { bashTool } from "../src/tools/bash.ts";
import { bashNoSandboxTool } from "../src/tools/bash-no-sandbox.ts";
import { readFileTool } from "../src/tools/read-file.ts";
import { writeFileTool } from "../src/tools/write-file.ts";
import type { HarnessToolContext } from "../src/tools/types.ts";
import type {
  ProcessRunner,
  ProcessRunRequest,
  ProcessRunResult,
} from "../src/sandbox/process-runner.ts";
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

class StrictFakeSandboxRuntime extends FakeSandboxRuntime {
  override resolvePath(path: string, cwd = this.defaultWorkingDirectory()) {
    const resolved = super.resolvePath(path, cwd);
    if (!this.isPathWithinWorkspace(resolved)) {
      throw new Error(`path escapes workspace root: ${resolved}`);
    }
    return resolved;
  }
}

class MultiRootFakeSandboxRuntime extends FakeSandboxRuntime {
  isPathWithinAllowedRoots(path: string): boolean {
    return this.isPathWithinWorkspace(path) ||
      path === "/fabric" ||
      path.startsWith("/fabric/");
  }
}

class FakeProcessRunner implements ProcessRunner {
  readonly calls: ProcessRunRequest[] = [];

  constructor(
    private readonly results: ProcessRunResult[] = [{
      stdout: "",
      stderr: "",
      exitCode: 0,
    }],
  ) {}

  run(request: ProcessRunRequest): Promise<ProcessRunResult> {
    this.calls.push(request);
    return Promise.resolve(
      this.results.shift() ?? { stdout: "", stderr: "", exitCode: 0 },
    );
  }
}

const createContext = (
  sandbox: SandboxRuntime,
  initialCurrentDir = "/workspace",
  hostProcessRunner: ProcessRunner = new FakeProcessRunner(),
  cfcEnforcementMode: HarnessToolContext["cfcEnforcementMode"] = "observe",
): HarnessToolContext => {
  let currentDir = initialCurrentDir;
  let sequence = 0;
  const workspaceHostPath = "/tmp/cf-harness-workspace";
  return {
    runId: "run-1",
    cfcEnforcementMode,
    get currentDir() {
      return currentDir;
    },
    sandbox,
    hostProcessRunner,
    resolvePath(path: string) {
      return sandbox.resolvePath(path, currentDir);
    },
    resolveHostPath(path: string) {
      const sandboxPath = sandbox.resolvePath(path, currentDir);
      return sandboxPath === "/workspace"
        ? workspaceHostPath
        : `${workspaceHostPath}${sandboxPath.slice("/workspace".length)}`;
    },
    hostPathToWorkspacePath(path: string) {
      return path === workspaceHostPath
        ? "/workspace"
        : path.startsWith(`${workspaceHostPath}/`)
        ? `/workspace${path.slice(workspaceHostPath.length)}`
        : undefined;
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

const observedCfcResult = (stdout: string): CfcSandboxResult => ({
  version: 1,
  stdout: {
    channel: "stdout",
    policy: "observed",
    label: { confidentiality: ["public"] },
    segments: [{ text: stdout, label: { confidentiality: ["public"] } }],
  },
  stderr: {
    channel: "stderr",
    policy: "observed",
    label: { confidentiality: ["public"] },
    segments: [{ text: "", label: { confidentiality: ["public"] } }],
  },
  exitCode: {
    policy: "observed",
    label: { confidentiality: ["public"] },
    value: 0,
  },
});

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

Deno.test("bash tool preserves currentDir inside a configured Fabric mount", async () => {
  const sandbox = new MultiRootFakeSandboxRuntime([{
    stdout: "__CF_HARNESS_CWD__run-1:bash:1__/fabric/home",
    stderr: "",
    exitCode: 0,
  }]);
  const context = createContext(sandbox);
  const output = await bashTool.invoke(context, {
    command: "cd /fabric/home",
  });

  assertEquals(output.cwd, "/fabric/home");
  assertEquals(context.currentDir, "/fabric/home");
});

Deno.test("bash tool updates currentDir in enforce mode from observed CFC stdout", async () => {
  const outputId = createToolOutputId("run-1", "bash", 1);
  const cwdMarker = `__CF_HARNESS_CWD__${outputId}__`;
  const sandbox = new FakeSandboxRuntime([{
    stdout: `raw public\n${cwdMarker}/workspace/repo`,
    stderr: "",
    exitCode: 0,
    cfcResult: observedCfcResult(`public\n${cwdMarker}/workspace/repo`),
  }]);
  const context = createContext(
    sandbox,
    "/workspace",
    new FakeProcessRunner(),
    "enforce-explicit",
  );

  const output = await bashTool.invoke(context, {
    command: "cd repo",
  });

  assertEquals(output.cwd, "/workspace/repo");
  assertEquals(context.currentDir, "/workspace/repo");
  assertEquals(output.stdout, `raw public\n${cwdMarker}/workspace/repo`);
});

Deno.test("bash-no-sandbox tool executes the command through the host process runner", async () => {
  const hostRunner = new FakeProcessRunner([{
    stdout:
      "host ok\n__CF_HARNESS_HOST_CWD__run-1:bash-no-sandbox:1__/tmp/cf-harness-workspace/browser",
    stderr: "",
    exitCode: 0,
  }]);
  const sandbox = new FakeSandboxRuntime();
  const context = createContext(sandbox, "/workspace", hostRunner);
  const output = await bashNoSandboxTool.invoke(context, {
    command: "agent-browser --help",
    cwd: "browser",
    timeoutMs: 1000,
  });

  assertEquals(output, {
    outputId: "run-1:bash-no-sandbox:1",
    stdout: "host ok\n",
    stderr: "",
    exitCode: 0,
    cwd: "/workspace/browser",
  });
  assertEquals(sandbox.calls, []);
  assertEquals(hostRunner.calls, [{
    command: "bash",
    args: [
      "-lc",
      [
        '__cf_harness_cwd_marker="__CF_HARNESS_HOST_CWD__run-1:bash-no-sandbox:1__"',
        'trap \'__cf_harness_status=$?; trap - EXIT; printf "%s%s" "$__cf_harness_cwd_marker" "$(pwd)"; exit "$__cf_harness_status"\' EXIT',
        "agent-browser --help",
      ].join("\n"),
    ],
    cwd: "/tmp/cf-harness-workspace/browser",
    timeoutMs: 1000,
  }]);
  assertEquals(context.currentDir, "/workspace/browser");
});

Deno.test("bash-no-sandbox keeps currentDir inside the workspace if the host command exits elsewhere", async () => {
  const hostRunner = new FakeProcessRunner([{
    stdout: "__CF_HARNESS_HOST_CWD__run-1:bash-no-sandbox:1__/tmp/outside",
    stderr: "",
    exitCode: 0,
  }]);
  const context = createContext(
    new FakeSandboxRuntime(),
    "/workspace/repo",
    hostRunner,
  );
  const output = await bashNoSandboxTool.invoke(context, {
    command: "cd /tmp/outside",
  });

  assertEquals(output.cwd, "/workspace/repo");
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
        'if [ ! -e "$1" ]; then',
        '  echo "file not found: $1" >&2',
        "  exit 10",
        "fi",
        'if [ ! -f "$1" ]; then',
        '  echo "not a file: $1" >&2',
        "  exit 11",
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

Deno.test("read_file tool returns a recoverable file_not_found result", async () => {
  const sandbox = new FakeSandboxRuntime([{
    stdout: "",
    stderr: "file not found: /workspace/notes/missing.txt",
    exitCode: 10,
  }]);

  const output = await readFileTool.invoke(createContext(sandbox), {
    path: "notes/missing.txt",
  });

  assertEquals(output, {
    outputId: "run-1:read_file:1",
    path: "/workspace/notes/missing.txt",
    ok: false,
    error: {
      type: "cf-harness.structured-file-tool-error",
      code: "file_not_found",
      message: "file not found: /workspace/notes/missing.txt",
      path: "/workspace/notes/missing.txt",
      detail: "file not found: /workspace/notes/missing.txt",
      exitCode: 10,
    },
  });
});

Deno.test("read_file tool returns a recoverable not_a_file result", async () => {
  const sandbox = new FakeSandboxRuntime([{
    stdout: "",
    stderr: "not a file: /workspace/notes",
    exitCode: 11,
  }]);

  const output = await readFileTool.invoke(createContext(sandbox), {
    path: "notes",
  });

  assertEquals(output, {
    outputId: "run-1:read_file:1",
    path: "/workspace/notes",
    ok: false,
    error: {
      type: "cf-harness.structured-file-tool-error",
      code: "not_a_file",
      message: "not a file: /workspace/notes",
      path: "/workspace/notes",
      detail: "not a file: /workspace/notes",
      exitCode: 11,
    },
  });
});

Deno.test("read_file tool returns a recoverable path_outside_workspace result", async () => {
  const sandbox = new StrictFakeSandboxRuntime();

  const output = await readFileTool.invoke(createContext(sandbox), {
    path: "../outside.txt",
  });

  assertEquals(output, {
    outputId: "run-1:read_file:1",
    path: "../outside.txt",
    ok: false,
    error: {
      type: "cf-harness.structured-file-tool-error",
      code: "path_outside_workspace",
      message: "path outside workspace: ../outside.txt",
      path: "../outside.txt",
      detail: "path escapes workspace root: /outside.txt",
    },
  });
  assertEquals(sandbox.calls, []);
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
        'parent="$(dirname "$path")"',
        'if [ "$create_parents" = "true" ]; then',
        '  mkdir -p "$parent"',
        'elif [ ! -d "$parent" ]; then',
        '  echo "file not found: parent directory $parent" >&2',
        "  exit 10",
        "fi",
        'if [ -e "$path" ] && [ ! -f "$path" ]; then',
        '  echo "not a file: $path" >&2',
        "  exit 11",
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
        "    exit 12",
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
        'parent="$(dirname "$path")"',
        'if [ "$create_parents" = "true" ]; then',
        '  mkdir -p "$parent"',
        'elif [ ! -d "$parent" ]; then',
        '  echo "file not found: parent directory $parent" >&2',
        "  exit 10",
        "fi",
        'if [ -e "$path" ] && [ ! -f "$path" ]; then',
        '  echo "not a file: $path" >&2',
        "  exit 11",
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
        "    exit 12",
        "    ;;",
        "esac",
      ].join("\n"),
      args: ["/workspace/repo/notes/log.txt", "replace", "false"],
      stdinText: "line one\n",
    },
  });
});

Deno.test("write_file tool returns a recoverable permission_denied result", async () => {
  const sandbox = new FakeSandboxRuntime([{
    stdout: "",
    stderr: "permission denied",
    exitCode: 13,
  }]);

  const output = await writeFileTool.invoke(createContext(sandbox), {
    path: "notes/log.txt",
    content: "line one\n",
  });

  assertEquals(output, {
    outputId: "run-1:write_file:1",
    path: "/workspace/notes/log.txt",
    ok: false,
    error: {
      type: "cf-harness.structured-file-tool-error",
      code: "permission_denied",
      message: "permission denied: /workspace/notes/log.txt",
      path: "/workspace/notes/log.txt",
      detail: "permission denied",
      exitCode: 13,
    },
  });
});

Deno.test("write_file tool returns a recoverable path_outside_workspace result", async () => {
  const sandbox = new StrictFakeSandboxRuntime();

  const output = await writeFileTool.invoke(createContext(sandbox), {
    path: "../outside.txt",
    content: "line one\n",
  });

  assertEquals(output, {
    outputId: "run-1:write_file:1",
    path: "../outside.txt",
    ok: false,
    error: {
      type: "cf-harness.structured-file-tool-error",
      code: "path_outside_workspace",
      message: "path outside workspace: ../outside.txt",
      path: "../outside.txt",
      detail: "path escapes workspace root: /outside.txt",
    },
  });
  assertEquals(sandbox.calls, []);
});
