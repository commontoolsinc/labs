import { assertEquals, assertMatch, assertThrows } from "@std/assert";
import {
  DEFAULT_DOCKER_RUNSC_IMAGE,
  DockerRunscSandboxRuntime,
  resolveDefaultContainerUser,
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
  assertEquals(
    config.image,
    "us-docker.pkg.dev/commontools-core/common-fabric/sandbox-kitchensink:latest",
  );
  assertEquals(config.workspaceMountPath, "/workspace");
  assertEquals(config.shellPath, "/bin/sh");
  assertEquals(config.dockerNetworkMode, "none");
  assertEquals(config.additionalMounts, []);
  assertEquals(config.extraDockerArgs, []);
});

Deno.test("resolveDefaultContainerUser omits default --user on macOS", () => {
  assertEquals(resolveDefaultContainerUser("darwin"), undefined);
});

Deno.test("resolveDefaultContainerUser keeps host UID/GID default on Linux", () => {
  if (Deno.build.os === "windows") {
    return;
  }

  assertMatch(resolveDefaultContainerUser("linux") ?? "", /^\d+:\d+$/);
});

Deno.test("DockerRunscSandboxRuntime builds a docker run invocation", async () => {
  const runner = new FakeProcessRunner({
    stdout: "hello\n",
    stderr: "",
    exitCode: 0,
  });
  const config = resolveDockerRunscSandboxConfig({
    workspaceHostPath: "/host/project",
    image: "sandbox:latest",
  });
  const runtime = new DockerRunscSandboxRuntime(
    config,
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
      ...(config.containerUser !== undefined
        ? ["--user", config.containerUser]
        : []),
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

Deno.test("DockerRunscSandboxRuntime describe preserves custom CFC runtime aliases", () => {
  const runtime = new DockerRunscSandboxRuntime(
    resolveDockerRunscSandboxConfig({
      workspaceHostPath: "/host/project",
      runtimeName: "corp-runsc-prod",
    }),
  );
  const description = runtime.describe();
  if (description.cfc === undefined) {
    throw new Error("expected CFC sandbox description");
  }

  assertEquals(description.cfc.runtimeRequested, true);
  assertEquals(description.cfc.runtimeName, "corp-runsc-prod");
});

Deno.test("resolveDockerRunscSandboxConfig normalizes a Fabric FUSE mount", () => {
  const config = resolveDockerRunscSandboxConfig({
    workspaceHostPath: "/host/project",
    additionalMounts: [{
      kind: "fabric-fuse",
      hostPath: "/tmp/cf-fuse",
    }],
  });

  assertEquals(config.additionalMounts, [{
    kind: "fabric-fuse",
    hostPath: "/tmp/cf-fuse",
    sandboxPath: "/fabric",
    readOnly: false,
  }]);
});

Deno.test("resolveDockerRunscSandboxConfig rejects overlapping sandbox roots", () => {
  assertThrows(
    () =>
      resolveDockerRunscSandboxConfig({
        workspaceHostPath: "/host/project",
        additionalMounts: [{
          kind: "fabric-fuse",
          hostPath: "/tmp/cf-fuse",
          sandboxPath: "/workspace/fabric",
        }],
      }),
    Error,
    "sandbox mount paths overlap",
  );
});

Deno.test("DockerRunscSandboxRuntime runShell honors an explicit container user override", async () => {
  const runner = new FakeProcessRunner({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  const runtime = new DockerRunscSandboxRuntime(
    resolveDockerRunscSandboxConfig({
      workspaceHostPath: "/host/project",
      containerUser: "1234:2345",
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
      "--user",
      "1234:2345",
      "--mount",
      "type=bind,src=/host/project,dst=/workspace",
      "-w",
      "/workspace/demo",
      DEFAULT_DOCKER_RUNSC_IMAGE,
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

Deno.test("DockerRunscSandboxRuntime accepts workspace paths when the mount path has a trailing slash", () => {
  const runtime = new DockerRunscSandboxRuntime(
    resolveDockerRunscSandboxConfig({
      workspaceHostPath: "/host/project",
      workspaceMountPath: "/workspace/",
    }),
  );

  assertEquals(runtime.defaultWorkingDirectory(), "/workspace");
  assertEquals(
    runtime.resolvePath("notes/todo.txt"),
    "/workspace/notes/todo.txt",
  );
  assertEquals(
    runtime.isPathWithinWorkspace("/workspace/notes/todo.txt"),
    true,
  );
});

Deno.test("DockerRunscSandboxRuntime mounts Fabric separately and accepts Fabric paths", async () => {
  const runner = new FakeProcessRunner({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  const runtime = new DockerRunscSandboxRuntime(
    resolveDockerRunscSandboxConfig({
      workspaceHostPath: "/host/project",
      image: "sandbox:latest",
      additionalMounts: [{
        kind: "fabric-fuse",
        hostPath: "/tmp/cf-fuse",
        readOnly: true,
      }],
    }),
    runner,
  );

  assertEquals(
    runtime.resolvePath("/fabric/home/pieces"),
    "/fabric/home/pieces",
  );
  assertEquals(runtime.isPathWithinWorkspace("/fabric/home"), false);
  assertEquals(runtime.isPathWithinAllowedRoots("/fabric/home"), true);

  const description = runtime.describe();
  assertEquals(description.cfc?.mounts, [
    { kind: "workspace", sandboxPath: "/workspace", readOnly: false },
    { kind: "fabric-fuse", sandboxPath: "/fabric", readOnly: true },
  ]);

  await runtime.run({
    argv: ["/bin/pwd"],
    cwd: "/fabric/home",
  });

  assertEquals(runner.requests[0]?.args, [
    "run",
    "--rm",
    "--runtime",
    "runsc-cfc",
    "--network",
    "none",
    ...(runtime.config.containerUser !== undefined
      ? ["--user", runtime.config.containerUser]
      : []),
    "--mount",
    "type=bind,src=/host/project,dst=/workspace",
    "--mount",
    "type=bind,src=/tmp/cf-fuse,dst=/fabric,readonly",
    "-w",
    "/fabric/home",
    "sandbox:latest",
    "/bin/pwd",
  ]);
});
