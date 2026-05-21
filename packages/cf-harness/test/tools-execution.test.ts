import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { decodeBase64 } from "@std/encoding/base64";
import { join } from "@std/path";
import { normalize } from "@std/path/posix";
import type { CfcLabelView, CfcSandboxResult } from "@commonfabric/runner/cfc";
import { createHarnessCfcInvocationContext } from "../src/contracts/cfc-invocation-context.ts";
import type {
  HarnessSkillRegistry,
  HarnessSkillResourceRead,
} from "../src/contracts/skill.ts";
import { createToolOutputId } from "../src/contracts/tool-result.ts";
import { discoverHarnessSkills } from "../src/skills/registry.ts";
import { bashTool } from "../src/tools/bash.ts";
import { bashNoSandboxTool } from "../src/tools/bash-no-sandbox.ts";
import { editFileTool } from "../src/tools/edit-file.ts";
import { readFileTool } from "../src/tools/read-file.ts";
import { RESERVED_ARTIFACT_PATH_DETAIL } from "../src/tools/reserved-artifacts.ts";
import { readSkillResourceTool } from "../src/tools/read-skill-resource.ts";
import { viewImageTool } from "../src/tools/view-image.ts";
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

const ONE_PIXEL_PNG = decodeBase64(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p94AAAAASUVORK5CYII=",
);

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
  artifactRootHostPath?: string,
  skillRegistry?: HarnessSkillRegistry,
  skillResourceReads: HarnessSkillResourceRead[] = [],
  workspaceHostPath = "/tmp/cf-harness-workspace",
): HarnessToolContext => {
  let currentDir = initialCurrentDir;
  let sequence = 0;
  let cfcInvocationSequence = 0;
  return {
    runId: "run-1",
    cfcEnforcementMode,
    workspaceHostPath,
    skillRegistry,
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
    isHostPathWithinWorkspace(path: string) {
      return Promise.resolve(
        path === workspaceHostPath ||
          path.startsWith(`${workspaceHostPath}/`),
      );
    },
    isHostPathWithinArtifactRoot(path: string) {
      return Promise.resolve(
        artifactRootHostPath !== undefined &&
          (path === artifactRootHostPath ||
            path.startsWith(`${artifactRootHostPath}/`)),
      );
    },
    doesHostPathIntersectArtifactRoot(path: string) {
      return Promise.resolve(
        artifactRootHostPath !== undefined &&
          (path === artifactRootHostPath ||
            path.startsWith(`${artifactRootHostPath}/`) ||
            artifactRootHostPath.startsWith(`${path}/`)),
      );
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
    now() {
      return "2026-05-01T17:54:00.000Z";
    },
    recordSkillResourceRead(read) {
      skillResourceReads.push(read);
      return Promise.resolve();
    },
    createCfcInvocationContext(options) {
      cfcInvocationSequence += 1;
      return createHarnessCfcInvocationContext({
        sequence: cfcInvocationSequence,
        runId: "run-1",
        createdAt: "2026-04-30T00:00:00.000Z",
        cfcEnforcementMode,
        runManifest: { present: false },
        ...options,
      });
    },
  };
};

const stripCfcInvocationContexts = (
  calls: FakeSandboxRuntime["calls"],
): FakeSandboxRuntime["calls"] =>
  calls.map((call) => {
    if (call.type === "run") {
      const { cfcInvocationContext: _cfcInvocationContext, ...request } =
        call.request;
      return { type: "run", request };
    }
    const { cfcInvocationContext: _cfcInvocationContext, ...request } =
      call.request;
    return { type: "runShell", request };
  });

const observedCfcResult = (
  stdout: string,
  options: {
    stdoutLabel?: CfcSandboxResult["stdout"]["label"];
  } = {},
): CfcSandboxResult => ({
  version: 1,
  stdout: {
    channel: "stdout",
    policy: "observed",
    label: options.stdoutLabel ?? { confidentiality: ["public"] },
    segments: [{
      text: stdout,
      label: options.stdoutLabel ?? { confidentiality: ["public"] },
    }],
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

const digestText = async (text: string): Promise<string> => {
  const bytes = new TextEncoder().encode(text);
  const digestInput = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", digestInput);
  return `sha256:${
    [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
  }`;
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
  assertEquals(stripCfcInvocationContexts(sandbox.calls), [{
    type: "runShell",
    request: {
      command: [
        '__cf_harness_cwd_marker="__CF_HARNESS_CWD__run-1:bash:1__"',
        'trap \'__cf_harness_status=$?; trap - EXIT; { printf "%s%s" "$__cf_harness_cwd_marker" "$(pwd)" || true; }; exit "$__cf_harness_status"\' EXIT',
        "pwd",
      ].join("\n"),
      cwd: "/workspace/repo",
      timeoutMs: 1000,
    },
  }]);
  assertEquals(
    sandbox.calls[0]?.request.cfcInvocationContext?.toolOutputId,
    "run-1:bash:1",
  );
  assertEquals(
    sandbox.calls[0]?.request.cfcInvocationContext?.inputs.command?.bytes,
    [
      '__cf_harness_cwd_marker="__CF_HARNESS_CWD__run-1:bash:1__"',
      'trap \'__cf_harness_status=$?; trap - EXIT; { printf "%s%s" "$__cf_harness_cwd_marker" "$(pwd)" || true; }; exit "$__cf_harness_status"\' EXIT',
      "pwd",
    ].join("\n").length,
  );
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

Deno.test("bash tool allows curl to localhost through the sandbox shell runtime", async () => {
  const sandbox = new FakeSandboxRuntime([{
    stdout: "pong\n",
    stderr: "",
    exitCode: 0,
  }]);
  const context = createContext(sandbox);
  const output = await bashTool.invoke(context, {
    command: "curl -fsS http://localhost:8000/health",
  });

  assertEquals(output.stdout, "pong\n");
  assertEquals(stripCfcInvocationContexts(sandbox.calls), [{
    type: "runShell",
    request: {
      command: [
        '__cf_harness_cwd_marker="__CF_HARNESS_CWD__run-1:bash:1__"',
        'trap \'__cf_harness_status=$?; trap - EXIT; { printf "%s%s" "$__cf_harness_cwd_marker" "$(pwd)" || true; }; exit "$__cf_harness_status"\' EXIT',
        "curl -fsS http://localhost:8000/health",
      ].join("\n"),
      cwd: "/workspace",
      timeoutMs: undefined,
    },
  }]);
});

Deno.test("bash tool denies curl to non-localhost targets before sandbox execution", async () => {
  const sandbox = new FakeSandboxRuntime();
  const context = createContext(sandbox, "/workspace/old");
  const output = await bashTool.invoke(context, {
    command: "curl https://example.com",
    cwd: "/workspace/new",
  });

  assertEquals(output, {
    outputId: "run-1:bash:1",
    stdout: "",
    stderr:
      "bash command denied: curl host example.com is not allowed from cf-harness bash; use localhost or host.docker.internal",
    exitCode: 126,
    cwd: "/workspace/new",
  });
  assertEquals(sandbox.calls, []);
  assertEquals(context.currentDir, "/workspace/new");
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
    stdout: "host ok\n",
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
    command: "agent-browser",
    args: ["--help"],
    cwd: "/tmp/cf-harness-workspace/browser",
    timeoutMs: 1000,
  }]);
  assertEquals(context.currentDir, "/workspace/browser");
});

Deno.test("bash-no-sandbox defaults and caps host command timeouts", async () => {
  const hostRunner = new FakeProcessRunner();
  const context = createContext(
    new FakeSandboxRuntime(),
    "/workspace/repo",
    hostRunner,
  );

  await bashNoSandboxTool.invoke(context, {
    command: "agent-browser --help",
  });
  await bashNoSandboxTool.invoke(context, {
    command: "agent-browser --help",
    timeoutMs: 999_999,
  });

  assertEquals(hostRunner.calls.map((call) => call.timeoutMs), [
    30_000,
    120_000,
  ]);
});

Deno.test("bash-no-sandbox caps returned host output", async () => {
  const hostRunner = new FakeProcessRunner([{
    stdout: "x".repeat(20_010),
    stderr: "y".repeat(20_001),
    exitCode: 0,
  }]);
  const context = createContext(
    new FakeSandboxRuntime(),
    "/workspace/repo",
    hostRunner,
  );

  const output = await bashNoSandboxTool.invoke(context, {
    command: "agent-browser --help",
  });

  assertEquals(
    output.stdout,
    `${"x".repeat(20_000)}\n[cf-harness truncated stdout: 10 chars omitted]`,
  );
  assertEquals(
    output.stderr,
    `${"y".repeat(20_000)}\n[cf-harness truncated stderr: 1 chars omitted]`,
  );
});

Deno.test("bash-no-sandbox keeps currentDir at the command cwd", async () => {
  const hostRunner = new FakeProcessRunner([{
    stdout: "",
    stderr: "",
    exitCode: 0,
  }]);
  const context = createContext(
    new FakeSandboxRuntime(),
    "/workspace/repo",
    hostRunner,
  );
  const output = await bashNoSandboxTool.invoke(context, {
    command: "agent-browser --help",
  });

  assertEquals(output.cwd, "/workspace/repo");
  assertEquals(context.currentDir, "/workspace/repo");
});

Deno.test("bash-no-sandbox translates command -v agent-browser to direct argv", async () => {
  const hostRunner = new FakeProcessRunner([{
    stdout: "/usr/local/bin/agent-browser\n",
    stderr: "",
    exitCode: 0,
  }]);
  const context = createContext(
    new FakeSandboxRuntime(),
    "/workspace/repo",
    hostRunner,
  );
  const output = await bashNoSandboxTool.invoke(context, {
    command: "command -v agent-browser",
  });

  assertEquals(output.stdout, "/usr/local/bin/agent-browser\n");
  assertEquals(hostRunner.calls, [{
    command: "which",
    args: ["agent-browser"],
    cwd: "/tmp/cf-harness-workspace/repo",
    timeoutMs: 30_000,
  }]);
});

Deno.test("bash-no-sandbox lets allowed host commands handle missing workspace paths", async () => {
  const hostRunner = new FakeProcessRunner([{
    stdout: "",
    stderr: "ls: missing.txt: No such file or directory\n",
    exitCode: 1,
  }]);
  const context = createContext(
    new FakeSandboxRuntime(),
    "/workspace/repo",
    hostRunner,
  );
  context.isHostPathWithinWorkspace = (
    path: string,
    options?: { allowMissing?: boolean },
  ) =>
    Promise.resolve(
      path === "/tmp/cf-harness-workspace/repo" ||
        (path.endsWith("/missing.txt") && options?.allowMissing === true),
    );

  const output = await bashNoSandboxTool.invoke(context, {
    command: "ls missing.txt",
  });

  assertEquals(hostRunner.calls, [{
    command: "ls",
    args: ["missing.txt"],
    cwd: "/tmp/cf-harness-workspace/repo",
    timeoutMs: 30_000,
  }]);
  assertEquals(output, {
    outputId: "run-1:bash-no-sandbox:1",
    stdout: "",
    stderr: "ls: missing.txt: No such file or directory\n",
    exitCode: 1,
    cwd: "/workspace/repo",
  });
});

Deno.test("bash-no-sandbox denies ls and find paths that realpath outside the workspace", async () => {
  const hostRunner = new FakeProcessRunner();
  const context = createContext(
    new FakeSandboxRuntime(),
    "/workspace/repo",
    hostRunner,
  );
  context.isHostPathWithinWorkspace = (path: string) =>
    Promise.resolve(!path.endsWith("/outside-link"));

  const output = await bashNoSandboxTool.invoke(context, {
    command: "ls outside-link",
  });

  assertEquals(hostRunner.calls, []);
  assertEquals(output, {
    outputId: "run-1:bash-no-sandbox:1",
    stdout: "",
    stderr:
      "bash-no-sandbox command denied: path outside-link must resolve within or below the workspace",
    exitCode: 126,
    cwd: "/workspace/repo",
  });
});

Deno.test("bash-no-sandbox denies ls and find paths that intersect artifact roots", async () => {
  const hostRunner = new FakeProcessRunner();
  const artifactRootHostPath =
    "/tmp/cf-harness-workspace/.cf-harness-artifacts";
  const context = createContext(
    new FakeSandboxRuntime(),
    "/workspace",
    hostRunner,
    "observe",
    artifactRootHostPath,
  );

  const lsOutput = await bashNoSandboxTool.invoke(context, {
    command: "ls .cf-harness-artifacts",
  });
  const findOutput = await bashNoSandboxTool.invoke(context, {
    command: "find . -maxdepth 2 -type f -print",
  });

  assertEquals(hostRunner.calls, []);
  assertEquals(lsOutput, {
    outputId: "run-1:bash-no-sandbox:1",
    stdout: "",
    stderr:
      "bash-no-sandbox command denied: path .cf-harness-artifacts is reserved for cf-harness artifacts",
    exitCode: 126,
    cwd: "/workspace",
  });
  assertEquals(findOutput, {
    outputId: "run-1:bash-no-sandbox:2",
    stdout: "",
    stderr:
      "bash-no-sandbox command denied: path . is reserved for cf-harness artifacts",
    exitCode: 126,
    cwd: "/workspace",
  });
});

Deno.test("bash-no-sandbox denies host commands outside the browser policy", async () => {
  const hostRunner = new FakeProcessRunner();
  const context = createContext(
    new FakeSandboxRuntime(),
    "/workspace/repo",
    hostRunner,
  );
  const output = await bashNoSandboxTool.invoke(context, {
    command: "git status",
    cwd: "browser",
  });

  assertEquals(hostRunner.calls, []);
  assertEquals(output, {
    outputId: "run-1:bash-no-sandbox:1",
    stdout: "",
    stderr:
      "bash-no-sandbox command denied: git is not allowed in the browser host profile",
    exitCode: 126,
    cwd: "/workspace/repo/browser",
  });
  assertEquals(context.currentDir, "/workspace/repo/browser");
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
  assertEquals(stripCfcInvocationContexts(sandbox.calls)[0], {
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
      cwd: "/workspace/.ops",
    },
  });
  assertEquals(
    sandbox.calls[0]?.request.cfcInvocationContext?.toolId,
    "read_file",
  );
  assertEquals(
    sandbox.calls[0]?.request.cfcInvocationContext?.inputs.args?.count,
    2,
  );
  assertEquals(
    sandbox.calls[0]?.request.cfcInvocationContext?.cwd,
    "/workspace/.ops",
  );
});

Deno.test("read_file tool preserves CFC result on success", async () => {
  const cfcResult = observedCfcResult("released file");
  const sandbox = new FakeSandboxRuntime([{
    stdout: "raw file",
    stderr: "",
    exitCode: 0,
    cfcResult,
  }]);

  const output = await readFileTool.invoke(createContext(sandbox), {
    path: "notes/todo.txt",
  });

  assertEquals(output, {
    outputId: "run-1:read_file:1",
    path: "/workspace/notes/todo.txt",
    content: "raw file",
    cfcResult,
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

Deno.test("read_file tool denies reserved artifact paths before shelling out", async () => {
  const sandbox = new FakeSandboxRuntime();
  const context = createContext(
    sandbox,
    "/workspace",
    new FakeProcessRunner(),
    "observe",
    "/tmp/cf-harness-workspace/.cf-harness-artifacts",
  );

  const rootOutput = await readFileTool.invoke(context, {
    path: ".cf-harness-artifacts",
  });
  const childOutput = await readFileTool.invoke(context, {
    path: ".cf-harness-artifacts/run-1/transcript.json",
  });

  assertEquals(rootOutput, {
    outputId: "run-1:read_file:1",
    path: "/workspace/.cf-harness-artifacts",
    ok: false,
    error: {
      type: "cf-harness.structured-file-tool-error",
      code: "permission_denied",
      message: "permission denied: /workspace/.cf-harness-artifacts",
      path: "/workspace/.cf-harness-artifacts",
      detail: RESERVED_ARTIFACT_PATH_DETAIL,
    },
  });
  assertEquals(childOutput, {
    outputId: "run-1:read_file:2",
    path: "/workspace/.cf-harness-artifacts/run-1/transcript.json",
    ok: false,
    error: {
      type: "cf-harness.structured-file-tool-error",
      code: "permission_denied",
      message:
        "permission denied: /workspace/.cf-harness-artifacts/run-1/transcript.json",
      path: "/workspace/.cf-harness-artifacts/run-1/transcript.json",
      detail: RESERVED_ARTIFACT_PATH_DETAIL,
    },
  });
  assertEquals(sandbox.calls, []);
});

Deno.test({
  name:
    "read_skill_resource reads indexed text resources and records provenance",
  permissions: { read: true, write: true },
  async fn() {
    const root = await Deno.makeTempDir({
      prefix: "cf-harness-skill-resource-",
    });
    try {
      await Deno.mkdir(join(root, "pattern-dev", "references"), {
        recursive: true,
      });
      await Deno.writeTextFile(
        join(root, "pattern-dev", "SKILL.md"),
        [
          "---",
          "name: pattern-dev",
          "description: Build Common Fabric patterns",
          "---",
          "",
          "# Pattern Dev",
        ].join("\n"),
      );
      await Deno.writeTextFile(
        join(root, "pattern-dev", "references", "guide.md"),
        "# Guide\nUse Cells carefully.\n",
      );
      const registry = await discoverHarnessSkills({
        skillsRoot: root,
        sandboxSkillsRoot: "/workspace/labs/skills",
      });
      const reads: HarnessSkillResourceRead[] = [];

      const output = await readSkillResourceTool.invoke(
        createContext(
          new FakeSandboxRuntime(),
          "/workspace",
          new FakeProcessRunner(),
          "observe",
          undefined,
          registry,
          reads,
        ),
        {
          skill: "pattern-dev",
          path: "references/guide.md",
          maxBytes: 7,
        },
      );

      assertEquals(output.status, "read");
      assertEquals(output.skill, "pattern-dev");
      assertEquals(output.path, "references/guide.md");
      assertEquals(output.kind, "reference");
      assertEquals(output.content, "# Guide");
      assertEquals(output.contentKind, "text");
      assertEquals(output.maxBytes, 7);
      assertEquals(output.truncated, true);
      assertEquals(output.cfcPromptRole, "context");
      assertEquals(output.digestMatchesRegistry, true);
      assertEquals(
        output.sandboxResourcePath?.endsWith(
          "/pattern-dev/references/guide.md",
        ),
        true,
      );
      assertEquals(reads.length, 1);
      assertEquals(reads[0].status, "read");
      assertEquals(reads[0].path, "references/guide.md");
      assertEquals(reads[0].observedDigest, output.observedDigest);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name: "read_skill_resource returns metadata only for binary resources",
  permissions: { read: true, write: true },
  async fn() {
    const root = await Deno.makeTempDir({
      prefix: "cf-harness-skill-resource-",
    });
    try {
      await Deno.mkdir(join(root, "pattern-dev", "assets"), {
        recursive: true,
      });
      await Deno.writeTextFile(
        join(root, "pattern-dev", "SKILL.md"),
        [
          "---",
          "name: pattern-dev",
          "description: Build Common Fabric patterns",
          "---",
        ].join("\n"),
      );
      await Deno.writeFile(
        join(root, "pattern-dev", "assets", "logo.bin"),
        new Uint8Array([0, 1, 2, 3]),
      );
      const registry = await discoverHarnessSkills({ skillsRoot: root });
      const reads: HarnessSkillResourceRead[] = [];

      const output = await readSkillResourceTool.invoke(
        createContext(
          new FakeSandboxRuntime(),
          "/workspace",
          new FakeProcessRunner(),
          "observe",
          undefined,
          registry,
          reads,
        ),
        { skill: "pattern-dev", path: "assets/logo.bin" },
      );

      assertEquals(output.status, "binary");
      assertEquals(output.content, undefined);
      assertEquals(output.contentKind, "binary");
      assertEquals(output.kind, "asset");
      assertEquals(output.truncated, false);
      assertEquals(output.digestMatchesRegistry, true);
      assertEquals(reads[0].status, "binary");
      assertEquals(reads[0].contentKind, "binary");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "read_skill_resource rejects unindexed resources and invalid traversal paths",
  permissions: { read: true, write: true },
  async fn() {
    const root = await Deno.makeTempDir({
      prefix: "cf-harness-skill-resource-",
    });
    try {
      await Deno.mkdir(join(root, "pattern-dev"), { recursive: true });
      await Deno.writeTextFile(
        join(root, "pattern-dev", "SKILL.md"),
        [
          "---",
          "name: pattern-dev",
          "description: Build Common Fabric patterns",
          "---",
        ].join("\n"),
      );
      const registry = await discoverHarnessSkills({ skillsRoot: root });
      const reads: HarnessSkillResourceRead[] = [];
      const context = createContext(
        new FakeSandboxRuntime(),
        "/workspace",
        new FakeProcessRunner(),
        "observe",
        undefined,
        registry,
        reads,
      );

      const traversal = await readSkillResourceTool.invoke(context, {
        skill: "pattern-dev",
        path: "../outside.md",
      });
      const missing = await readSkillResourceTool.invoke(context, {
        skill: "pattern-dev",
        path: "references/missing.md",
      });

      assertEquals(traversal.status, "error");
      assertEquals(traversal.error?.code, "resource_path_invalid");
      assertEquals(missing.status, "error");
      assertEquals(missing.error?.code, "resource_not_indexed");
      assertEquals(reads.map((read) => read.status), ["error", "error"]);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "read_skill_resource reports digest mismatches while returning call-time content",
  permissions: { read: true, write: true },
  async fn() {
    const root = await Deno.makeTempDir({
      prefix: "cf-harness-skill-resource-",
    });
    try {
      const guidePath = join(root, "pattern-dev", "references", "guide.md");
      await Deno.mkdir(join(root, "pattern-dev", "references"), {
        recursive: true,
      });
      await Deno.writeTextFile(
        join(root, "pattern-dev", "SKILL.md"),
        [
          "---",
          "name: pattern-dev",
          "description: Build Common Fabric patterns",
          "---",
        ].join("\n"),
      );
      const registryContent = "old guidance\n";
      const callTimeContent = "new guidance with extra bytes\n";
      await Deno.writeTextFile(guidePath, registryContent);
      const registry = await discoverHarnessSkills({ skillsRoot: root });
      await Deno.writeTextFile(guidePath, callTimeContent);
      const reads: HarnessSkillResourceRead[] = [];

      const output = await readSkillResourceTool.invoke(
        createContext(
          new FakeSandboxRuntime(),
          "/workspace",
          new FakeProcessRunner(),
          "observe",
          undefined,
          registry,
          reads,
        ),
        { skill: "pattern-dev", path: "references/guide.md" },
      );

      assertEquals(output.status, "read");
      assertEquals(output.content, callTimeContent);
      assertEquals(output.digestMatchesRegistry, false);
      assertEquals(output.registrySizeBytes, registryContent.length);
      assertEquals(output.observedSizeBytes, callTimeContent.length);
      assertEquals(
        output.diagnostics.map((diagnostic) => diagnostic.code),
        ["skill-resource-snapshot-mismatch"],
      );
      assertEquals(reads[0].digestMatchesRegistry, false);
      assertEquals(reads[0].observedSizeBytes, callTimeContent.length);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test("edit_file applies exact replacements and returns a unified diff", async () => {
  const original = "one\ntwo\nthree\n";
  const edited = "one\nTWO\nthree\n";
  const sandbox = new FakeSandboxRuntime([
    { stdout: original, stderr: "", exitCode: 0 },
    { stdout: "", stderr: "", exitCode: 0 },
    { stdout: edited, stderr: "", exitCode: 0 },
  ]);

  const output = await editFileTool.invoke(createContext(sandbox), {
    path: "notes/log.txt",
    edits: [{ oldText: "two\n", newText: "TWO\n" }],
  });

  assertEquals(output, {
    outputId: "run-1:edit_file:1",
    path: "/workspace/notes/log.txt",
    editsApplied: 1,
    replacements: 1,
    oldDigest: await digestText(original),
    newDigest: await digestText(edited),
    oldSizeBytes: original.length,
    newSizeBytes: edited.length,
    diff: [
      "--- /workspace/notes/log.txt",
      "+++ /workspace/notes/log.txt",
      "@@ -1,3 +1,3 @@",
      " one",
      "-two",
      "+TWO",
      " three",
      "",
    ].join("\n"),
  });
  const calls = stripCfcInvocationContexts(sandbox.calls);
  assertEquals(calls.map((call) => call.type), [
    "runShell",
    "runShell",
    "runShell",
  ]);
  if (calls[1]?.type !== "runShell") {
    throw new Error("expected edit_file write shell call");
  }
  assertEquals(calls[1].request.args, ["/workspace/notes/log.txt"]);
  assertEquals(calls[1].request.cwd, "/workspace");
  assertEquals(calls[1].request.stdinText, edited);
  assertEquals(
    sandbox.calls[1]?.request.cfcInvocationContext?.toolId,
    "edit_file",
  );
  assertEquals(
    sandbox.calls.map((call) =>
      call.type === "runShell"
        ? call.request.cfcInvocationContext?.toolOutputId
        : undefined
    ),
    [
      createToolOutputId("run-1", "edit_file", 1),
      createToolOutputId("run-1", "edit_file", 1),
      createToolOutputId("run-1", "edit_file", 1),
    ],
  );
  assertEquals(
    sandbox.calls[1]?.request.cfcInvocationContext?.inputs.stdin?.bytes,
    edited.length,
  );
});

Deno.test("edit_file labels write stdin with internal read CFC labels", async () => {
  const original = "alpha\nbeta\n";
  const edited = "alpha\nBETA\n";
  const readLabel = { confidentiality: ["did:key:file-secret"] };
  const trustedLabels: CfcLabelView = {
    version: 1,
    entries: [{
      path: ["args"],
      label: { confidentiality: ["did:key:trusted-path"] },
    }],
  };
  const sandbox = new FakeSandboxRuntime([
    {
      stdout: original,
      stderr: "",
      exitCode: 0,
      cfcResult: observedCfcResult(original, { stdoutLabel: readLabel }),
    },
    { stdout: "", stderr: "", exitCode: 0 },
    {
      stdout: edited,
      stderr: "",
      exitCode: 0,
      cfcResult: observedCfcResult(edited, {
        stdoutLabel: { confidentiality: ["did:key:verified-file"] },
      }),
    },
  ]);

  const output = await editFileTool.invoke(createContext(sandbox), {
    path: "notes/secret.txt",
    edits: [{ oldText: "beta\n", newText: "BETA\n" }],
    cfcInputLabels: trustedLabels,
  });

  if ("ok" in output) {
    throw new Error("expected successful edit_file output");
  }
  assertEquals(output.outputId, "run-1:edit_file:1");
  assertEquals(output.cfcResult?.stdout.label, {
    confidentiality: ["did:key:file-secret", "did:key:verified-file"],
  });
  assertEquals(output.cfcResult?.stdout.policy, "observed");
  if (output.cfcResult?.stdout.policy !== "observed") {
    throw new Error("expected observed CFC stdout");
  }
  assertEquals(
    output.cfcResult.stdout.segments.map((segment) => segment.text).join(""),
    [
      "--- /workspace/notes/secret.txt",
      "+++ /workspace/notes/secret.txt",
      "@@ -1,2 +1,2 @@",
      " alpha",
      "-beta",
      "+BETA",
      "",
    ].join("\n"),
  );
  assertEquals(
    sandbox.calls[1]?.request.cfcInvocationContext?.cfcInputLabels,
    {
      version: 1,
      entries: [
        {
          path: ["args"],
          label: { confidentiality: ["did:key:trusted-path"] },
        },
        {
          path: ["stdin"],
          label: { confidentiality: ["did:key:file-secret"] },
        },
      ],
    },
  );
});

Deno.test("edit_file omits CFC result when either internal read is unmediated", async () => {
  const original = "alpha\nbeta\n";
  const edited = "alpha\nBETA\n";
  const sandbox = new FakeSandboxRuntime([
    { stdout: original, stderr: "", exitCode: 0 },
    { stdout: "", stderr: "", exitCode: 0 },
    {
      stdout: edited,
      stderr: "",
      exitCode: 0,
      cfcResult: observedCfcResult(edited),
    },
  ]);

  const output = await editFileTool.invoke(createContext(sandbox), {
    path: "notes/secret.txt",
    edits: [{ oldText: "beta\n", newText: "BETA\n" }],
  });

  if ("ok" in output) {
    throw new Error("expected successful edit_file output");
  }
  assertEquals("cfcResult" in output, false);
});

Deno.test("edit_file returns separate hunks for distant edits", async () => {
  const original = Array.from(
    { length: 30 },
    (_, index) => `line ${String(index + 1).padStart(2, "0")}\n`,
  ).join("");
  const edited = original
    .replace("line 02\n", "line 02 changed\n")
    .replace("line 29\n", "line 29 changed\n");
  const sandbox = new FakeSandboxRuntime([
    { stdout: original, stderr: "", exitCode: 0 },
    { stdout: "", stderr: "", exitCode: 0 },
    { stdout: edited, stderr: "", exitCode: 0 },
  ]);

  const output = await editFileTool.invoke(createContext(sandbox), {
    path: "notes/distant.txt",
    edits: [
      { oldText: "line 02\n", newText: "line 02 changed\n" },
      { oldText: "line 29\n", newText: "line 29 changed\n" },
    ],
  });

  if ("ok" in output) {
    throw new Error("expected successful edit_file output");
  }
  assertStringIncludes(output.diff, "@@ -1,5 +1,5 @@");
  assertStringIncludes(output.diff, "-line 02");
  assertStringIncludes(output.diff, "+line 02 changed");
  assertStringIncludes(output.diff, "@@ -26,5 +26,5 @@");
  assertStringIncludes(output.diff, "-line 29");
  assertStringIncludes(output.diff, "+line 29 changed");
  assertEquals(output.diff.includes("line 15"), false);
  assertEquals(output.diff.match(/^@@ /gm)?.length, 2);
});

Deno.test("edit_file caps oversized diff output", async () => {
  const original = Array.from(
    { length: 450 },
    (_, index) => `old ${String(index + 1).padStart(3, "0")}\n`,
  ).join("");
  const edited = Array.from(
    { length: 450 },
    (_, index) => `new ${String(index + 1).padStart(3, "0")}\n`,
  ).join("");
  const sandbox = new FakeSandboxRuntime([
    { stdout: original, stderr: "", exitCode: 0 },
    { stdout: "", stderr: "", exitCode: 0 },
    { stdout: edited, stderr: "", exitCode: 0 },
  ]);

  const output = await editFileTool.invoke(createContext(sandbox), {
    path: "notes/large.txt",
    edits: [{ oldText: original, newText: edited }],
  });

  if ("ok" in output) {
    throw new Error("expected successful edit_file output");
  }
  assertStringIncludes(output.diff, "[diff truncated:");
  assertEquals(output.diff.split("\n").length, 401);
});

Deno.test("edit_file applies replaceAll edits with expected replacement counts", async () => {
  const original = "red blue red\n";
  const edited = "green blue green\n";
  const sandbox = new FakeSandboxRuntime([
    { stdout: original, stderr: "", exitCode: 0 },
    { stdout: "", stderr: "", exitCode: 0 },
    { stdout: edited, stderr: "", exitCode: 0 },
  ]);

  const output = await editFileTool.invoke(createContext(sandbox), {
    path: "notes/colors.txt",
    edits: [{
      oldText: "red",
      newText: "green",
      replaceAll: true,
      expectedReplacements: 2,
    }],
    expectedDigest: await digestText(original),
  });

  if ("ok" in output) {
    throw new Error("expected successful edit_file output");
  }
  assertEquals(output.path, "/workspace/notes/colors.txt");
  assertEquals(output.replacements, 2);
  assertEquals(output.editsApplied, 1);
});

Deno.test("edit_file rejects ambiguous single replacements without writing", async () => {
  const sandbox = new FakeSandboxRuntime([{
    stdout: "name: alpha\nname: beta\n",
    stderr: "",
    exitCode: 0,
  }]);

  const output = await editFileTool.invoke(createContext(sandbox), {
    path: "notes/names.txt",
    edits: [{ oldText: "name:", newText: "label:" }],
  });

  assertEquals(output.outputId, "run-1:edit_file:1");
  assertEquals(output.path, "/workspace/notes/names.txt");
  if (!("ok" in output) || output.ok !== false) {
    throw new Error("expected edit_file conflict output");
  }
  assertEquals(output.error.code, "edit_conflict");
  assertStringIncludes(output.error.detail ?? "", "matched 2 times");
  assertEquals(sandbox.calls.length, 1);
});

Deno.test("edit_file rejects stale expected digests without writing", async () => {
  const sandbox = new FakeSandboxRuntime([{
    stdout: "hello\n",
    stderr: "",
    exitCode: 0,
  }]);

  const output = await editFileTool.invoke(createContext(sandbox), {
    path: "notes/hello.txt",
    expectedDigest: "sha256:not-current",
    edits: [{ oldText: "hello", newText: "hi" }],
  });

  assertEquals(output.outputId, "run-1:edit_file:1");
  assertEquals(output.path, "/workspace/notes/hello.txt");
  if (!("ok" in output) || output.ok !== false) {
    throw new Error("expected edit_file conflict output");
  }
  assertEquals(output.error.code, "edit_conflict");
  assertStringIncludes(output.error.detail ?? "", "expected digest");
  assertEquals(sandbox.calls.length, 1);
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
  assertEquals(stripCfcInvocationContexts(sandbox.calls)[0], {
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
      cwd: "/workspace",
      stdinText: "line one\n",
    },
  });
  assertEquals(
    sandbox.calls[0]?.request.cfcInvocationContext?.toolId,
    "write_file",
  );
  assertEquals(
    sandbox.calls[0]?.request.cfcInvocationContext?.inputs.stdin?.bytes,
    "line one\n".length,
  );
  assertEquals(
    sandbox.calls[0]?.request.cfcInvocationContext?.cwd,
    "/workspace",
  );
  assertEquals(
    sandbox.calls[0]?.request.cfcInvocationContext?.toolOutputId,
    output.outputId,
  );
});

Deno.test("write_file tool merges explicit trusted CFC labels with write inputs", async () => {
  const sandbox = new FakeSandboxRuntime();
  const trustedLabels: CfcLabelView = {
    version: 1,
    entries: [{
      path: ["stdin"],
      label: {
        confidentiality: [{
          type: "test.cfc/TrustedInput",
          source: "unit-test",
        }],
      },
    }],
  };

  await writeFileTool.invoke(createContext(sandbox), {
    path: "notes/secret.txt",
    content: "secret\n",
    cfcInputLabels: trustedLabels,
  });

  assertEquals(
    sandbox.calls[0]?.request.cfcInvocationContext?.cfcInputLabels
      ?.entries[0],
    trustedLabels.entries[0],
  );
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
  assertEquals(stripCfcInvocationContexts(sandbox.calls)[1], {
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
      cwd: "/workspace/repo",
      stdinText: "line one\n",
    },
  });
  assertEquals(
    sandbox.calls[1]?.request.cfcInvocationContext?.cwd,
    "/workspace/repo",
  );
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

Deno.test("write_file tool denies reserved artifact paths before shelling out", async () => {
  const sandbox = new FakeSandboxRuntime();
  const output = await writeFileTool.invoke(
    createContext(
      sandbox,
      "/workspace",
      new FakeProcessRunner(),
      "observe",
      "/tmp/cf-harness-workspace/.cf-harness-artifacts",
    ),
    {
      path: ".cf-harness-artifacts/run-1/tool-output.json",
      content: "tainted",
      createParents: true,
    },
  );

  assertEquals(output, {
    outputId: "run-1:write_file:1",
    path: "/workspace/.cf-harness-artifacts/run-1/tool-output.json",
    ok: false,
    error: {
      type: "cf-harness.structured-file-tool-error",
      code: "permission_denied",
      message:
        "permission denied: /workspace/.cf-harness-artifacts/run-1/tool-output.json",
      path: "/workspace/.cf-harness-artifacts/run-1/tool-output.json",
      detail: RESERVED_ARTIFACT_PATH_DETAIL,
    },
  });
  assertEquals(sandbox.calls, []);
});

Deno.test("view_image tool attaches a workspace image without shelling out", async () => {
  const workspace = await Deno.realPath(await Deno.makeTempDir());
  await Deno.writeFile(join(workspace, "capture.png"), ONE_PIXEL_PNG);
  const sandbox = new FakeSandboxRuntime();

  const output = await viewImageTool.invoke(
    createContext(
      sandbox,
      "/workspace",
      new FakeProcessRunner(),
      "observe",
      undefined,
      undefined,
      [],
      workspace,
    ),
    { path: "capture.png" },
  );

  assertEquals(output.outputId, "run-1:view_image:1");
  assertEquals(output.path, "/workspace/capture.png");
  if (!("imageAttachment" in output)) {
    throw new Error("expected view_image success output");
  }
  assertEquals(output.mediaType, "image/png");
  assertEquals(output.bytes, ONE_PIXEL_PNG.byteLength);
  assertEquals(output.imageAttachment.hostPath, join(workspace, "capture.png"));
  assertEquals(sandbox.calls, []);
});

Deno.test("view_image tool denies reserved artifact paths", async () => {
  const workspace = await Deno.realPath(await Deno.makeTempDir());
  const artifactRoot = join(workspace, ".cf-harness-artifacts");
  await Deno.mkdir(artifactRoot, { recursive: true });
  await Deno.writeFile(join(artifactRoot, "capture.png"), ONE_PIXEL_PNG);
  const sandbox = new FakeSandboxRuntime();

  const output = await viewImageTool.invoke(
    createContext(
      sandbox,
      "/workspace",
      new FakeProcessRunner(),
      "observe",
      artifactRoot,
      undefined,
      [],
      workspace,
    ),
    { path: ".cf-harness-artifacts/capture.png" },
  );

  assertEquals(output, {
    outputId: "run-1:view_image:1",
    path: "/workspace/.cf-harness-artifacts/capture.png",
    ok: false,
    error: {
      type: "cf-harness.structured-file-tool-error",
      code: "permission_denied",
      message:
        "permission denied: /workspace/.cf-harness-artifacts/capture.png",
      path: "/workspace/.cf-harness-artifacts/capture.png",
      detail: RESERVED_ARTIFACT_PATH_DETAIL,
    },
  });
  assertEquals(sandbox.calls, []);
});
