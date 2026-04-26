import { assertEquals, assertRejects } from "@std/assert";
import {
  buildCfHarnessOperatorSystemPrompt,
  type CfHarnessCliIO,
  type CfHarnessCliSignalHandler,
  createCfHarnessBatchResult,
  formatCfHarnessCliResult,
  formatCfHarnessCliUsage,
  formatCfHarnessTranscriptEvent,
  installCfHarnessSignalHandlers,
  parseCfHarnessCliArgs,
  resolveCfHarnessCliSystemPrompt,
  runCfHarnessCli,
} from "../src/cli.ts";
import { CfHarnessEngine } from "../src/engine.ts";
import type {
  HarnessPromptLoopResult,
  RunHarnessPromptOptions,
} from "../src/prompt-loop.ts";

const createIoBuffers = (): {
  io: CfHarnessCliIO;
  stdout: string[];
  stderr: string[];
} => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
    stdout,
    stderr,
  };
};

Deno.test("parseCfHarnessCliArgs resolves defaults from cwd and positional prompt text", async () => {
  const parsed = await parseCfHarnessCliArgs(
    ["Summarize", "this", "workspace"],
    {
      cwd: "/tmp/project",
      env: {},
    },
  );

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.workspace, "/tmp/project");
  assertEquals(parsed.prompt, "Summarize this workspace");
  assertEquals(parsed.model, "gpt-5.4");
  assertEquals(parsed.gatewayAuthMode, "bearer");
  assertEquals(parsed.outputMode, "operator");
  assertEquals(parsed.streamEvents, false);
  assertEquals(parsed.promptSlotRole, "direct-command");
  assertEquals(parsed.artifactRoot, "/tmp/project/.cf-harness-artifacts");
  assertEquals(parsed.maxModelTurns, 8);
  assertEquals(parsed.printTranscript, false);
});

Deno.test("parseCfHarnessCliArgs supports prompt files and mode overrides", async () => {
  const parsed = await parseCfHarnessCliArgs(
    [
      "--workspace",
      "/tmp/project",
      "--prompt-file",
      "/tmp/prompt.txt",
      "--cfc-enforcement-mode",
      "observe",
      "--max-model-turns",
      "5",
    ],
    {
      env: {},
      readTextFile: (path) => {
        assertEquals(path, "/tmp/prompt.txt");
        return Promise.resolve("Prompt from file.");
      },
    },
  );

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.prompt, "Prompt from file.");
  assertEquals(parsed.gatewayAuthMode, "bearer");
  assertEquals(parsed.cfcEnforcementModeOverride, "observe");
  assertEquals(parsed.maxModelTurns, 5);
});

Deno.test("parseCfHarnessCliArgs rejects malformed max-model-turns values", async () => {
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        ["--prompt", "hi", "--max-model-turns", "2.5"],
        {
          cwd: "/tmp/project",
          env: {},
        },
      ),
    Error,
    "--max-model-turns must be a positive integer",
  );
});

Deno.test("parseCfHarnessCliArgs supports gateway auth mode override", async () => {
  const parsed = await parseCfHarnessCliArgs(
    ["--prompt", "hi", "--gateway-auth-mode", "none"],
    {
      cwd: "/tmp/project",
      env: {},
    },
  );

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.gatewayAuthMode, "none");
});

Deno.test("parseCfHarnessCliArgs supports batch output mode override", async () => {
  const parsed = await parseCfHarnessCliArgs(
    ["--prompt", "hi", "--output-mode", "batch"],
    {
      cwd: "/tmp/project",
      env: {},
    },
  );

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.outputMode, "batch");
});

Deno.test("parseCfHarnessCliArgs supports stream-events flag", async () => {
  const parsed = await parseCfHarnessCliArgs(
    ["--prompt", "hi", "--stream-events"],
    {
      cwd: "/tmp/project",
      env: {},
    },
  );

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.streamEvents, true);
});

Deno.test("parseCfHarnessCliArgs supports allowed tools and result json path", async () => {
  const parsed = await parseCfHarnessCliArgs(
    [
      "--prompt",
      "hi",
      "--allow-tool",
      "read_file",
      "--allow-tool",
      "bash",
      "--result-json-path",
      "results/output.json",
    ],
    {
      cwd: "/tmp/project",
      env: {},
    },
  );

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.allowedToolIds, ["read_file", "bash"]);
  assertEquals(parsed.resultJsonPath, "/tmp/project/results/output.json");
});

Deno.test("parseCfHarnessCliArgs resolves focus-root relative to workspace", async () => {
  const parsed = await parseCfHarnessCliArgs(
    [
      "--workspace",
      "/tmp/project",
      "--focus-root",
      "packages/cf-harness",
      "--prompt",
      "hi",
    ],
    {
      env: {},
    },
  );

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.focusRoot, "/tmp/project/packages/cf-harness");
});

Deno.test("parseCfHarnessCliArgs resolves an initial cwd within the workspace", async () => {
  const parsed = await parseCfHarnessCliArgs(
    [
      "--workspace",
      "/tmp/project",
      "--cwd",
      ".ops",
      "--prompt",
      "hi",
    ],
    {
      env: {},
    },
  );

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.cwd, "/workspace/.ops");
});

Deno.test("parseCfHarnessCliArgs rejects an initial cwd outside the workspace", async () => {
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        [
          "--workspace",
          "/tmp/project",
          "--cwd",
          "..",
          "--prompt",
          "hi",
        ],
        {
          env: {},
        },
      ),
    Error,
    "--cwd must stay within the workspace",
  );
});

Deno.test("parseCfHarnessCliArgs supports prompt-slot-role override", async () => {
  const parsed = await parseCfHarnessCliArgs(
    ["--prompt", "hi", "--prompt-slot-role", "context"],
    {
      cwd: "/tmp/project",
      env: {},
    },
  );

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.promptSlotRole, "context");
});

Deno.test("parseCfHarnessCliArgs tolerates a leading task-runner separator", async () => {
  const parsed = await parseCfHarnessCliArgs(
    ["--", "--prompt", "hi", "--gateway-auth-mode", "none"],
    {
      cwd: "/tmp/project",
      env: {},
    },
  );

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.prompt, "hi");
  assertEquals(parsed.gatewayAuthMode, "none");
});

Deno.test("parseCfHarnessCliArgs prefers CF_HARNESS_API_KEY over OPENAI_API_KEY", async () => {
  const parsed = await parseCfHarnessCliArgs(
    ["--prompt", "hi"],
    {
      cwd: "/tmp/project",
      env: {
        CF_HARNESS_API_KEY: "cf-key",
        OPENAI_API_KEY: "openai-key",
      },
    },
  );

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.apiKey, "cf-key");
  assertEquals(parsed.apiKeySource, "CF_HARNESS_API_KEY");
});

Deno.test("parseCfHarnessCliArgs supports resume-run inputs without a prompt", async () => {
  const parsed = await parseCfHarnessCliArgs(
    ["--resume-run", "/tmp/project/.cf-harness-artifacts/run-1"],
    {
      cwd: "/tmp/project",
      env: {},
    },
  );

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(
    parsed.resumeRun,
    "/tmp/project/.cf-harness-artifacts/run-1",
  );
  assertEquals(parsed.prompt, undefined);
  assertEquals(parsed.artifactRoot, "/tmp/project/.cf-harness-artifacts");
  assertEquals(parsed.model, undefined);
});

Deno.test("runCfHarnessCli prints usage for help", async () => {
  const { io, stdout, stderr } = createIoBuffers();
  const exitCode = await runCfHarnessCli(["--help"], { io });

  assertEquals(exitCode, 0);
  assertEquals(stdout, [formatCfHarnessCliUsage()]);
  assertEquals(stderr, []);
});

Deno.test("installCfHarnessSignalHandlers terminalizes the active run before exiting", async () => {
  const engine = new CfHarnessEngine({
    workspaceHostPath: "/tmp/project",
    runId: "run-signal",
    now: (() => {
      const timestamps = [
        "2026-04-16T20:00:00.000Z",
        "2026-04-16T20:00:01.000Z",
      ];
      return () => timestamps.shift() ?? "2026-04-16T20:00:02.000Z";
    })(),
  });
  engine.setRunStatus("running");
  let handler: CfHarnessCliSignalHandler | undefined;
  let disposed = false;
  let exitCode: number | undefined;

  const cleanup = installCfHarnessSignalHandlers(() => engine, {
    registerSignalHandler: (signals, registeredHandler) => {
      assertEquals(signals, ["SIGINT", "SIGTERM"]);
      handler = registeredHandler;
      return () => {
        disposed = true;
      };
    },
    exit: (code) => {
      exitCode = code;
      throw new Error("exit");
    },
  });

  await assertRejects(
    () => Promise.resolve(handler?.("SIGTERM")),
    Error,
    "exit",
  );
  cleanup();

  assertEquals(disposed, true);
  assertEquals(exitCode, 143);
  assertEquals(engine.getRunState().status, "failed");
  assertEquals(engine.getRunState().terminalReason, "process_interrupted");
  assertEquals(engine.getRunState().endedAt, "2026-04-16T20:00:02.000Z");
  assertEquals(
    engine.getRunState().failureRecords?.at(-1)?.detail,
    "process received SIGTERM before the prompt loop completed",
  );
});

Deno.test("runCfHarnessCli registers and disposes signal handlers around a run", async () => {
  const { io, stdout, stderr } = createIoBuffers();
  let registeredSignals: readonly string[] = [];
  let disposed = false;
  const exitCode = await runCfHarnessCli(
    ["--prompt", "hello", "--gateway-auth-mode", "none"],
    {
      io,
      env: {},
      registerSignalHandler: (signals) => {
        registeredSignals = signals;
        return () => {
          disposed = true;
        };
      },
      createPromptLoop: () => ({
        runPrompt: () =>
          Promise.resolve(
            ({
              model: "gpt-5.4",
              finalAssistantText: "Done.",
              transcript: [
                { role: "user", content: "hello" },
                { role: "assistant", content: "Done." },
              ],
              modelTurns: 1,
              runState: {
                runId: "run-signal-cleanup",
                status: "completed",
                createdAt: "2026-04-16T20:10:00.000Z",
                updatedAt: "2026-04-16T20:10:01.000Z",
                cfcEnforcementMode: "disabled",
                currentDir: "/workspace",
                policyEvents: [],
                toolOutputs: [],
              },
            }) satisfies HarnessPromptLoopResult,
          ),
        runTranscript: () =>
          Promise.reject(new Error("unexpected resume path")),
      }),
    },
  );

  assertEquals(exitCode, 0);
  assertEquals(registeredSignals, ["SIGINT", "SIGTERM"]);
  assertEquals(disposed, true);
  assertEquals(stderr, []);
  assertEquals(stdout, [
    formatCfHarnessCliResult({
      model: "gpt-5.4",
      finalAssistantText: "Done.",
      transcript: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "Done." },
      ],
      modelTurns: 1,
      runState: {
        runId: "run-signal-cleanup",
        status: "completed",
        createdAt: "2026-04-16T20:10:00.000Z",
        updatedAt: "2026-04-16T20:10:01.000Z",
        cfcEnforcementMode: "disabled",
        currentDir: "/workspace",
        policyEvents: [],
        toolOutputs: [],
      },
    }),
  ]);
});

Deno.test("runCfHarnessCli executes the prompt loop and prints result metadata", async () => {
  const { io, stdout, stderr } = createIoBuffers();
  let createdOptions: Record<string, unknown> | undefined;
  let runPromptOptions: RunHarnessPromptOptions | undefined;
  const exitCode = await runCfHarnessCli(
    [
      "--workspace",
      "/tmp/project",
      "--focus-root",
      "packages/cf-harness",
      "--prompt",
      "Inspect the workspace",
      "--model",
      "gpt-5.4",
      "--print-transcript",
    ],
    {
      io,
      env: { CF_HARNESS_API_KEY: "test-key" },
      createPromptLoop: (options) => {
        createdOptions = options as Record<string, unknown>;
        return {
          runPrompt: (options) => {
            runPromptOptions = options;
            return Promise.resolve(
              ({
                model: "gpt-5.4",
                finalAssistantText: "Inspection complete.",
                transcript: [
                  { role: "user", content: "Inspect the workspace" },
                  { role: "assistant", content: "Inspection complete." },
                ],
                modelTurns: 1,
                runState: {
                  runId: "run-cli",
                  status: "completed",
                  createdAt: "2026-04-15T22:00:00.000Z",
                  updatedAt: "2026-04-15T22:00:01.000Z",
                  cfcEnforcementMode: "disabled",
                  currentDir: "/workspace",
                  artifactRoot: "/tmp/project/.cf-harness-artifacts/run-cli",
                  transcriptPath:
                    "/tmp/project/.cf-harness-artifacts/run-cli/transcript.json",
                  policyEvents: [],
                  toolOutputs: [],
                },
              }) satisfies HarnessPromptLoopResult,
            );
          },
          runTranscript: () =>
            Promise.reject(new Error("unexpected resume path")),
        };
      },
    },
  );

  assertEquals(exitCode, 0);
  assertEquals(createdOptions?.workspaceHostPath, "/tmp/project");
  assertEquals(
    createdOptions?.artifactRoot,
    "/tmp/project/.cf-harness-artifacts",
  );
  assertEquals(createdOptions?.apiKey, "test-key");
  assertEquals(createdOptions?.apiKeySource, "CF_HARNESS_API_KEY");
  assertEquals(
    runPromptOptions?.systemPrompt,
    buildCfHarnessOperatorSystemPrompt({
      workspace: "/tmp/project",
      focusRoot: "/tmp/project/packages/cf-harness",
      systemPrompt: undefined,
    }),
  );
  assertEquals(runPromptOptions?.promptSlotBinding?.role, "direct-command");
  assertEquals(
    stdout,
    [
      formatCfHarnessCliResult({
        model: "gpt-5.4",
        finalAssistantText: "Inspection complete.",
        transcript: [
          { role: "user", content: "Inspect the workspace" },
          { role: "assistant", content: "Inspection complete." },
        ],
        modelTurns: 1,
        runState: {
          runId: "run-cli",
          status: "completed",
          createdAt: "2026-04-15T22:00:00.000Z",
          updatedAt: "2026-04-15T22:00:01.000Z",
          cfcEnforcementMode: "disabled",
          currentDir: "/workspace",
          artifactRoot: "/tmp/project/.cf-harness-artifacts/run-cli",
          transcriptPath:
            "/tmp/project/.cf-harness-artifacts/run-cli/transcript.json",
          policyEvents: [],
          toolOutputs: [],
        },
      }),
      `${
        JSON.stringify(
          [
            { role: "user", content: "Inspect the workspace" },
            { role: "assistant", content: "Inspection complete." },
          ],
          null,
          2,
        )
      }\n`,
    ],
  );
  assertEquals(stderr, []);
});

Deno.test("runCfHarnessCli can override the prompt-slot role for testing", async () => {
  const { io, stdout, stderr } = createIoBuffers();
  let runPromptOptions: RunHarnessPromptOptions | undefined;
  const exitCode = await runCfHarnessCli(
    [
      "--workspace",
      "/tmp/project",
      "--prompt",
      "Inspect the workspace",
      "--prompt-slot-role",
      "context",
    ],
    {
      io,
      env: { CF_HARNESS_API_KEY: "test-key" },
      createPromptLoop: () => ({
        runPrompt: (options) => {
          runPromptOptions = options;
          return Promise.resolve(
            {
              model: "gpt-5.4",
              finalAssistantText: "Inspection complete.",
              transcript: [
                { role: "user", content: "Inspect the workspace" },
                { role: "assistant", content: "Inspection complete." },
              ],
              modelTurns: 1,
              runState: {
                runId: "run-cli-context",
                status: "completed",
                createdAt: "2026-04-16T21:10:00.000Z",
                updatedAt: "2026-04-16T21:10:01.000Z",
                cfcEnforcementMode: "disabled",
                currentDir: "/workspace",
                artifactRoot:
                  "/tmp/project/.cf-harness-artifacts/run-cli-context",
                transcriptPath:
                  "/tmp/project/.cf-harness-artifacts/run-cli-context/transcript.json",
                policyEvents: [],
                toolOutputs: [],
              },
            } satisfies HarnessPromptLoopResult,
          );
        },
        runTranscript: () =>
          Promise.reject(new Error("unexpected resume path")),
      }),
    },
  );

  assertEquals(exitCode, 0);
  assertEquals(runPromptOptions?.promptSlotBinding?.role, "context");
  assertEquals(stderr, []);
  assertEquals(stdout.length, 1);
});

Deno.test("runCfHarnessCli can stream transcript events as they happen", async () => {
  const { io, stdout, stderr } = createIoBuffers();
  const exitCode = await runCfHarnessCli(
    [
      "--workspace",
      "/tmp/project",
      "--prompt",
      "Inspect the workspace",
      "--stream-events",
      "--gateway-auth-mode",
      "none",
    ],
    {
      io,
      env: {},
      createPromptLoop: () => ({
        runPrompt: async (options) => {
          await options.onTranscriptEvent?.({
            message: { role: "user", content: "Inspect the workspace" },
            transcript: [{ role: "user", content: "Inspect the workspace" }],
          });
          await options.onTranscriptEvent?.({
            message: {
              role: "assistant",
              content: "",
              toolCalls: [{
                id: "call-1",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: '{"path":"README.md"}',
                },
              }],
            },
            transcript: [],
          });
          await options.onTranscriptEvent?.({
            message: {
              role: "tool",
              toolCallId: "call-1",
              toolName: "read_file",
              content: '{"outputId":"read-1","content":"hello"}',
            },
            transcript: [],
          });
          await options.onTranscriptEvent?.({
            message: { role: "assistant", content: "Inspection complete." },
            transcript: [],
          });
          return {
            model: "gpt-5.4",
            finalAssistantText: "Inspection complete.",
            transcript: [
              { role: "user", content: "Inspect the workspace" },
              { role: "assistant", content: "Inspection complete." },
            ],
            modelTurns: 1,
            runState: {
              runId: "run-cli-stream",
              status: "completed",
              createdAt: "2026-04-16T22:40:00.000Z",
              updatedAt: "2026-04-16T22:40:01.000Z",
              cfcEnforcementMode: "disabled",
              currentDir: "/workspace",
              policyEvents: [],
              toolOutputs: [],
            },
          } satisfies HarnessPromptLoopResult;
        },
        runTranscript: () =>
          Promise.reject(new Error("unexpected resume path")),
      }),
    },
  );

  assertEquals(exitCode, 0);
  assertEquals(stderr, []);
  assertEquals(stdout, [
    "user: Inspect the workspace\n",
    'assistant -> tools: read_file(path="README.md")\n',
    "tool read_file: outputId=read-1\n",
    "assistant: Inspection complete.\n",
    formatCfHarnessCliResult({
      model: "gpt-5.4",
      finalAssistantText: "Inspection complete.",
      transcript: [
        { role: "user", content: "Inspect the workspace" },
        { role: "assistant", content: "Inspection complete." },
      ],
      modelTurns: 1,
      runState: {
        runId: "run-cli-stream",
        status: "completed",
        createdAt: "2026-04-16T22:40:00.000Z",
        updatedAt: "2026-04-16T22:40:01.000Z",
        cfcEnforcementMode: "disabled",
        currentDir: "/workspace",
        policyEvents: [],
        toolOutputs: [],
      },
    }),
  ]);
});

Deno.test("runCfHarnessCli uses plain stdout and no operator guidance in batch mode", async () => {
  const { io, stdout, stderr } = createIoBuffers();
  let runPromptOptions: RunHarnessPromptOptions | undefined;
  const exitCode = await runCfHarnessCli(
    [
      "--workspace",
      "/tmp/project",
      "--prompt",
      "Execute the batch task",
      "--output-mode",
      "batch",
      "--system-prompt",
      "You are a Loom batch worker.",
      "--gateway-auth-mode",
      "none",
    ],
    {
      io,
      env: {},
      createPromptLoop: () => ({
        runPrompt: (options) => {
          runPromptOptions = options;
          return Promise.resolve(
            {
              model: "gpt-5.4",
              finalAssistantText: "Batch result.",
              transcript: [
                { role: "user", content: "Execute the batch task" },
                { role: "assistant", content: "Batch result." },
              ],
              modelTurns: 1,
              runState: {
                runId: "run-cli-batch",
                status: "completed",
                createdAt: "2026-04-16T22:10:00.000Z",
                updatedAt: "2026-04-16T22:10:01.000Z",
                cfcEnforcementMode: "disabled",
                currentDir: "/workspace",
                policyEvents: [],
                toolOutputs: [],
              },
            } satisfies HarnessPromptLoopResult,
          );
        },
        runTranscript: () =>
          Promise.reject(new Error("unexpected resume path")),
      }),
    },
  );

  assertEquals(exitCode, 0);
  assertEquals(runPromptOptions?.systemPrompt, "You are a Loom batch worker.");
  assertEquals(stdout, ["Batch result.\n"]);
  assertEquals(stderr, []);
});

Deno.test("runCfHarnessCli writes a structured batch result sidecar when requested", async () => {
  const { io, stdout, stderr } = createIoBuffers();
  const writes: Array<{ path: string; text: string }> = [];
  const exitCode = await runCfHarnessCli(
    [
      "--workspace",
      "/tmp/project",
      "--prompt",
      "Execute the batch task",
      "--output-mode",
      "batch",
      "--gateway-auth-mode",
      "none",
      "--result-json-path",
      "/tmp/project/out/result.json",
    ],
    {
      io,
      env: {},
      writeTextFile: (path, text) => {
        writes.push({ path, text });
        return Promise.resolve();
      },
      createPromptLoop: () => ({
        runPrompt: () =>
          Promise.resolve(
            ({
              model: "gpt-5.4",
              finalAssistantText: "Batch result.",
              transcript: [
                { role: "user", content: "Execute the batch task" },
                { role: "assistant", content: "Batch result." },
              ],
              modelTurns: 2,
              runState: {
                runId: "run-cli-batch-json",
                status: "completed",
                createdAt: "2026-04-16T23:10:00.000Z",
                updatedAt: "2026-04-16T23:10:02.000Z",
                cfcEnforcementMode: "observe",
                currentDir: "/workspace",
                artifactRoot:
                  "/tmp/project/.cf-harness-artifacts/run-cli-batch-json",
                transcriptPath:
                  "/tmp/project/.cf-harness-artifacts/run-cli-batch-json/transcript.json",
                policyEvents: [{
                  type: "cf-harness.policy-event",
                  severity: "denied",
                  mode: "observe",
                  toolId: "write_file",
                  detail:
                    "write_file requires direct-command authorization in enforce-explicit",
                  at: "2026-04-16T23:10:01.000Z",
                }],
                toolOutputs: [],
              },
            }) satisfies HarnessPromptLoopResult,
          ),
        runTranscript: () =>
          Promise.reject(new Error("unexpected resume path")),
      }),
    },
  );

  assertEquals(exitCode, 0);
  assertEquals(stdout, ["Batch result.\n"]);
  assertEquals(stderr, []);
  assertEquals(writes.length, 1);
  assertEquals(writes[0].path, "/tmp/project/out/result.json");
  assertEquals(
    JSON.parse(writes[0].text),
    createCfHarnessBatchResult({
      model: "gpt-5.4",
      finalAssistantText: "Batch result.",
      transcript: [
        { role: "user", content: "Execute the batch task" },
        { role: "assistant", content: "Batch result." },
      ],
      modelTurns: 2,
      runState: {
        runId: "run-cli-batch-json",
        status: "completed",
        createdAt: "2026-04-16T23:10:00.000Z",
        updatedAt: "2026-04-16T23:10:02.000Z",
        cfcEnforcementMode: "observe",
        currentDir: "/workspace",
        artifactRoot: "/tmp/project/.cf-harness-artifacts/run-cli-batch-json",
        transcriptPath:
          "/tmp/project/.cf-harness-artifacts/run-cli-batch-json/transcript.json",
        policyEvents: [{
          type: "cf-harness.policy-event",
          severity: "denied",
          mode: "observe",
          toolId: "write_file",
          detail:
            "write_file requires direct-command authorization in enforce-explicit",
          at: "2026-04-16T23:10:01.000Z",
        }],
        toolOutputs: [],
      },
    }, JSON.parse(writes[0].text).duration_ms),
  );
});

Deno.test("buildCfHarnessOperatorSystemPrompt appends user instructions after guardrails", () => {
  assertEquals(
    buildCfHarnessOperatorSystemPrompt({
      workspace: "/tmp/project",
      focusRoot: "/tmp/project/packages/cf-harness",
      systemPrompt: "Use bash and read_file only. Do not modify files.",
    }),
    [
      "Operator guidance for cf-harness runs:",
      "- Prefer exploration within /workspace/packages/cf-harness.",
      "- Start from README files and the package manifest before reading source files.",
      "- Use bash only for narrow discovery; avoid broad workspace scans when a focused path is available.",
      "- Read source files only when needed to answer the prompt accurately.",
      "- Stop once you have enough evidence to answer.",
      "",
      "Additional instructions:",
      "Use bash and read_file only. Do not modify files.",
    ].join("\n"),
  );
});

Deno.test("resolveCfHarnessCliSystemPrompt bypasses operator guidance in batch mode", () => {
  assertEquals(
    resolveCfHarnessCliSystemPrompt({
      workspace: "/tmp/project",
      focusRoot: "/tmp/project/packages/cf-harness",
      systemPrompt: "You are a Loom batch worker.",
      outputMode: "batch",
    }),
    "You are a Loom batch worker.",
  );
});

Deno.test("formatCfHarnessTranscriptEvent formats assistant tool calls and tool results", () => {
  assertEquals(
    formatCfHarnessTranscriptEvent({
      message: {
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "call-1",
          type: "function",
          function: { name: "bash", arguments: '{"command":"ls"}' },
        }],
      },
      transcript: [],
    }),
    'assistant -> tools: bash(command="ls")\n',
  );
  assertEquals(
    formatCfHarnessTranscriptEvent({
      message: {
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "call-2",
          type: "function",
          function: {
            name: "read_file",
            arguments: '{"path":"/workspace/README.md"}',
          },
        }],
      },
      transcript: [],
    }),
    'assistant -> tools: read_file(path="/workspace/README.md")\n',
  );
  assertEquals(
    formatCfHarnessTranscriptEvent({
      message: {
        role: "tool",
        toolCallId: "call-1",
        toolName: "bash",
        content: '{"detail":"write blocked"}',
      },
      transcript: [],
    }),
    "tool bash: write blocked\n",
  );
});

Deno.test("runCfHarnessCli reports argument errors to stderr", async () => {
  const { io, stdout, stderr } = createIoBuffers();
  const exitCode = await runCfHarnessCli(
    ["--prompt", "one", "two"],
    { io, env: {} },
  );

  assertEquals(exitCode, 1);
  assertEquals(stdout, []);
  assertEquals(
    stderr,
    [
      "provide input using only one of --prompt, --prompt-file, positional text, or --resume-run\n",
    ],
  );
});

Deno.test("runCfHarnessCli fails early when no API key is configured", async () => {
  const { io, stdout, stderr } = createIoBuffers();
  const exitCode = await runCfHarnessCli(
    ["--prompt", "hello"],
    { io, env: {} },
  );

  assertEquals(exitCode, 1);
  assertEquals(stdout, []);
  assertEquals(stderr, [
    "no API key configured; set CF_HARNESS_API_KEY or OPENAI_API_KEY\n",
  ]);
});

Deno.test("runCfHarnessCli allows no-auth gateway mode without an API key", async () => {
  const { io, stdout, stderr } = createIoBuffers();
  let createdOptions: Record<string, unknown> | undefined;
  const exitCode = await runCfHarnessCli(
    ["--prompt", "hello", "--gateway-auth-mode", "none"],
    {
      io,
      env: {},
      createPromptLoop: (options) => {
        createdOptions = options as Record<string, unknown>;
        return {
          runPrompt: () =>
            Promise.resolve(
              ({
                model: "gpt-5.4",
                finalAssistantText: "No auth path.",
                transcript: [
                  { role: "user", content: "hello" },
                  { role: "assistant", content: "No auth path." },
                ],
                modelTurns: 1,
                runState: {
                  runId: "run-no-auth",
                  status: "completed",
                  createdAt: "2026-04-16T00:00:00.000Z",
                  updatedAt: "2026-04-16T00:00:01.000Z",
                  cfcEnforcementMode: "disabled",
                  currentDir: "/workspace",
                  policyEvents: [],
                  toolOutputs: [],
                },
              }) satisfies HarnessPromptLoopResult,
            ),
          runTranscript: () =>
            Promise.reject(new Error("unexpected resume path")),
        };
      },
    },
  );

  assertEquals(exitCode, 0);
  assertEquals(createdOptions?.gatewayAuthMode, "none");
  assertEquals(createdOptions?.apiKey, undefined);
  assertEquals(stdout, [
    formatCfHarnessCliResult({
      model: "gpt-5.4",
      finalAssistantText: "No auth path.",
      transcript: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "No auth path." },
      ],
      modelTurns: 1,
      runState: {
        runId: "run-no-auth",
        status: "completed",
        createdAt: "2026-04-16T00:00:00.000Z",
        updatedAt: "2026-04-16T00:00:01.000Z",
        cfcEnforcementMode: "disabled",
        currentDir: "/workspace",
        policyEvents: [],
        toolOutputs: [],
      },
    }),
  ]);
  assertEquals(stderr, []);
});

Deno.test("runCfHarnessCli can resume from persisted run artifacts", async () => {
  const { io, stdout, stderr } = createIoBuffers();
  const exitCode = await runCfHarnessCli(
    ["--resume-run", "/tmp/project/.cf-harness-artifacts/run-1/run-state.json"],
    {
      io,
      env: { CF_HARNESS_API_KEY: "test-key" },
      readRunArtifacts: (path) => {
        assertEquals(
          path,
          "/tmp/project/.cf-harness-artifacts/run-1/run-state.json",
        );
        return Promise.resolve({
          runRoot: "/tmp/project/.cf-harness-artifacts/run-1",
          runStatePath:
            "/tmp/project/.cf-harness-artifacts/run-1/run-state.json",
          transcriptPath:
            "/tmp/project/.cf-harness-artifacts/run-1/transcript.json",
          runState: {
            runId: "run-1",
            status: "failed",
            createdAt: "2026-04-15T22:10:00.000Z",
            updatedAt: "2026-04-15T22:10:01.000Z",
            cfcEnforcementMode: "disabled",
            currentDir: "/workspace",
            model: "gpt-5.4",
            artifactRoot: "/tmp/project/.cf-harness-artifacts/run-1",
            transcriptPath:
              "/tmp/project/.cf-harness-artifacts/run-1/transcript.json",
            policyEvents: [],
            toolOutputs: [],
          },
          transcript: [
            { role: "user", content: "Continue." },
          ],
        });
      },
      createPromptLoop: () => ({
        runPrompt: () => Promise.reject(new Error("unexpected prompt path")),
        runTranscript: ({ transcript, model }) =>
          Promise.resolve(
            ({
              model: model ?? "gpt-5.4",
              finalAssistantText: "Resumed.",
              transcript: [
                ...transcript,
                { role: "assistant", content: "Resumed." },
              ],
              modelTurns: 1,
              runState: {
                runId: "run-1",
                status: "completed",
                createdAt: "2026-04-15T22:10:00.000Z",
                updatedAt: "2026-04-15T22:10:02.000Z",
                cfcEnforcementMode: "disabled",
                currentDir: "/workspace",
                model: "gpt-5.4",
                artifactRoot: "/tmp/project/.cf-harness-artifacts/run-1",
                transcriptPath:
                  "/tmp/project/.cf-harness-artifacts/run-1/transcript.json",
                policyEvents: [],
                toolOutputs: [],
              },
            }) satisfies HarnessPromptLoopResult,
          ),
      }),
    },
  );

  assertEquals(exitCode, 0);
  assertEquals(stdout, [
    formatCfHarnessCliResult({
      model: "gpt-5.4",
      finalAssistantText: "Resumed.",
      transcript: [
        { role: "user", content: "Continue." },
        { role: "assistant", content: "Resumed." },
      ],
      modelTurns: 1,
      runState: {
        runId: "run-1",
        status: "completed",
        createdAt: "2026-04-15T22:10:00.000Z",
        updatedAt: "2026-04-15T22:10:02.000Z",
        cfcEnforcementMode: "disabled",
        currentDir: "/workspace",
        model: "gpt-5.4",
        artifactRoot: "/tmp/project/.cf-harness-artifacts/run-1",
        transcriptPath:
          "/tmp/project/.cf-harness-artifacts/run-1/transcript.json",
        policyEvents: [],
        toolOutputs: [],
      },
    }),
  ]);
  assertEquals(stderr, []);
});

Deno.test("formatCfHarnessCliResult includes policy event summaries", () => {
  const text = formatCfHarnessCliResult({
    model: "gpt-5.4",
    finalAssistantText: "Done.",
    transcript: [],
    modelTurns: 1,
    runState: {
      runId: "run-policy",
      status: "completed",
      createdAt: "2026-04-15T22:20:00.000Z",
      updatedAt: "2026-04-15T22:20:01.000Z",
      cfcEnforcementMode: "observe",
      currentDir: "/workspace",
      policyEvents: [{
        type: "cf-harness.policy-event",
        severity: "warning",
        mode: "observe",
        toolId: "bash",
        detail:
          "bash would require direct-command authorization in enforce modes",
        at: "2026-04-15T22:20:01.000Z",
      }],
      toolOutputs: [],
    },
  });

  assertEquals(
    text,
    [
      "Done.",
      "",
      "runId: run-policy",
      "status: completed",
      "modelTurns: 1",
      "policyEvents: 1",
      "- warning bash: bash would require direct-command authorization in enforce modes",
      "",
    ].join("\n"),
  );
});

Deno.test("formatCfHarnessCliResult returns plain final text in batch mode", () => {
  assertEquals(
    formatCfHarnessCliResult({
      model: "gpt-5.4",
      finalAssistantText: "Batch result.",
      transcript: [],
      modelTurns: 1,
      runState: {
        runId: "run-batch",
        status: "completed",
        createdAt: "2026-04-16T22:30:00.000Z",
        updatedAt: "2026-04-16T22:30:01.000Z",
        cfcEnforcementMode: "disabled",
        currentDir: "/workspace",
        policyEvents: [],
        toolOutputs: [],
      },
    }, "batch"),
    "Batch result.\n",
  );
});
