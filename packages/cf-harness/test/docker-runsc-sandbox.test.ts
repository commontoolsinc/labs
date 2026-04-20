import { assertEquals, assertThrows } from "@std/assert";
import {
  DockerRunscSandboxRuntime,
  resolveDockerRunscSandboxConfig,
} from "../src/sandbox/docker-runsc.ts";
import type {
  ProcessRunner,
  ProcessRunRequest,
  ProcessRunResult,
} from "../src/sandbox/process-runner.ts";

class FakeProcessRunner implements ProcessRunner {
  requests: ProcessRunRequest[] = [];

  constructor(private readonly result: ProcessRunResult) {}

  run(request: ProcessRunRequest): Promise<ProcessRunResult> {
    this.requests.push(request);
    return Promise.resolve(this.result);
  }
}

Deno.test("resolveDockerRunscSandboxConfig fills the expected defaults", () => {
  const config = resolveDockerRunscSandboxConfig({
    workspaceHostPath: "/host/project",
  });
  assertEquals(config.kind, "docker-runsc-cfc");
  assertEquals(config.dockerBinary, "docker");
  assertEquals(config.runtimeName, "runsc-cfc");
  assertEquals(config.image, "alpine:3.20");
  assertEquals(config.workspaceMountPath, "/workspace");
  assertEquals(config.shellPath, "/bin/sh");
  assertEquals(config.dockerNetworkMode, "none");
  assertEquals(config.extraDockerArgs, []);
});

Deno.test("DockerRunscSandboxRuntime builds a docker run invocation", async () => {
  const runner = new FakeProcessRunner({
    stdout: "hello\n",
    stderr: "",
    exitCode: 0,
  });
  const runtime = new DockerRunscSandboxRuntime(
    resolveDockerRunscSandboxConfig({
      workspaceHostPath: "/host/project",
      image: "sandbox:latest",
    }),
    runner,
  );

  const result = await runtime.run({
    argv: ["/bin/echo", "hello"],
    cwd: "subdir",
    stdinText: "ignored",
    timeoutMs: 500,
  });

  assertEquals(result.stdout, "hello\n");
  assertEquals(runner.requests.length, 1);
  assertEquals(runner.requests[0], {
    command: "docker",
    args: [
      "run",
      "--rm",
      "-i",
      "--runtime",
      "runsc-cfc",
      "--network",
      "none",
      "--mount",
      "type=bind,src=/host/project,dst=/workspace",
      "-w",
      "/workspace/subdir",
      "sandbox:latest",
      "/bin/echo",
      "hello",
    ],
    stdinText: "ignored",
    timeoutMs: 500,
  });
});

Deno.test("DockerRunscSandboxRuntime runShell uses the configured shell and resolved cwd", async () => {
  const runner = new FakeProcessRunner({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  const runtime = new DockerRunscSandboxRuntime(
    resolveDockerRunscSandboxConfig({
      workspaceHostPath: "/host/project",
    }),
    runner,
  );

  await runtime.runShell({
    command: "pwd",
    cwd: "/workspace/demo",
    args: ["arg-1", "arg-2"],
  });

  assertEquals(runner.requests[0], {
    command: "docker",
    args: [
      "run",
      "--rm",
      "--runtime",
      "runsc-cfc",
      "--network",
      "none",
      "--mount",
      "type=bind,src=/host/project,dst=/workspace",
      "-w",
      "/workspace/demo",
      "alpine:3.20",
      "/bin/sh",
      "-lc",
      "pwd",
      "/bin/sh",
      "arg-1",
      "arg-2",
    ],
    stdinText: undefined,
    timeoutMs: undefined,
  });
});

Deno.test("DockerRunscSandboxRuntime resolvePath rejects paths outside the workspace", () => {
  const runtime = new DockerRunscSandboxRuntime(
    resolveDockerRunscSandboxConfig({
      workspaceHostPath: "/host/project",
    }),
  );

  assertThrows(
    () => runtime.resolvePath("../../escape", "/workspace/demo"),
    Error,
    "path escapes workspace root",
  );
});
