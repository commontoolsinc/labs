import { assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { normalize } from "@std/path/posix";
import {
  createFileSystemHarnessArtifactStore,
  readHarnessRunArtifacts,
  readHarnessRunState,
  readHarnessTranscript,
} from "../src/artifacts.ts";
import { createToolOutputId } from "../src/contracts/tool-result.ts";
import { CfHarnessEngine } from "../src/engine.ts";
import { CfHarnessPromptLoop } from "../src/prompt-loop.ts";
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

  run(_request: SandboxCommandRequest): Promise<SandboxCommandResult> {
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }

  runShell(request: SandboxShellRequest): Promise<SandboxCommandResult> {
    this.shellRequests.push(request);
    return Promise.resolve(
      this.shellResults.shift() ?? { stdout: "", stderr: "", exitCode: 0 },
    );
  }
}

Deno.test({
  name:
    "CfHarnessEngine persists run state and tool output artifacts when artifactRoot is configured",
  permissions: { read: true, write: true },
  async fn() {
    const artifactRoot = await Deno.makeTempDir({
      prefix: "cf-harness-artifacts-",
    });
    try {
      const engine = new CfHarnessEngine({
        artifactRoot,
        sandboxRuntime: new FakeSandboxRuntime([
          { stdout: "hello\n", stderr: "", exitCode: 0 },
        ]),
        runId: "run-artifacts",
        cfcEnforcementMode: "observe",
        now: (() => {
          const timestamps = [
            "2026-04-15T21:00:00.000Z",
            "2026-04-15T21:00:01.000Z",
            "2026-04-15T21:00:02.000Z",
          ];
          return () => timestamps.shift() ?? "2026-04-15T21:00:03.000Z";
        })(),
      });

      const result = await engine.invokeBuiltinTool("bash", {
        command: "echo hello",
      });
      const runRoot = join(artifactRoot, "run-artifacts");
      const persistedState = await readHarnessRunState(
        join(runRoot, "run-state.json"),
      );

      assertEquals(
        result.resultRef.artifactPath,
        join(
          runRoot,
          "tool-outputs",
          "run-artifacts_bash_1-bash.json",
        ),
      );
      assertEquals(
        JSON.parse(await Deno.readTextFile(result.resultRef.artifactPath!)),
        {
          outputId: createToolOutputId("run-artifacts", "bash", 1),
          stdout: "hello\n",
          stderr: "",
          exitCode: 0,
          cwd: "/workspace",
        },
      );
      assertEquals(persistedState, {
        runId: "run-artifacts",
        status: "completed",
        createdAt: "2026-04-15T21:00:00.000Z",
        updatedAt: "2026-04-15T21:00:03.000Z",
        cfcEnforcementMode: "observe",
        currentDir: "/workspace",
        artifactRoot: runRoot,
        policyEvents: [],
        toolOutputs: [result.resultRef],
      });
    } finally {
      await Deno.remove(artifactRoot, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "CfHarnessPromptLoop persists the transcript when artifactRoot is configured",
  permissions: { read: true, write: true },
  async fn() {
    const artifactRoot = await Deno.makeTempDir({
      prefix: "cf-harness-transcript-",
    });
    try {
      const loop = new CfHarnessPromptLoop({
        apiKey: "test-key",
        engine: new CfHarnessEngine({
          artifactRoot,
          sandboxRuntime: new FakeSandboxRuntime([
            { stdout: "hello from file", stderr: "", exitCode: 0 },
          ]),
          runId: "run-loop-persisted",
          model: "gpt-5.4",
          now: (() => {
            const timestamps = [
              "2026-04-15T21:10:00.000Z",
              "2026-04-15T21:10:01.000Z",
              "2026-04-15T21:10:02.000Z",
              "2026-04-15T21:10:03.000Z",
              "2026-04-15T21:10:04.000Z",
              "2026-04-15T21:10:05.000Z",
              "2026-04-15T21:10:06.000Z",
            ];
            return () => timestamps.shift() ?? "2026-04-15T21:10:07.000Z";
          })(),
        }),
        fetchFn: (_input, init) => {
          const body = JSON.parse(String(init?.body)) as {
            messages: Array<{ role: string }>;
          };
          const payload = body.messages.some((message) =>
              message.role === "tool"
            )
            ? {
              choices: [{
                index: 0,
                message: {
                  role: "assistant",
                  content: "Persisted summary.",
                },
              }],
            }
            : {
              choices: [{
                index: 0,
                message: {
                  role: "assistant",
                  content: "",
                  tool_calls: [{
                    id: "call-1",
                    type: "function",
                    function: {
                      name: "read_file",
                      arguments: JSON.stringify({ path: "notes/todo.txt" }),
                    },
                  }],
                },
              }],
            };
          return Promise.resolve(
            new Response(JSON.stringify(payload), { status: 200 }),
          );
        },
      });

      const result = await loop.runPrompt({
        prompt: "Summarize the todo file.",
      });

      const runRoot = join(artifactRoot, "run-loop-persisted");
      const transcriptPath = join(runRoot, "transcript.json");
      const persistedState = await readHarnessRunState(
        join(runRoot, "run-state.json"),
      );

      assertEquals(result.runState.transcriptPath, transcriptPath);
      assertEquals(
        await readHarnessTranscript(transcriptPath),
        result.transcript,
      );
      assertEquals(persistedState.transcriptPath, transcriptPath);
      assertEquals(persistedState.artifactRoot, runRoot);
      assertEquals(persistedState.policyEvents, []);
    } finally {
      await Deno.remove(artifactRoot, { recursive: true });
    }
  },
});

Deno.test("createFileSystemHarnessArtifactStore rejects path-traversal run ids", () => {
  assertThrows(
    () =>
      createFileSystemHarnessArtifactStore({
        artifactRoot: "/tmp/cf-harness-artifacts",
        runId: "../escape",
      }),
    Error,
    "runId must be a simple path segment",
  );
});

Deno.test({
  name: "readHarnessRunArtifacts confines transcript loading to the run root",
  permissions: { read: true, write: true },
  async fn() {
    const artifactRoot = await Deno.makeTempDir({
      prefix: "cf-harness-read-artifacts-",
    });
    try {
      const runRoot = join(artifactRoot, "run-1");
      const runStatePath = join(runRoot, "run-state.json");
      const defaultTranscriptPath = join(runRoot, "transcript.json");
      const outsideTranscriptPath = join(artifactRoot, "outside.json");

      await Deno.mkdir(runRoot, { recursive: true });
      await Deno.writeTextFile(
        runStatePath,
        JSON.stringify({
          runId: "run-1",
          status: "completed",
          createdAt: "2026-04-17T20:00:00.000Z",
          updatedAt: "2026-04-17T20:00:01.000Z",
          cfcEnforcementMode: "observe",
          transcriptPath: outsideTranscriptPath,
          policyEvents: [],
          toolOutputs: [],
        }),
      );
      await Deno.writeTextFile(
        defaultTranscriptPath,
        JSON.stringify([{ role: "assistant", content: "inside transcript" }]),
      );
      await Deno.writeTextFile(
        outsideTranscriptPath,
        JSON.stringify([{ role: "assistant", content: "outside transcript" }]),
      );

      const artifacts = await readHarnessRunArtifacts(runRoot);

      assertEquals(artifacts.transcriptPath, defaultTranscriptPath);
      assertEquals(artifacts.transcript, [{
        role: "assistant",
        content: "inside transcript",
      }]);
    } finally {
      await Deno.remove(artifactRoot, { recursive: true });
    }
  },
});
