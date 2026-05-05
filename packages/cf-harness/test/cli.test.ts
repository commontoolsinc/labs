import { assertEquals, assertRejects } from "@std/assert";
import { decodeBase64 } from "@std/encoding/base64";
import { join } from "@std/path";
import {
  buildCfHarnessBaseSystemPrompt,
  buildCfHarnessBatchSystemPrompt,
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
import { CFC_PROMPT_SLOT_BOUND_ATOM_TYPE } from "../src/contracts/prompt-slot.ts";
import type {
  HarnessPromptLoopResult,
  RunHarnessPromptOptions,
  RunHarnessTranscriptOptions,
} from "../src/prompt-loop.ts";

const ONE_PIXEL_PNG = decodeBase64(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p94AAAAASUVORK5CYII=",
);

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
  assertEquals(parsed.allowedSubagentProfiles, ["default"]);
  assertEquals(parsed.skillNames, []);
  assertEquals(parsed.skillCatalogEnabled, true);
  assertEquals(parsed.artifactRoot, "/tmp/project/.cf-harness-artifacts");
  assertEquals(parsed.maxModelTurns, 8);
  assertEquals(parsed.printTranscript, false);
  assertEquals(parsed.sandboxImage, undefined);
  assertEquals(parsed.imageAttachments, []);
});

Deno.test("parseCfHarnessCliArgs resolves image attachments within the workspace", async () => {
  const workspace = await Deno.makeTempDir();
  const launcherCwd = await Deno.makeTempDir();
  await Deno.writeFile(join(workspace, "capture.png"), ONE_PIXEL_PNG);

  const parsed = await parseCfHarnessCliArgs(
    [
      "--workspace",
      workspace,
      "--image",
      "capture.png",
      "--prompt",
      "Describe the image",
    ],
    {
      cwd: launcherCwd,
      env: {},
    },
  );

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.imageAttachments.length, 1);
  assertEquals(
    parsed.imageAttachments[0].hostPath,
    await Deno.realPath(join(workspace, "capture.png")),
  );
  assertEquals(parsed.imageAttachments[0].mediaType, "image/png");
  assertEquals(parsed.imageAttachments[0].bytes, ONE_PIXEL_PNG.byteLength);
  assertEquals(
    parsed.imageAttachments[0].digest.startsWith("sha256:"),
    true,
  );
});

Deno.test("parseCfHarnessCliArgs rejects image attachments outside the workspace", async () => {
  const workspace = await Deno.makeTempDir();
  const outside = await Deno.makeTempDir();
  const outsideImage = join(outside, "capture.png");
  await Deno.writeFile(outsideImage, ONE_PIXEL_PNG);

  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        [
          "--workspace",
          workspace,
          "--image",
          outsideImage,
          "--prompt",
          "Describe the image",
        ],
        {
          cwd: workspace,
          env: {},
        },
      ),
    Error,
    "--image paths must stay within the workspace",
  );
});

Deno.test("parseCfHarnessCliArgs rejects image symlinks that resolve outside the workspace", async () => {
  const workspace = await Deno.makeTempDir();
  const outside = await Deno.makeTempDir();
  const outsideImage = join(outside, "capture.png");
  const linkedImage = join(workspace, "linked.png");
  await Deno.writeFile(outsideImage, ONE_PIXEL_PNG);
  await Deno.symlink(outsideImage, linkedImage);

  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        [
          "--workspace",
          workspace,
          "--image",
          linkedImage,
          "--prompt",
          "Describe the image",
        ],
        {
          cwd: workspace,
          env: {},
        },
      ),
    Error,
    "--image paths must stay within the workspace",
  );
});

Deno.test("parseCfHarnessCliArgs rejects image attachments while resuming", async () => {
  const workspace = await Deno.makeTempDir();
  await Deno.writeFile(join(workspace, "capture.png"), ONE_PIXEL_PNG);

  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        [
          "--workspace",
          workspace,
          "--resume-run",
          "run-state.json",
          "--image",
          "capture.png",
        ],
        {
          cwd: workspace,
          env: {},
        },
      ),
    Error,
    "--image is not supported with --resume-run",
  );
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

Deno.test("parseCfHarnessCliArgs accepts CFC mode from environment", async () => {
  const parsed = await parseCfHarnessCliArgs(
    ["--prompt", "hi"],
    {
      cwd: "/tmp/project",
      env: { CF_HARNESS_CFC_ENFORCEMENT_MODE: "enforce-strict" },
    },
  );

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.cfcEnforcementModeOverride, "enforce-strict");
});

Deno.test("parseCfHarnessCliArgs resolves run manifest paths", async () => {
  const parsed = await parseCfHarnessCliArgs(
    ["--prompt", "hi", "--run-manifest", "loom-run.json"],
    {
      cwd: "/tmp/project",
      env: {},
    },
  );

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.runManifestPath, "/tmp/project/loom-run.json");
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

Deno.test({
  name: "parseCfHarnessCliArgs supports skills root and skill preloads",
  permissions: { read: true, write: true },
  async fn() {
    const workspace = await Deno.makeTempDir({
      prefix: "cf-harness-cli-skills-",
    });
    try {
      await Deno.mkdir(join(workspace, "labs", "skills"), {
        recursive: true,
      });
      const parsed = await parseCfHarnessCliArgs(
        [
          "--workspace",
          workspace,
          "--prompt",
          "hi",
          "--skills-root",
          "labs/skills",
          "--skill",
          "pattern-dev",
          "--skill",
          "pattern-dev",
          "--skill",
          "cf",
          "--no-skill-catalog",
        ],
        {
          cwd: join(workspace, "packages", "cf-harness"),
          env: {},
        },
      );

      if ("help" in parsed) {
        throw new Error("expected config result");
      }
      assertEquals(parsed.skillsRoot, join(workspace, "labs", "skills"));
      assertEquals(parsed.skillsRootSandboxPath, "/workspace/labs/skills");
      assertEquals(parsed.skillNames, ["pattern-dev", "cf"]);
      assertEquals(parsed.skillCatalogEnabled, false);
    } finally {
      await Deno.remove(workspace, { recursive: true });
    }
  },
});

Deno.test("parseCfHarnessCliArgs rejects skill preloads without a skills root", async () => {
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        ["--prompt", "hi", "--skill", "pattern-dev"],
        {
          cwd: "/tmp/project",
          env: {},
        },
      ),
    Error,
    "--skill requires --skills-root",
  );
});

Deno.test("parseCfHarnessCliArgs rejects skills root outside workspace", async () => {
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        [
          "--workspace",
          "/tmp/project",
          "--prompt",
          "hi",
          "--skills-root",
          "../other/skills",
        ],
        {
          cwd: "/tmp/project",
          env: {},
        },
      ),
    Error,
    "--skills-root must stay within the workspace",
  );
});

Deno.test({
  name:
    "parseCfHarnessCliArgs rejects skills root symlinks that resolve outside workspace",
  permissions: { read: true, write: true },
  async fn() {
    const workspace = await Deno.makeTempDir({
      prefix: "cf-harness-workspace-",
    });
    const outside = await Deno.makeTempDir({
      prefix: "cf-harness-outside-skills-",
    });
    try {
      await Deno.mkdir(join(outside, "pattern-dev"), { recursive: true });
      await Deno.symlink(outside, join(workspace, "skills-link"), {
        type: "dir",
      });

      await assertRejects(
        () =>
          parseCfHarnessCliArgs(
            [
              "--workspace",
              workspace,
              "--prompt",
              "hi",
              "--skills-root",
              "skills-link",
              "--skill",
              "pattern-dev",
            ],
            {
              cwd: workspace,
              env: {},
            },
          ),
        Error,
        "--skills-root must stay within the workspace",
      );
    } finally {
      await Deno.remove(workspace, { recursive: true });
      await Deno.remove(outside, { recursive: true });
    }
  },
});

Deno.test("parseCfHarnessCliArgs rejects skill preloads while resuming", async () => {
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        [
          "--workspace",
          "/tmp/project",
          "--resume-run",
          "run-state.json",
          "--skills-root",
          "skills",
          "--skill",
          "pattern-dev",
        ],
        {
          cwd: "/tmp/project",
          env: {},
        },
      ),
    Error,
    "--skill preloading is not supported with --resume-run",
  );
});

Deno.test("parseCfHarnessCliArgs supports allowed tools and result json path", async () => {
  const parsed = await parseCfHarnessCliArgs(
    [
      "--prompt",
      "hi",
      "--allow-tool",
      "read_file",
      "--allow-tool",
      "read_skill_resource",
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
  assertEquals(parsed.allowedToolIds, [
    "read_file",
    "read_skill_resource",
    "bash",
  ]);
  assertEquals(parsed.allowedSubagentProfiles, []);
  assertEquals(parsed.resultJsonPath, "/tmp/project/results/output.json");
});

Deno.test("parseCfHarnessCliArgs supports explicit subagent profile authorization", async () => {
  const parsed = await parseCfHarnessCliArgs(
    [
      "--prompt",
      "hi",
      "--allow-tool",
      "delegate_task",
      "--allow-subagent-profile",
      "default",
    ],
    {
      cwd: "/tmp/project",
      env: {},
    },
  );

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.allowedToolIds, ["delegate_task"]);
  assertEquals(parsed.allowedSubagentProfiles, ["default"]);
});

Deno.test("parseCfHarnessCliArgs supports explicit browser subagent profile authorization", async () => {
  const parsed = await parseCfHarnessCliArgs(
    [
      "--prompt",
      "hi",
      "--allow-tool",
      "delegate_task",
      "--allow-subagent-profile",
      "browser",
    ],
    {
      cwd: "/tmp/project",
      env: {},
    },
  );

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.allowedToolIds, ["delegate_task"]);
  assertEquals(parsed.allowedSubagentProfiles, ["browser"]);
});

Deno.test("parseCfHarnessCliArgs covers tool allowlist and subagent profile permutations", async () => {
  const cases = [
    {
      name: "implicit default profile when parent tools are unrestricted",
      flags: [],
      allowedToolIds: undefined,
      allowedSubagentProfiles: ["default"],
    },
    {
      name: "explicit default profile when parent tools are unrestricted",
      flags: ["--allow-subagent-profile", "default"],
      allowedToolIds: undefined,
      allowedSubagentProfiles: ["default"],
    },
    {
      name: "explicit browser profile when parent tools are unrestricted",
      flags: ["--allow-subagent-profile", "browser"],
      allowedToolIds: undefined,
      allowedSubagentProfiles: ["browser"],
    },
    {
      name: "delegate_task alone does not imply child profile authority",
      flags: ["--allow-tool", "delegate_task"],
      allowedToolIds: ["delegate_task"],
      allowedSubagentProfiles: [],
    },
    {
      name: "delegate_task with explicit default profile authority",
      flags: [
        "--allow-tool",
        "delegate_task",
        "--allow-subagent-profile",
        "default",
      ],
      allowedToolIds: ["delegate_task"],
      allowedSubagentProfiles: ["default"],
    },
    {
      name: "non-delegate parent tools can still preauthorize a profile",
      flags: [
        "--allow-tool",
        "read_file",
        "--allow-tool",
        "bash",
        "--allow-subagent-profile",
        "default",
      ],
      allowedToolIds: ["read_file", "bash"],
      allowedSubagentProfiles: ["default"],
    },
    {
      name: "duplicate tool and profile flags are normalized",
      flags: [
        "--allow-tool",
        "delegate_task",
        "--allow-tool",
        "delegate_task",
        "--allow-subagent-profile",
        "default",
        "--allow-subagent-profile",
        "default",
      ],
      allowedToolIds: ["delegate_task"],
      allowedSubagentProfiles: ["default"],
    },
    {
      name: "default and browser profiles can both be preauthorized",
      flags: [
        "--allow-tool",
        "delegate_task",
        "--allow-subagent-profile",
        "default",
        "--allow-subagent-profile",
        "browser",
      ],
      allowedToolIds: ["delegate_task"],
      allowedSubagentProfiles: ["default", "browser"],
    },
  ] as const;

  for (const testCase of cases) {
    const parsed = await parseCfHarnessCliArgs(
      ["--prompt", "hi", ...testCase.flags],
      {
        cwd: "/tmp/project",
        env: {},
      },
    );

    if ("help" in parsed) {
      throw new Error(`expected config result for ${testCase.name}`);
    }
    assertEquals(
      parsed.allowedToolIds,
      testCase.allowedToolIds,
      testCase.name,
    );
    assertEquals(
      parsed.allowedSubagentProfiles,
      testCase.allowedSubagentProfiles,
      testCase.name,
    );
  }
});

Deno.test("parseCfHarnessCliArgs rejects unknown subagent profiles", async () => {
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        ["--prompt", "hi", "--allow-subagent-profile", "unknown"],
        {
          cwd: "/tmp/project",
          env: {},
        },
      ),
    Error,
    "allowed subagent profiles must be one or more of default, browser",
  );
});

Deno.test("parseCfHarnessCliArgs rejects bash-no-sandbox as a parent allow-tool", async () => {
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        ["--prompt", "hi", "--allow-tool", "bash-no-sandbox"],
        {
          cwd: "/tmp/project",
          env: {},
        },
      ),
    Error,
    "allowed tools must be one or more of bash, read_file, read_skill_resource, write_file, delegate_task",
  );
});

Deno.test("parseCfHarnessCliArgs rejects unknown allowed tools before resolving profiles", async () => {
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        [
          "--prompt",
          "hi",
          "--allow-tool",
          "agent-browser",
          "--allow-subagent-profile",
          "default",
        ],
        {
          cwd: "/tmp/project",
          env: {},
        },
      ),
    Error,
    "allowed tools must be one or more of bash, read_file, read_skill_resource, write_file, delegate_task",
  );
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
                  runReportPath:
                    "/tmp/project/.cf-harness-artifacts/run-cli/run-report.json",
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
  assertEquals(createdOptions?.allowedSubagentProfiles, ["default"]);
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
          runReportPath:
            "/tmp/project/.cf-harness-artifacts/run-cli/run-report.json",
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

Deno.test("runCfHarnessCli passes image attachments to the prompt loop", async () => {
  const workspace = await Deno.makeTempDir();
  await Deno.writeFile(join(workspace, "capture.png"), ONE_PIXEL_PNG);
  const { io, stderr } = createIoBuffers();
  let runPromptOptions: RunHarnessPromptOptions | undefined;
  const exitCode = await runCfHarnessCli(
    [
      "--workspace",
      workspace,
      "--image",
      "capture.png",
      "--prompt",
      "Describe the image",
    ],
    {
      io,
      cwd: workspace,
      env: { CF_HARNESS_API_KEY: "test-key" },
      createPromptLoop: () => ({
        runPrompt: (options) => {
          runPromptOptions = options;
          return Promise.resolve(
            ({
              model: "gpt-5.4",
              finalAssistantText: "Image described.",
              transcript: [
                {
                  role: "user",
                  content: "Describe the image",
                  imageAttachments: options.imageAttachments,
                },
                { role: "assistant", content: "Image described." },
              ],
              modelTurns: 1,
              runState: {
                runId: "run-cli-image",
                status: "completed",
                createdAt: "2026-05-05T22:00:00.000Z",
                updatedAt: "2026-05-05T22:00:01.000Z",
                cfcEnforcementMode: "disabled",
                currentDir: "/workspace",
                policyEvents: [],
                toolOutputs: [],
              },
            }) satisfies HarnessPromptLoopResult,
          );
        },
        runTranscript: () =>
          Promise.reject(new Error("unexpected resume path")),
      }),
    },
  );

  assertEquals(exitCode, 0);
  assertEquals(stderr, []);
  assertEquals(runPromptOptions?.imageAttachments?.length, 1);
  assertEquals(
    runPromptOptions?.imageAttachments?.[0].hostPath,
    await Deno.realPath(join(workspace, "capture.png")),
  );
});

Deno.test("runCfHarnessCli passes tool and subagent profile allowlists", async () => {
  const cases = [
    {
      name: "delegate_task without profile authorization",
      flags: ["--allow-tool", "delegate_task"],
      allowedToolIds: ["delegate_task"],
      allowedSubagentProfiles: [],
    },
    {
      name: "delegate_task with explicit profile authorization",
      flags: [
        "--allow-tool",
        "delegate_task",
        "--allow-subagent-profile",
        "default",
      ],
      allowedToolIds: ["delegate_task"],
      allowedSubagentProfiles: ["default"],
    },
    {
      name: "delegate_task with explicit browser profile authorization",
      flags: [
        "--allow-tool",
        "delegate_task",
        "--allow-subagent-profile",
        "browser",
      ],
      allowedToolIds: ["delegate_task"],
      allowedSubagentProfiles: ["browser"],
    },
  ] as const;

  for (const testCase of cases) {
    const { io, stdout, stderr } = createIoBuffers();
    let createdOptions: Record<string, unknown> | undefined;
    const exitCode = await runCfHarnessCli(
      [
        "--workspace",
        "/tmp/project",
        "--prompt",
        `Delegate through ${testCase.name}.`,
        "--gateway-auth-mode",
        "none",
        ...testCase.flags,
      ],
      {
        io,
        env: {},
        createPromptLoop: (options) => {
          createdOptions = options as Record<string, unknown>;
          return {
            runPrompt: () =>
              Promise.resolve(
                {
                  model: "gpt-5.4",
                  finalAssistantText: "Delegation configured.",
                  transcript: [
                    {
                      role: "user",
                      content: `Delegate through ${testCase.name}.`,
                    },
                    { role: "assistant", content: "Delegation configured." },
                  ],
                  modelTurns: 1,
                  runState: {
                    runId: "run-cli-profile-allowlist",
                    status: "completed",
                    createdAt: "2026-04-28T23:35:00.000Z",
                    updatedAt: "2026-04-28T23:35:01.000Z",
                    cfcEnforcementMode: "disabled",
                    currentDir: "/workspace",
                    policyEvents: [],
                    toolOutputs: [],
                  },
                } satisfies HarnessPromptLoopResult,
              ),
            runTranscript: () =>
              Promise.reject(new Error("unexpected resume path")),
          };
        },
      },
    );

    assertEquals(exitCode, 0, testCase.name);
    assertEquals(
      createdOptions?.allowedToolIds,
      testCase.allowedToolIds,
      testCase.name,
    );
    assertEquals(
      createdOptions?.allowedSubagentProfiles,
      testCase.allowedSubagentProfiles,
      testCase.name,
    );
    assertEquals(stdout.length, 1, testCase.name);
    assertEquals(stderr, [], testCase.name);
  }
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

Deno.test("runCfHarnessCli passes a Loom run manifest and its prompt slot", async () => {
  const { io, stdout, stderr } = createIoBuffers();
  let createdOptions: Record<string, unknown> | undefined;
  let runPromptOptions: RunHarnessPromptOptions | undefined;
  const manifest = {
    type: "cf-harness.loom-run-manifest",
    version: 1,
    source: "loom",
    wishId: "W-519",
    cfc: { enforcementMode: "observe" },
    promptSlot: {
      type: CFC_PROMPT_SLOT_BOUND_ATOM_TYPE,
      source: { type: "loom.wish", wishId: "W-519" },
      role: "context",
      kernelName: "cf-harness",
      surface: "loom",
      subject: "did:web:example.com#gideon",
      slotDigest: "sha256:slot",
    },
  } as const;
  const exitCode = await runCfHarnessCli(
    [
      "--workspace",
      "/tmp/project",
      "--prompt",
      "Inspect the workspace",
      "--gateway-auth-mode",
      "none",
      "--run-manifest",
      "loom-run.json",
    ],
    {
      io,
      cwd: "/tmp/project",
      env: {},
      readTextFile: (path) => {
        assertEquals(path, "/tmp/project/loom-run.json");
        return Promise.resolve(JSON.stringify(manifest));
      },
      createPromptLoop: (options) => {
        createdOptions = options as Record<string, unknown>;
        return {
          runPrompt: (options) => {
            runPromptOptions = options;
            return Promise.resolve(
              {
                model: "gpt-5.4",
                finalAssistantText: "Manifest accepted.",
                transcript: [
                  { role: "user", content: "Inspect the workspace" },
                  { role: "assistant", content: "Manifest accepted." },
                ],
                modelTurns: 1,
                runState: {
                  runId: "run-manifest",
                  status: "completed",
                  createdAt: "2026-04-27T21:00:00.000Z",
                  updatedAt: "2026-04-27T21:00:01.000Z",
                  cfcEnforcementMode: "observe",
                  currentDir: "/workspace",
                  policyEvents: [],
                  toolOutputs: [],
                },
              } satisfies HarnessPromptLoopResult,
            );
          },
          runTranscript: () =>
            Promise.reject(new Error("unexpected resume path")),
        };
      },
    },
  );

  const engine = createdOptions?.engine as CfHarnessEngine | undefined;
  assertEquals(exitCode, 0);
  assertEquals(engine?.getRunState().runManifest?.wishId, "W-519");
  assertEquals(engine?.getRunState().cfcEnforcementMode, "observe");
  assertEquals(runPromptOptions?.promptSlotBinding, manifest.promptSlot);
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
  assertEquals(
    runPromptOptions?.systemPrompt,
    buildCfHarnessBatchSystemPrompt({
      systemPrompt: "You are a Loom batch worker.",
    }),
  );
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
                runReportPath:
                  "/tmp/project/.cf-harness-artifacts/run-cli-batch-json/run-report.json",
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
        runReportPath:
          "/tmp/project/.cf-harness-artifacts/run-cli-batch-json/run-report.json",
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

Deno.test({
  name:
    "runCfHarnessCli preloads configured skills and persists skill artifacts",
  permissions: { read: true, write: true },
  async fn() {
    const workspace = await Deno.makeTempDir({
      prefix: "cf-harness-cli-skills-",
    });
    try {
      const skillDir = join(workspace, "labs", "skills", "pattern-dev");
      await Deno.mkdir(skillDir, { recursive: true });
      await Deno.writeTextFile(
        join(skillDir, "SKILL.md"),
        [
          "---",
          "name: pattern-dev",
          "description: Build Common Fabric patterns",
          "---",
          "",
          "# Pattern Dev",
          "",
          "Read the pattern development guide first.",
        ].join("\n"),
      );
      const { io, stdout, stderr } = createIoBuffers();
      let runPromptOptions: RunHarnessPromptOptions | undefined;
      let engine: CfHarnessEngine | undefined;

      const exitCode = await runCfHarnessCli(
        [
          "--workspace",
          workspace,
          "--prompt",
          "Build a pattern",
          "--gateway-auth-mode",
          "none",
          "--skills-root",
          "labs/skills",
          "--skill",
          "pattern-dev",
        ],
        {
          io,
          env: {},
          createPromptLoop: (options) => {
            engine = options.engine;
            return {
              runPrompt: (promptOptions) => {
                runPromptOptions = promptOptions;
                return Promise.resolve(
                  ({
                    model: "gpt-5.4",
                    finalAssistantText: "Done.",
                    transcript: [
                      ...(promptOptions.contextMessages ?? []).map((
                        content,
                      ) => ({ role: "user" as const, content })),
                      { role: "user", content: promptOptions.prompt },
                      { role: "assistant", content: "Done." },
                    ],
                    modelTurns: 1,
                    runState: options.engine!.getRunState(),
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
      assertEquals(stderr, []);
      assertEquals(stdout[0].includes("Done."), true);
      assertEquals(runPromptOptions?.contextMessages?.length, 1);
      assertEquals(
        runPromptOptions?.contextMessages?.[0].includes(
          '<skill_context name="pattern-dev" source="/workspace/labs/skills/pattern-dev/SKILL.md">',
        ),
        true,
      );
      assertEquals(
        runPromptOptions?.systemPrompt?.includes(
          "Configured skills guidance:",
        ),
        true,
      );

      const runState = engine!.getRunState();
      assertEquals(runState.skillRegistry?.skills[0].name, "pattern-dev");
      assertEquals(
        runState.skillActivations?.activations[0].cfcPromptRole,
        "context",
      );
      assertEquals(
        JSON.parse(await Deno.readTextFile(runState.skillRegistryPath!)).type,
        "cf-harness.skill-registry",
      );
      assertEquals(
        JSON.parse(await Deno.readTextFile(runState.skillActivationsPath!))
          .type,
        "cf-harness.skill-activations",
      );
    } finally {
      await Deno.remove(workspace, { recursive: true });
    }
  },
});

Deno.test("buildCfHarnessOperatorSystemPrompt appends user instructions after guardrails", () => {
  assertEquals(
    buildCfHarnessOperatorSystemPrompt({
      workspace: "/tmp/project",
      focusRoot: "/tmp/project/packages/cf-harness",
      systemPrompt: "Use bash and read_file only. Do not modify files.",
    }),
    [
      buildCfHarnessBaseSystemPrompt(),
      "",
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
    buildCfHarnessBatchSystemPrompt({
      systemPrompt: "You are a Loom batch worker.",
    }),
  );
});

Deno.test("resolveCfHarnessCliSystemPrompt honors disabled skill catalog guidance", () => {
  const prompt = resolveCfHarnessCliSystemPrompt({
    workspace: "/tmp/project",
    focusRoot: "/tmp/project/packages/cf-harness",
    outputMode: "operator",
    skillCatalogEnabled: false,
    skillNames: ["pattern-dev"],
  });

  assertEquals(prompt?.includes("Configured skills guidance:"), false);
});

Deno.test("resolveCfHarnessCliSystemPrompt includes enabled skill guidance", () => {
  const prompt = resolveCfHarnessCliSystemPrompt({
    workspace: "/tmp/project",
    focusRoot: "/tmp/project/packages/cf-harness",
    outputMode: "operator",
    skillCatalogEnabled: true,
    skillNames: ["pattern-dev"],
  });

  assertEquals(prompt?.includes("Configured skills guidance:"), true);
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
  let createdOptions: Record<string, unknown> | undefined;
  let runTranscriptOptions: RunHarnessTranscriptOptions | undefined;
  const promptSlotBinding = {
    type: CFC_PROMPT_SLOT_BOUND_ATOM_TYPE,
    source: { type: "loom.run", runId: "run-1" },
    role: "context",
    kernelName: "cf-harness",
    surface: "loom",
    subject: "original-run",
    eventId: "event-original",
  } as const;
  const exitCode = await runCfHarnessCli(
    [
      "--resume-run",
      "/tmp/project/.cf-harness-artifacts/run-1/run-state.json",
      "--allow-tool",
      "delegate_task",
      "--allow-subagent-profile",
      "default",
    ],
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
            promptSlotBinding,
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
      createPromptLoop: (options) => {
        createdOptions = options as Record<string, unknown>;
        return {
          runPrompt: () => Promise.reject(new Error("unexpected prompt path")),
          runTranscript: (options) => {
            runTranscriptOptions = options;
            const { transcript, model } = options;
            return Promise.resolve(
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
            );
          },
        };
      },
    },
  );

  assertEquals(exitCode, 0);
  assertEquals(createdOptions?.allowedToolIds, ["delegate_task"]);
  assertEquals(createdOptions?.allowedSubagentProfiles, ["default"]);
  assertEquals(runTranscriptOptions?.promptSlotBinding, promptSlotBinding);
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

Deno.test("parseCfHarnessCliArgs resolves fabric-mount to an absolute path", async () => {
  const parsed = await parseCfHarnessCliArgs(
    ["--prompt", "hi", "--fabric-mount", "/tmp/cf-fuse"],
    { cwd: "/tmp/project", env: {} },
  );
  if ("help" in parsed) throw new Error("expected config result");
  assertEquals(parsed.fabricMount, "/tmp/cf-fuse");
});

Deno.test("parseCfHarnessCliArgs supports sandbox image flag", async () => {
  const parsed = await parseCfHarnessCliArgs(
    ["--prompt", "hi", "--sandbox-image", "registry.example/cf:deno2"],
    { cwd: "/tmp/project", env: {} },
  );
  if ("help" in parsed) throw new Error("expected config result");
  assertEquals(parsed.sandboxImage, "registry.example/cf:deno2");
});

Deno.test("parseCfHarnessCliArgs supports sandbox image environment default", async () => {
  const parsed = await parseCfHarnessCliArgs(
    ["--prompt", "hi"],
    {
      cwd: "/tmp/project",
      env: { CF_HARNESS_SANDBOX_IMAGE: "registry.example/cf:local" },
    },
  );
  if ("help" in parsed) throw new Error("expected config result");
  assertEquals(parsed.sandboxImage, "registry.example/cf:local");
});

Deno.test("parseCfHarnessCliArgs prefers sandbox image flag over environment", async () => {
  const parsed = await parseCfHarnessCliArgs(
    ["--prompt", "hi", "--sandbox-image", "registry.example/cf:flag"],
    {
      cwd: "/tmp/project",
      env: { CF_HARNESS_SANDBOX_IMAGE: "registry.example/cf:env" },
    },
  );
  if ("help" in parsed) throw new Error("expected config result");
  assertEquals(parsed.sandboxImage, "registry.example/cf:flag");
});

Deno.test("parseCfHarnessCliArgs rejects empty sandbox image value", async () => {
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        ["--prompt", "hi", "--sandbox-image", ""],
        { cwd: "/tmp/project", env: {} },
      ),
    Error,
    "--sandbox-image requires a non-empty image reference",
  );
});

Deno.test("parseCfHarnessCliArgs omits fabricMount when flag is absent", async () => {
  const parsed = await parseCfHarnessCliArgs(
    ["--prompt", "hi"],
    { cwd: "/tmp/project", env: {} },
  );
  if ("help" in parsed) throw new Error("expected config result");
  assertEquals(parsed.fabricMount, undefined);
});

Deno.test("parseCfHarnessCliArgs resolves relative fabric-mount against cwd", async () => {
  const parsed = await parseCfHarnessCliArgs(
    ["--prompt", "hi", "--fabric-mount", "fuse-dir"],
    { cwd: "/tmp/project", env: {} },
  );
  if ("help" in parsed) throw new Error("expected config result");
  assertEquals(parsed.fabricMount, "/tmp/project/fuse-dir");
});

Deno.test("parseCfHarnessCliArgs rejects empty fabric-mount value", async () => {
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        ["--prompt", "hi", "--fabric-mount", ""],
        { cwd: "/tmp/project", env: {} },
      ),
    Error,
    "--fabric-mount requires a non-empty path",
  );
});

Deno.test("buildCfHarnessOperatorSystemPrompt includes fabric mount guidance", () => {
  const prompt = buildCfHarnessOperatorSystemPrompt({
    workspace: "/tmp/project",
    systemPrompt: undefined,
    fabricMountPath: "/fabric",
  });
  assertEquals(
    prompt.includes(
      "A Common Fabric space is mounted at /fabric. You may browse its contents for context.",
    ),
    true,
  );
});

Deno.test("buildCfHarnessOperatorSystemPrompt omits fabric guidance without mount", () => {
  const prompt = buildCfHarnessOperatorSystemPrompt({
    workspace: "/tmp/project",
    systemPrompt: undefined,
  });
  assertEquals(prompt.includes("mounted at"), false);
});

Deno.test("runCfHarnessCli threads fabric-mount into engine additionalMounts", async () => {
  const { io, stderr } = createIoBuffers();
  let createdOptions: Record<string, unknown> | undefined;
  let runPromptOptions: RunHarnessPromptOptions | undefined;
  const exitCode = await runCfHarnessCli(
    [
      "--workspace",
      "/tmp/project",
      "--prompt",
      "Browse fabric",
      "--fabric-mount",
      "/tmp/cf-fuse",
      "--gateway-auth-mode",
      "none",
    ],
    {
      io,
      env: {},
      createPromptLoop: (options) => {
        createdOptions = options as Record<string, unknown>;
        return {
          runPrompt: (options) => {
            runPromptOptions = options;
            return Promise.resolve(
              ({
                model: "gpt-5.4",
                finalAssistantText: "Done.",
                transcript: [
                  { role: "user", content: "Browse fabric" },
                  { role: "assistant", content: "Done." },
                ],
                modelTurns: 1,
                runState: {
                  runId: "run-fabric",
                  status: "completed",
                  createdAt: "2026-04-30T00:00:00.000Z",
                  updatedAt: "2026-04-30T00:00:01.000Z",
                  cfcEnforcementMode: "disabled",
                  currentDir: "/workspace",
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
  assertEquals(stderr, []);
  const engine = createdOptions?.engine as CfHarnessEngine | undefined;
  const mounts = engine?.sandbox.describe?.()?.cfc?.mounts;
  assertEquals(mounts?.length, 2);
  assertEquals(mounts?.[1]?.kind, "fabric-fuse");
  assertEquals(mounts?.[1]?.sandboxPath, "/fabric");
  assertEquals(
    runPromptOptions?.systemPrompt?.includes(
      "A Common Fabric space is mounted at /fabric",
    ),
    true,
  );
});

Deno.test("runCfHarnessCli threads sandbox-image into engine sandbox config", async () => {
  const { io, stderr } = createIoBuffers();
  let createdOptions: Record<string, unknown> | undefined;
  const exitCode = await runCfHarnessCli(
    [
      "--workspace",
      "/tmp/project",
      "--prompt",
      "Inspect the workspace",
      "--sandbox-image",
      "registry.example/cf:deno2",
      "--gateway-auth-mode",
      "none",
    ],
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
                finalAssistantText: "Done.",
                transcript: [
                  { role: "user", content: "Inspect the workspace" },
                  { role: "assistant", content: "Done." },
                ],
                modelTurns: 1,
                runState: {
                  runId: "run-sandbox-image",
                  status: "completed",
                  createdAt: "2026-05-01T00:00:00.000Z",
                  updatedAt: "2026-05-01T00:00:01.000Z",
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
  assertEquals(stderr, []);
  const engine = createdOptions?.engine as CfHarnessEngine | undefined;
  assertEquals(
    engine?.sandbox.describe?.()?.cfc?.image,
    "registry.example/cf:deno2",
  );
});
