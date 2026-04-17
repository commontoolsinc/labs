import { assertEquals, assertRejects } from "@std/assert";
import { createToolOutputId } from "../src/contracts/tool-result.ts";
import { CfHarnessEngine } from "../src/engine.ts";
import type {
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxRuntime,
  SandboxShellRequest,
} from "../src/sandbox/types.ts";

class FakeSandboxRuntime implements SandboxRuntime {
  readonly kind = "docker-runsc-cfc" as const;
  readonly shellRequests: SandboxShellRequest[] = [];

  constructor(
    private readonly shellResults: SandboxCommandResult[] = [],
    private readonly shellError?: Error,
  ) {}

  resolvePath(path: string): string {
    return path.startsWith("/") ? path : `/workspace/${path}`;
  }

  defaultWorkingDirectory(): string {
    return "/workspace";
  }

  run(_request: SandboxCommandRequest): Promise<SandboxCommandResult> {
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }

  runShell(request: SandboxShellRequest): Promise<SandboxCommandResult> {
    this.shellRequests.push(request);
    if (this.shellError) {
      return Promise.reject(this.shellError);
    }
    return Promise.resolve(
      this.shellResults.shift() ?? { stdout: "", stderr: "", exitCode: 0 },
    );
  }
}

Deno.test("CfHarnessEngine builds a default docker-runsc sandbox when given a workspace path", () => {
  const engine = new CfHarnessEngine({
    workspaceHostPath: "/host/project",
    now: () => "2026-04-15T19:00:00.000Z",
  });

  assertEquals(engine.config.sandbox, undefined);
  assertEquals(engine.sandbox.kind, "docker-runsc-cfc");
  assertEquals(engine.getRunState(), {
    runId: engine.getRunState().runId,
    status: "pending",
    createdAt: "2026-04-15T19:00:00.000Z",
    updatedAt: "2026-04-15T19:00:00.000Z",
    cfcEnforcementMode: "disabled",
    policyEvents: [],
    toolOutputs: [],
  });
});

Deno.test("CfHarnessEngine records tool outputs into run state on success", async () => {
  const sandbox = new FakeSandboxRuntime([
    { stdout: "one\n", stderr: "", exitCode: 0 },
    { stdout: "two\n", stderr: "", exitCode: 0 },
  ]);
  const engine = new CfHarnessEngine({
    sandboxRuntime: sandbox,
    runId: "run-1",
    cfcEnforcementMode: "observe",
    now: (() => {
      const timestamps = [
        "2026-04-15T19:00:00.000Z",
        "2026-04-15T19:00:01.000Z",
        "2026-04-15T19:00:02.000Z",
        "2026-04-15T19:00:03.000Z",
        "2026-04-15T19:00:04.000Z",
      ];
      return () => timestamps.shift() ?? "2026-04-15T19:00:05.000Z";
    })(),
  });

  const first = await engine.invokeBuiltinTool("bash", { command: "echo one" });
  const second = await engine.invokeBuiltinTool("bash", {
    command: "echo two",
  });

  assertEquals(first.resultRef, {
    type: "cf-harness.tool-result-ref",
    outputId: createToolOutputId("run-1", "bash", 1),
    toolId: "bash",
    runId: "run-1",
  });
  assertEquals(second.resultRef, {
    type: "cf-harness.tool-result-ref",
    outputId: createToolOutputId("run-1", "bash", 2),
    toolId: "bash",
    runId: "run-1",
  });
  assertEquals(engine.getRunState(), {
    runId: "run-1",
    status: "completed",
    createdAt: "2026-04-15T19:00:00.000Z",
    updatedAt: "2026-04-15T19:00:05.000Z",
    cfcEnforcementMode: "observe",
    policyEvents: [],
    toolOutputs: [first.resultRef, second.resultRef],
  });
});

Deno.test("CfHarnessEngine marks the run as failed when a tool invocation errors", async () => {
  const engine = new CfHarnessEngine({
    sandboxRuntime: new FakeSandboxRuntime([], new Error("sandbox boom")),
    runId: "run-fail",
    cfcEnforcementMode: "observe",
    now: (() => {
      const timestamps = [
        "2026-04-15T19:10:00.000Z",
        "2026-04-15T19:10:01.000Z",
      ];
      return () => timestamps.shift() ?? "2026-04-15T19:10:02.000Z";
    })(),
  });

  await assertRejects(
    () => engine.invokeBuiltinTool("bash", { command: "false" }),
    Error,
    "sandbox boom",
  );

  assertEquals(engine.getRunState(), {
    runId: "run-fail",
    status: "failed",
    createdAt: "2026-04-15T19:10:00.000Z",
    updatedAt: "2026-04-15T19:10:02.000Z",
    cfcEnforcementMode: "observe",
    policyEvents: [],
    toolOutputs: [],
  });
});
