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

  constructor(private readonly results: ProcessRunResult[]) {}

  run(request: ProcessRunRequest): Promise<ProcessRunResult> {
    this.requests.push(request);
    const result = this.results.shift();
    if (result === undefined) {
      throw new Error(`unexpected process request: ${request.command}`);
    }
    return Promise.resolve(result);
  }
}

const dockerLifecycleResults = (
  options: {
    containerId?: string;
    stdout?: string;
    stderr?: string;
    exitCode?: number;
  } = {},
): ProcessRunResult[] => [
  {
    stdout: `${options.containerId ?? "container-123"}\n`,
    stderr: "",
    exitCode: 0,
  },
  {
    stdout: options.stdout ?? "hello\n",
    stderr: options.stderr ?? "",
    exitCode: options.exitCode ?? 0,
  },
  {
    stdout: `${options.exitCode ?? 0}\n`,
    stderr: "",
    exitCode: 0,
  },
  {
    stdout: "",
    stderr: "",
    exitCode: 0,
  },
];

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
  assertEquals(config.cfcResultDir, undefined);
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

Deno.test("DockerRunscSandboxRuntime builds a docker create/start/wait/rm invocation", async () => {
  const runner = new FakeProcessRunner(dockerLifecycleResults());
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
  assertEquals(result.exitCode, 0);
  assertEquals(runner.requests.length, 4);
  assertEquals(runner.requests[0], {
    command: "docker",
    args: [
      "create",
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
  });
  assertEquals(runner.requests[1], {
    command: "docker",
    args: [
      "start",
      "--attach",
      "--interactive",
      "container-123",
    ],
    stdinText: "ignored",
    timeoutMs: 500,
  });
  assertEquals(runner.requests[2], {
    command: "docker",
    args: ["wait", "container-123"],
  });
  assertEquals(runner.requests[3], {
    command: "docker",
    args: ["rm", "-f", "container-123"],
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
  const runner = new FakeProcessRunner(dockerLifecycleResults({ stdout: "" }));
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
      "create",
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
  });
});

Deno.test("DockerRunscSandboxRuntime attaches observed CFC sidecar output", async () => {
  const cfcResultDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${cfcResultDir}/container-123.json`,
      JSON.stringify({
        version: 1,
        containerId: "container-123",
        sandboxId: "sandbox-123",
        waitStatus: 0,
        cfcTaint: {
          string: "{conf: public, integ: empty}",
          xattrJSON: {},
        },
      }),
    );
    const runner = new FakeProcessRunner(
      dockerLifecycleResults({ stdout: "public\n", stderr: "note\n" }),
    );
    const runtime = new DockerRunscSandboxRuntime(
      resolveDockerRunscSandboxConfig({
        workspaceHostPath: "/host/project",
        cfcResultDir,
      }),
      runner,
    );

    const result = await runtime.run({ argv: ["/bin/echo", "public"] });

    assertEquals(result.stdout, "public\n");
    if (result.cfcResult === undefined) {
      throw new Error("missing cfcResult");
    }
    if (result.cfcResult.stdout.policy !== "observed") {
      throw new Error("expected observed stdout");
    }
    assertEquals(result.cfcResult.stdout.segments[0].text, "public\n");
    if (result.cfcResult.stderr.policy !== "observed") {
      throw new Error("expected observed stderr");
    }
    assertEquals(result.cfcResult.stderr.segments[0].text, "note\n");
    assertEquals(result.cfcResult.exitCode, {
      policy: "observed",
      label: {},
      value: 0,
    });
  } finally {
    await Deno.remove(cfcResultDir, { recursive: true });
  }
});

Deno.test("DockerRunscSandboxRuntime makes tainted sidecar output opaque", async () => {
  const cfcResultDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${cfcResultDir}/container-123.json`,
      JSON.stringify({
        version: 1,
        containerId: "container-123",
        waitStatus: 0,
        cfcTaint: {
          string: "{conf: alice, integ: empty}",
          xattrJSON: { confidentiality: ["did:key:alice"] },
        },
      }),
    );
    const runner = new FakeProcessRunner(
      dockerLifecycleResults({ stdout: "secret\n", exitCode: 3 }),
    );
    const runtime = new DockerRunscSandboxRuntime(
      resolveDockerRunscSandboxConfig({
        workspaceHostPath: "/host/project",
        cfcResultDir,
      }),
      runner,
    );

    const result = await runtime.run({ argv: ["/bin/cat", "secret.txt"] });

    assertEquals(result.stdout, "secret\n");
    assertEquals(result.exitCode, 3);
    if (result.cfcResult === undefined) {
      throw new Error("missing cfcResult");
    }
    assertEquals(result.cfcResult.stdout, {
      channel: "stdout",
      policy: "opaque",
      label: { confidentiality: ["did:key:alice"] },
      byteLength: 7,
    });
    assertEquals(result.cfcResult.exitCode, {
      policy: "opaque",
      label: { confidentiality: ["did:key:alice"] },
    });
  } finally {
    await Deno.remove(cfcResultDir, { recursive: true });
  }
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
