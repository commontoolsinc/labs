import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { decodeBase64 } from "@std/encoding/base64";
import { join } from "@std/path";
import {
  buildCfHarnessBaseSystemPrompt,
  buildCfHarnessBatchSystemPrompt,
  buildCfHarnessOperatorSystemPrompt,
  type CfHarnessCliIO,
  type CfHarnessCliSignalHandler,
  createCfHarnessBatchResult,
  createCfHarnessCliCapabilities,
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
import {
  CfHarnessPromptLoop,
  type HarnessPromptLoopResult,
  type RunHarnessPromptOptions,
  type RunHarnessTranscriptOptions,
} from "../src/prompt-loop.ts";
import { InMemoryHarnessCredentialStore } from "../src/auth/credential-store.ts";
import type { HarnessModelClient } from "../src/model/client.ts";

const ONE_PIXEL_PNG = decodeBase64(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p94AAAAASUVORK5CYII=",
);

const syntheticTmpProjectPath = (...segments: string[]): string =>
  join(Deno.realPathSync("/tmp"), "project", ...segments);

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

const completedCliResult = (
  runId: string,
  finalAssistantText = "Done.",
): HarnessPromptLoopResult => ({
  model: "gpt-5.4",
  finalAssistantText,
  transcript: [
    { role: "user", content: "hello" },
    { role: "assistant", content: finalAssistantText },
  ],
  modelTurns: 1,
  runState: {
    runId,
    status: "completed",
    createdAt: "2026-07-22T12:00:00.000Z",
    updatedAt: "2026-07-22T12:00:01.000Z",
    cfcEnforcementMode: "disabled",
    currentDir: "/workspace",
    policyEvents: [],
    toolOutputs: [],
  },
});

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
  assertEquals(parsed.model, "gpt-5.5");
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
    "--image must stay within the workspace or a host mount",
  );
});

Deno.test("parseCfHarnessCliArgs accepts image attachments from a host mount", async () => {
  const workspace = await Deno.makeTempDir();
  const mounted = await Deno.makeTempDir();
  const launcherCwd = await Deno.makeTempDir();
  const imagePath = join(mounted, "capture.png");
  await Deno.writeFile(imagePath, ONE_PIXEL_PNG);

  const parsed = await parseCfHarnessCliArgs(
    [
      "--workspace",
      workspace,
      "--host-mount",
      `name=file-cabinet,source=${mounted},target=/file-cabinet,mode=readonly`,
      "--image",
      imagePath,
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
  assertEquals(parsed.hostMounts, [{
    name: "file-cabinet",
    hostPath: await Deno.realPath(mounted),
    sandboxPath: "/file-cabinet",
    mode: "readonly",
  }]);
  assertEquals(parsed.imageAttachments.length, 1);
  assertEquals(
    parsed.imageAttachments[0].hostPath,
    await Deno.realPath(imagePath),
  );
  assertEquals(parsed.imageAttachments[0].mediaType, "image/png");
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
    "--image must stay within the workspace or a host mount",
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

Deno.test("parseCfHarnessCliArgs resolves sandbox docker runtime from flag and environment", async () => {
  const fromFlag = await parseCfHarnessCliArgs(
    ["--prompt", "hi", "--sandbox-docker-runtime", "runc"],
    {
      cwd: "/tmp/project",
      env: { CF_HARNESS_SANDBOX_DOCKER_RUNTIME: "runsc-cfc" },
    },
  );
  if ("help" in fromFlag) {
    throw new Error("expected config result");
  }
  assertEquals(fromFlag.sandboxDockerRuntime, "runc");

  const fromEnv = await parseCfHarnessCliArgs(
    ["--prompt", "hi"],
    {
      cwd: "/tmp/project",
      env: { CF_HARNESS_SANDBOX_DOCKER_RUNTIME: "runc" },
    },
  );
  if ("help" in fromEnv) {
    throw new Error("expected config result");
  }
  assertEquals(fromEnv.sandboxDockerRuntime, "runc");

  const unset = await parseCfHarnessCliArgs(
    ["--prompt", "hi"],
    { cwd: "/tmp/project", env: {} },
  );
  if ("help" in unset) {
    throw new Error("expected config result");
  }
  assertEquals(unset.sandboxDockerRuntime, undefined);

  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        ["--prompt", "hi", "--sandbox-docker-runtime", "  "],
        { cwd: "/tmp/project", env: {} },
      ),
    Error,
    "--sandbox-docker-runtime requires a non-empty runtime name",
  );
});

Deno.test("parseCfHarnessCliArgs resolves gateway config from environment", async () => {
  const parsed = await parseCfHarnessCliArgs(
    ["--prompt", "hi"],
    {
      cwd: "/tmp/project",
      env: {
        CF_HARNESS_GATEWAY_BASE_URL: "http://localhost:8080/",
        CF_HARNESS_GATEWAY_AUTH_MODE: "none",
        CF_HARNESS_MODEL: "gpt-oss-120b",
      },
    },
  );

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.gatewayBaseUrl, "http://localhost:8080/");
  assertEquals(parsed.gatewayAuthMode, "none");
  assertEquals(parsed.model, "gpt-oss-120b");
});

Deno.test("parseCfHarnessCliArgs prefers gateway flags over environment", async () => {
  const parsed = await parseCfHarnessCliArgs(
    [
      "--prompt",
      "hi",
      "--gateway-base-url",
      "https://llm.example.test/",
      "--gateway-auth-mode",
      "bearer",
      "--model",
      "gpt-5.5",
    ],
    {
      cwd: "/tmp/project",
      env: {
        CF_HARNESS_GATEWAY_BASE_URL: "http://localhost:8080/",
        CF_HARNESS_GATEWAY_AUTH_MODE: "none",
        CF_HARNESS_MODEL: "gpt-oss-120b",
      },
    },
  );

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.gatewayBaseUrl, "https://llm.example.test/");
  assertEquals(parsed.gatewayAuthMode, "bearer");
  assertEquals(parsed.model, "gpt-5.5");
});

Deno.test("parseCfHarnessCliArgs rejects invalid gateway auth mode from environment", async () => {
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(["--prompt", "hi"], {
        cwd: "/tmp/project",
        env: { CF_HARNESS_GATEWAY_AUTH_MODE: "token" },
      }),
    Error,
    "gateway auth mode must be one of bearer, none",
  );
});

Deno.test("parseCfHarnessCliArgs ignores blank gateway environment values", async () => {
  const parsed = await parseCfHarnessCliArgs(
    ["--prompt", "hi"],
    {
      cwd: "/tmp/project",
      env: {
        CF_HARNESS_GATEWAY_BASE_URL: "  ",
        CF_HARNESS_GATEWAY_AUTH_MODE: "",
        CF_HARNESS_MODEL: " ",
      },
    },
  );

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.gatewayBaseUrl, "https://llm.stage.commontools.dev/");
  assertEquals(parsed.gatewayAuthMode, "bearer");
  assertEquals(parsed.model, "gpt-5.5");
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
      assertEquals(
        parsed.skillsRoot,
        await Deno.realPath(join(workspace, "labs", "skills")),
      );
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
      "view_image",
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
    "view_image",
    "read_skill_resource",
    "bash",
  ]);
  assertEquals(parsed.allowedSubagentProfiles, []);
  assertEquals(parsed.resultJsonPath, "/tmp/project/results/output.json");
});

Deno.test({
  name:
    "parseCfHarnessCliArgs parses exact skill script allowlists with skills root",
  permissions: { read: true, write: true },
  async fn() {
    const root = await Deno.makeTempDir({
      prefix: "cf-harness-cli-skill-scripts-",
    });
    try {
      await Deno.mkdir(`${root}/skills`, { recursive: true });
      const parsed = await parseCfHarnessCliArgs(
        [
          "--workspace",
          root,
          "--prompt",
          "hi",
          "--skills-root",
          "skills",
          "--skill",
          "deno-memory-profiler",
          "--allow-tool",
          "run_skill_script",
          "--allow-skill-script",
          "deno-memory-profiler:scripts/memory.ts",
          "--allow-skill-script",
          "deno-memory-profiler:scripts/memory.ts",
          "--skill-script-execution-target",
          "host",
        ],
        {
          cwd: root,
          env: {},
        },
      );

      if ("help" in parsed) {
        throw new Error("expected config result");
      }
      assertEquals(parsed.allowedToolIds, ["run_skill_script"]);
      assertEquals(parsed.allowedSkillScripts, [{
        skill: "deno-memory-profiler",
        path: "scripts/memory.ts",
      }]);
      assertEquals(parsed.skillScriptExecutionTarget, "host");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test("parseCfHarnessCliArgs rejects invalid skill script execution targets", async () => {
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        [
          "--prompt",
          "hi",
          "--skill-script-execution-target",
          "remote",
        ],
        { cwd: "/tmp/project", env: {} },
      ),
    Error,
    "skill script execution target must be one of sandbox, host",
  );
});

Deno.test("parseCfHarnessCliArgs rejects skill script allowlists without a skills root", async () => {
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        [
          "--prompt",
          "hi",
          "--allow-skill-script",
          "pattern-test:scripts/check.ts",
        ],
        { cwd: "/tmp/project", env: {} },
      ),
    Error,
    "--allow-skill-script requires --skills-root",
  );
});

Deno.test("parseCfHarnessCliArgs supports structured result validation flags", async () => {
  const parsed = await parseCfHarnessCliArgs(
    [
      "--prompt",
      "hi",
      "--structured-result-path",
      "results/capture.results.json",
      "--structured-result-schema-file",
      "schemas/capture.schema.json",
    ],
    {
      cwd: "/tmp/project",
      env: {},
      readTextFile: (path) => {
        assertEquals(path, "/tmp/project/schemas/capture.schema.json");
        return Promise.resolve(
          JSON.stringify({
            type: "object",
            properties: {
              ok: { type: "boolean" },
            },
            required: ["ok"],
            additionalProperties: false,
          }),
        );
      },
    },
  );

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(
    parsed.structuredResult?.path,
    syntheticTmpProjectPath("results", "capture.results.json"),
  );
  assertEquals(
    parsed.structuredResult?.sandboxPath,
    "/workspace/results/capture.results.json",
  );
  assertEquals(parsed.structuredResult?.schema, {
    type: "object",
    properties: {
      ok: { type: "boolean" },
    },
    required: ["ok"],
    additionalProperties: false,
  });
});

Deno.test("parseCfHarnessCliArgs rejects malformed structured result validation flags", async () => {
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        [
          "--prompt",
          "hi",
          "--structured-result-path",
          "../capture.results.json",
          "--structured-result-schema",
          '{"type":"object"}',
        ],
        {
          cwd: "/tmp/project",
          env: {},
        },
      ),
    Error,
    "--structured-result-path must stay within the workspace",
  );
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        [
          "--prompt",
          "hi",
          "--structured-result-path",
          "capture.results.json",
        ],
        {
          cwd: "/tmp/project",
          env: {},
        },
      ),
    Error,
    "--structured-result-path requires --structured-result-schema or --structured-result-schema-file",
  );
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        [
          "--prompt",
          "hi",
          "--structured-result-schema",
          '{"type":"object"}',
        ],
        {
          cwd: "/tmp/project",
          env: {},
        },
      ),
    Error,
    "--structured-result-schema requires --structured-result-path",
  );
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        [
          "--prompt",
          "hi",
          "--structured-result-path",
          "capture.results.json",
          "--structured-result-schema",
          '{"type":"object"}',
          "--structured-result-schema-file",
          "schema.json",
        ],
        {
          cwd: "/tmp/project",
          env: {},
        },
      ),
    Error,
    "provide only one of --structured-result-schema or --structured-result-schema-file",
  );
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

Deno.test("parseCfHarnessCliArgs supports a Browser Access lease", async () => {
  const parsed = await parseCfHarnessCliArgs(
    [
      "--prompt",
      "hi",
      "--allow-tool",
      "delegate_task",
      "--allow-subagent-profile",
      "browser",
      "--browser-access-lease-id",
      "pf-run-1",
      "--browser-access-cdp-url",
      "http://127.0.0.1:9363/",
      "--browser-access-owner",
      "pattern-factory",
      "--browser-access-expires-at",
      "2026-05-29T22:00:00Z",
      "--browser-access-profile-mode",
      "transient",
      "--browser-access-account-access",
      "none",
    ],
    {
      cwd: "/tmp/project",
      env: {},
    },
  );

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.browserAccess, {
    type: "cf-harness.chat.browser-access-lease",
    leaseId: "pf-run-1",
    cdpUrl: "http://127.0.0.1:9363",
    owner: "pattern-factory",
    expiresAt: "2026-05-29T22:00:00Z",
    profileMode: "transient",
    accountAccess: "none",
  });
});

Deno.test("parseCfHarnessCliArgs rejects malformed Browser Access leases", async () => {
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        [
          "--prompt",
          "hi",
          "--browser-access-cdp-url",
          "http://127.0.0.1:9363",
        ],
        {
          cwd: "/tmp/project",
          env: {},
        },
      ),
    Error,
    "--browser-access-lease-id requires a non-empty value",
  );
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        [
          "--prompt",
          "hi",
          "--browser-access-lease-id",
          "pf-run-1",
        ],
        {
          cwd: "/tmp/project",
          env: {},
        },
      ),
    Error,
    "--browser-access-cdp-url is required",
  );
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        [
          "--prompt",
          "hi",
          "--browser-access-lease-id",
          "pf-run-1",
          "--browser-access-cdp-url",
          "https://example.com:9363",
        ],
        {
          cwd: "/tmp/project",
          env: {},
        },
      ),
    Error,
    "--browser-access-cdp-url must be an http:// local origin with an explicit port",
  );
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        [
          "--prompt",
          "hi",
          "--browser-access-lease-id",
          "pf-run-1",
          "--browser-access-cdp-url",
          "http://127.0.0.1:9363",
          "--browser-access-profile-mode",
          "loggedout",
        ],
        {
          cwd: "/tmp/project",
          env: {},
        },
      ),
    Error,
    "--browser-access-profile-mode must be one of: persistent, transient",
  );
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        [
          "--prompt",
          "hi",
          "--browser-access-lease-id",
          "pf-run-1",
          "--browser-access-cdp-url",
          "http://127.0.0.1:9363",
          "--browser-access-profile-mode",
          "",
        ],
        {
          cwd: "/tmp/project",
          env: {},
        },
      ),
    Error,
    "--browser-access-profile-mode must be one of: persistent, transient",
  );
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        [
          "--prompt",
          "hi",
          "--browser-access-lease-id",
          "pf-run-1",
          "--browser-access-cdp-url",
          "http://127.0.0.1:9363",
          "--browser-access-account-access",
          "",
        ],
        {
          cwd: "/tmp/project",
          env: {},
        },
      ),
    Error,
    "--browser-access-account-access must be one of: available, none",
  );
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        [
          "--prompt",
          "hi",
          "--browser-access-lease-id",
          "pf-run-1",
          "--browser-access-cdp-url",
          "http://127.0.0.1:9363",
          "--browser-access-expires-at",
          "not-a-timestamp",
        ],
        {
          cwd: "/tmp/project",
          env: {},
        },
      ),
    Error,
    "--browser-access-expires-at must be a valid timestamp",
  );
});

Deno.test("parseCfHarnessCliArgs supports explicit web_fetch subagent profile authorization", async () => {
  const parsed = await parseCfHarnessCliArgs(
    [
      "--prompt",
      "hi",
      "--allow-tool",
      "delegate_task",
      "--allow-subagent-profile",
      "web_fetch",
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
  assertEquals(parsed.allowedSubagentProfiles, ["web_fetch"]);
});

Deno.test("parseCfHarnessCliArgs supports explicit web_search subagent profile authorization", async () => {
  const parsed = await parseCfHarnessCliArgs(
    [
      "--prompt",
      "hi",
      "--allow-tool",
      "delegate_task",
      "--allow-subagent-profile",
      "web_search",
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
  assertEquals(parsed.allowedSubagentProfiles, ["web_search"]);
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
      name: "explicit web_fetch profile when parent tools are unrestricted",
      flags: ["--allow-subagent-profile", "web_fetch"],
      allowedToolIds: undefined,
      allowedSubagentProfiles: ["web_fetch"],
    },
    {
      name: "explicit web_search profile when parent tools are unrestricted",
      flags: ["--allow-subagent-profile", "web_search"],
      allowedToolIds: undefined,
      allowedSubagentProfiles: ["web_search"],
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
      name:
        "default, browser, web_fetch, and web_search profiles can all be preauthorized",
      flags: [
        "--allow-tool",
        "delegate_task",
        "--allow-subagent-profile",
        "default",
        "--allow-subagent-profile",
        "browser",
        "--allow-subagent-profile",
        "web_fetch",
        "--allow-subagent-profile",
        "web_search",
      ],
      allowedToolIds: ["delegate_task"],
      allowedSubagentProfiles: [
        "default",
        "browser",
        "web_fetch",
        "web_search",
      ],
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
    "allowed subagent profiles must be one or more of default, browser, web_fetch, web_search",
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
    "allowed tools must be one or more of bash, read_file, view_image, web_fetch, read_skill_resource, run_skill_script, edit_file, write_file, delegate_task",
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
    "allowed tools must be one or more of bash, read_file, view_image, web_fetch, read_skill_resource, run_skill_script, edit_file, write_file, delegate_task",
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

Deno.test("runCfHarnessCli prints machine-readable capabilities", async () => {
  const { io, stdout, stderr } = createIoBuffers();
  const exitCode = await runCfHarnessCli(["--describe-capabilities"], { io });

  assertEquals(exitCode, 0);
  assertEquals(stderr, []);
  assertEquals(stdout.length, 1);
  const capabilities = JSON.parse(stdout[0]);
  assertEquals(capabilities, createCfHarnessCliCapabilities());
  assertEquals(capabilities.type, "cf-harness.capabilities");
  assertEquals(capabilities.version, 1);
  assertEquals(capabilities.parentToolIds.includes("web_fetch"), true);
  assertEquals(capabilities.parentToolIds.includes("bash-no-sandbox"), false);
  assertEquals(capabilities.builtinToolIds.includes("bash-no-sandbox"), true);
  assertEquals(capabilities.subagentProfiles.includes("web_search"), true);
  assertEquals(capabilities.nativeModelToolIds.includes("google_search"), true);
  assertEquals(
    capabilities.cliFlags.includes("--structured-result-path"),
    true,
  );
  assertEquals(
    capabilities.cliFlags.includes("--browser-access-cdp-url"),
    true,
  );
  assertEquals(
    capabilities.cliFlags.includes("--browser-access-profile-mode"),
    true,
  );
  assertEquals(capabilities.cliFlags.includes("--describe-capabilities"), true);
  assertEquals(capabilities.repeatableCliFlags.includes("--allow-tool"), true);
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
    {
      name: "delegate_task with explicit web_search profile authorization",
      flags: [
        "--allow-tool",
        "delegate_task",
        "--allow-subagent-profile",
        "web_search",
      ],
      allowedToolIds: ["delegate_task"],
      allowedSubagentProfiles: ["web_search"],
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

Deno.test("runCfHarnessCli passes Browser Access leases to the prompt loop", async () => {
  const { io, stdout, stderr } = createIoBuffers();
  let createdOptions: Record<string, unknown> | undefined;
  const exitCode = await runCfHarnessCli(
    [
      "--workspace",
      "/tmp/project",
      "--prompt",
      "Use browser.",
      "--gateway-auth-mode",
      "none",
      "--allow-tool",
      "delegate_task",
      "--allow-subagent-profile",
      "browser",
      "--browser-access-lease-id",
      "pf-run-1",
      "--browser-access-cdp-url",
      "http://localhost:9363",
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
                finalAssistantText: "Browser lease configured.",
                transcript: [
                  { role: "user", content: "Use browser." },
                  {
                    role: "assistant",
                    content: "Browser lease configured.",
                  },
                ],
                modelTurns: 1,
                runState: {
                  runId: "run-browser-access",
                  status: "completed",
                  createdAt: "2026-05-29T22:00:00.000Z",
                  updatedAt: "2026-05-29T22:00:01.000Z",
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

  assertEquals(exitCode, 0);
  assertEquals(createdOptions?.browserAccess, {
    type: "cf-harness.chat.browser-access-lease",
    leaseId: "pf-run-1",
    cdpUrl: "http://localhost:9363",
  });
  assertEquals(stdout.length, 1);
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

Deno.test("runCfHarnessCli validates a top-level structured result sidecar", async () => {
  const { io, stdout, stderr } = createIoBuffers();
  const writes: Array<{ path: string; text: string }> = [];
  let runPromptOptions: RunHarnessPromptOptions | undefined;
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
      "--structured-result-path",
      "capture.results.json",
      "--structured-result-schema",
      JSON.stringify({
        type: "object",
        properties: {
          ok: { type: "boolean" },
          status: { type: "string", enum: ["done", "blocked"] },
        },
        required: ["ok", "status"],
        additionalProperties: false,
      }),
    ],
    {
      io,
      env: {},
      readTextFile: (path) => {
        assertEquals(path, syntheticTmpProjectPath("capture.results.json"));
        return Promise.resolve(JSON.stringify({ ok: true, status: "done" }));
      },
      writeTextFile: (path, text) => {
        writes.push({ path, text });
        return Promise.resolve();
      },
      createPromptLoop: () => ({
        runPrompt: (options) => {
          runPromptOptions = options;
          return Promise.resolve(
            ({
              model: "gpt-5.4",
              finalAssistantText: "Batch result.",
              transcript: [
                { role: "user", content: "Execute the batch task" },
                { role: "assistant", content: "Batch result." },
              ],
              modelTurns: 2,
              runState: {
                runId: "run-cli-structured-result",
                status: "completed",
                createdAt: "2026-04-16T23:10:00.000Z",
                updatedAt: "2026-04-16T23:10:02.000Z",
                cfcEnforcementMode: "observe",
                currentDir: "/workspace",
                artifactRoot:
                  "/tmp/project/.cf-harness-artifacts/run-cli-structured-result",
                transcriptPath:
                  "/tmp/project/.cf-harness-artifacts/run-cli-structured-result/transcript.json",
                runReportPath:
                  "/tmp/project/.cf-harness-artifacts/run-cli-structured-result/run-report.json",
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
  assertEquals(stdout, ["Batch result.\n"]);
  assertEquals(stderr, []);
  assertEquals(
    runPromptOptions?.systemPrompt?.includes(
      "write a JSON file at /workspace/capture.results.json",
    ),
    true,
  );
  assertEquals(writes.length, 1);
  assertEquals(writes[0].path, "/tmp/project/out/result.json");
  const batchResult = JSON.parse(writes[0].text);
  assertEquals(batchResult.structured_result.status, "valid");
  assertEquals(
    batchResult.structured_result.result_path,
    syntheticTmpProjectPath("capture.results.json"),
  );
  assertEquals(
    batchResult.structured_result.schema_digest.startsWith("sha256:"),
    true,
  );
});

Deno.test("runCfHarnessCli exits nonzero when top-level structured result is invalid", async () => {
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
      "--structured-result-path",
      "capture.results.json",
      "--structured-result-schema",
      JSON.stringify({
        type: "object",
        properties: {
          ok: { type: "boolean" },
        },
        required: ["ok"],
        additionalProperties: false,
      }),
    ],
    {
      io,
      env: {},
      readTextFile: () =>
        Promise.resolve(JSON.stringify({ ok: true, extra: "not allowed" })),
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
                runId: "run-cli-structured-result-invalid",
                status: "completed",
                createdAt: "2026-04-16T23:10:00.000Z",
                updatedAt: "2026-04-16T23:10:02.000Z",
                cfcEnforcementMode: "observe",
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

  assertEquals(exitCode, 1);
  assertEquals(stdout, ["Batch result.\n"]);
  assertEquals(stderr, [
    "structured result validation failed: structured result did not match the schema\n",
  ]);
  assertEquals(writes.length, 1);
  const batchResult = JSON.parse(writes[0].text);
  assertEquals(batchResult.structured_result, {
    type: "cf-harness.structured-result-validation",
    status: "invalid",
    schema_digest: batchResult.structured_result.schema_digest,
    result_path: syntheticTmpProjectPath("capture.results.json"),
    validation_error: "structured result did not match the schema",
  });
  assertEquals(
    batchResult.structured_result.schema_digest.startsWith("sha256:"),
    true,
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

Deno.test({
  name:
    "runCfHarnessCli passes host skill script execution target into run_skill_script",
  permissions: { read: true, write: true, run: true, env: true },
  async fn() {
    const workspace = await Deno.makeTempDir({
      prefix: "cf-harness-cli-host-skill-script-",
    });
    try {
      const skillDir = join(workspace, "skills", "agent-browser");
      const scriptSource = [
        "#!/bin/bash",
        "set -euo pipefail",
        'echo "target=$CF_HARNESS_SKILL_SCRIPT_EXECUTION_TARGET"',
        'echo "skill=$SKILL_NAME"',
        'echo "cdp=$2"',
        'echo "url=$3"',
        "",
      ].join("\n");
      await Deno.mkdir(join(skillDir, "scripts"), { recursive: true });
      await Deno.writeTextFile(
        join(skillDir, "SKILL.md"),
        [
          "---",
          "name: agent-browser",
          "description: Browser automation",
          "---",
        ].join("\n"),
      );
      await Deno.writeTextFile(
        join(skillDir, "scripts", "capture-workflow.sh"),
        scriptSource,
        { mode: 0o755 },
      );

      const { io, stdout, stderr } = createIoBuffers();
      const fetchCalls: RequestInit[] = [];
      let engine: CfHarnessEngine | undefined;
      const exitCode = await runCfHarnessCli(
        [
          "--workspace",
          workspace,
          "--prompt",
          "Run the host skill script.",
          "--gateway-auth-mode",
          "none",
          "--skills-root",
          "skills",
          "--skill",
          "agent-browser",
          "--allow-tool",
          "run_skill_script",
          "--allow-skill-script",
          "agent-browser:scripts/capture-workflow.sh",
          "--skill-script-execution-target",
          "host",
          // Host skill-script execution is outside CFC mediation; this test
          // exercises target threading, not enforcement, so run with CFC off
          // rather than wiring sidecar transports it would never use.
          "--cfc-enforcement-mode",
          "disabled",
          "--browser-access-lease-id",
          "lease-1",
          "--browser-access-cdp-url",
          "http://localhost:9362",
          "--browser-access-owner",
          "test",
          "--browser-access-expires-at",
          "2099-01-01T00:00:00Z",
        ],
        {
          io,
          env: {},
          createPromptLoop: (options) => {
            engine = options.engine;
            return new CfHarnessPromptLoop({
              ...options,
              fetchFn: (_input, init) => {
                fetchCalls.push(init ?? {});
                const payload = fetchCalls.length === 1
                  ? {
                    choices: [{
                      index: 0,
                      message: {
                        role: "assistant",
                        content: "",
                        tool_calls: [{
                          id: "call-host-skill-script",
                          type: "function",
                          function: {
                            name: "run_skill_script",
                            arguments: JSON.stringify({
                              skill: "agent-browser",
                              path: "scripts/capture-workflow.sh",
                              args: [
                                "--cdp",
                                "http://localhost:9362",
                                "http://localhost:8000/piece",
                              ],
                            }),
                          },
                        }],
                      },
                    }],
                  }
                  : {
                    choices: [{
                      index: 0,
                      message: {
                        role: "assistant",
                        content: "Host skill script completed.",
                      },
                    }],
                  };
                return Promise.resolve(
                  new Response(JSON.stringify(payload), { status: 200 }),
                );
              },
            });
          },
        },
      );

      assertEquals(exitCode, 0);
      assertEquals(stderr, []);
      assertStringIncludes(stdout[0], "Host skill script completed.");
      assertEquals(fetchCalls.length, 2);

      const secondRequest = JSON.parse(String(fetchCalls[1]?.body)) as {
        messages: Array<{ role: string; content: string }>;
      };
      const toolMessage = secondRequest.messages.at(-1);
      assertEquals(toolMessage?.role, "tool");
      const toolOutput = JSON.parse(toolMessage!.content) as {
        status: string;
        executionTarget?: string;
        stdout?: string;
      };
      assertEquals(toolOutput.status, "executed");
      assertEquals(toolOutput.executionTarget, "host");
      assertStringIncludes(toolOutput.stdout ?? "", "target=host\n");
      assertStringIncludes(toolOutput.stdout ?? "", "skill=agent-browser\n");
      assertStringIncludes(
        toolOutput.stdout ?? "",
        "cdp=http://localhost:9362\n",
      );
      assertStringIncludes(
        toolOutput.stdout ?? "",
        "url=http://localhost:8000/piece\n",
      );

      const execution = engine!.getRunState().skillScriptExecutions
        ?.executions[0];
      assertEquals(execution?.executionTarget, "host");
      assertEquals(execution?.status, "executed");
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

Deno.test("parseCfHarnessCliArgs parses explicit host mounts", async () => {
  const workspace = await Deno.makeTempDir();
  const mountRoot = await Deno.makeTempDir();

  const parsed = await parseCfHarnessCliArgs(
    [
      "--workspace",
      workspace,
      "--host-mount",
      `name=file-cabinet,source=${mountRoot},target=/file-cabinet,mode=writable`,
      "--cwd",
      mountRoot,
      "--prompt",
      "hi",
    ],
    { cwd: workspace, env: {} },
  );

  if ("help" in parsed) throw new Error("expected config result");
  assertEquals(parsed.hostMounts, [{
    name: "file-cabinet",
    hostPath: await Deno.realPath(mountRoot),
    sandboxPath: "/file-cabinet",
    mode: "writable",
  }]);
  assertEquals(parsed.cwd, "/file-cabinet");
});

Deno.test("parseCfHarnessCliArgs rejects structured result paths in readonly host mounts", async () => {
  const workspace = await Deno.makeTempDir();
  const mountRoot = await Deno.makeTempDir();

  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        [
          "--workspace",
          workspace,
          "--host-mount",
          `name=docs,source=${mountRoot},target=/docs,mode=readonly`,
          "--structured-result-path",
          join(mountRoot, "result.json"),
          "--structured-result-schema",
          '{"type":"object"}',
          "--prompt",
          "hi",
        ],
        { cwd: workspace, env: {} },
      ),
    Error,
    "--structured-result-path must be inside a writable host mount",
  );
});

Deno.test("parseCfHarnessCliArgs allows structured result paths in writable host mounts", async () => {
  const workspace = await Deno.makeTempDir();
  const mountRoot = await Deno.makeTempDir();

  const parsed = await parseCfHarnessCliArgs(
    [
      "--workspace",
      workspace,
      "--host-mount",
      `name=file-cabinet,source=${mountRoot},target=/file-cabinet,mode=writable`,
      "--structured-result-path",
      join(mountRoot, "result.json"),
      "--structured-result-schema",
      '{"type":"object"}',
      "--prompt",
      "hi",
    ],
    { cwd: workspace, env: {} },
  );

  if ("help" in parsed) throw new Error("expected config result");
  assertEquals(
    parsed.structuredResult?.path,
    join(await Deno.realPath(mountRoot), "result.json"),
  );
  assertEquals(
    parsed.structuredResult?.sandboxPath,
    "/file-cabinet/result.json",
  );
});

Deno.test("parseCfHarnessCliArgs uses the most specific overlapping host mount", async () => {
  const workspace = await Deno.makeTempDir();
  const mountRoot = await Deno.makeTempDir();
  const nestedRoot = join(mountRoot, "nested");
  await Deno.mkdir(nestedRoot);

  const parsed = await parseCfHarnessCliArgs(
    [
      "--workspace",
      workspace,
      "--host-mount",
      `name=outer,source=${mountRoot},target=/outer,mode=readonly`,
      "--host-mount",
      `name=inner,source=${nestedRoot},target=/inner,mode=writable`,
      "--structured-result-path",
      join(nestedRoot, "result.json"),
      "--structured-result-schema",
      '{"type":"object"}',
      "--prompt",
      "hi",
    ],
    { cwd: workspace, env: {} },
  );

  if ("help" in parsed) throw new Error("expected config result");
  assertEquals(
    parsed.structuredResult?.path,
    join(await Deno.realPath(nestedRoot), "result.json"),
  );
  assertEquals(parsed.structuredResult?.sandboxPath, "/inner/result.json");
});

Deno.test("parseCfHarnessCliArgs rejects missing paths under symlink parents outside allowed roots", async () => {
  const workspace = await Deno.makeTempDir();
  const outside = await Deno.makeTempDir();
  const linkedOutside = join(workspace, "linked-outside");
  await Deno.symlink(outside, linkedOutside, { type: "dir" });

  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        [
          "--workspace",
          workspace,
          "--structured-result-path",
          join(linkedOutside, "missing-result.json"),
          "--structured-result-schema",
          '{"type":"object"}',
          "--prompt",
          "hi",
        ],
        { cwd: workspace, env: {} },
      ),
    Error,
    "--structured-result-path must stay within the workspace or a host mount",
  );
});

Deno.test("parseCfHarnessCliArgs rejects invalid host mount specs", async () => {
  const workspace = await Deno.makeTempDir();
  const mountRoot = await Deno.makeTempDir();

  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        [
          "--workspace",
          workspace,
          "--host-mount",
          `name=bad name,source=${mountRoot},target=/data`,
          "--prompt",
          "hi",
        ],
        { cwd: workspace, env: {} },
      ),
    Error,
    "--host-mount name must start",
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

Deno.test("buildCfHarnessOperatorSystemPrompt includes host mount guidance", () => {
  const prompt = buildCfHarnessOperatorSystemPrompt({
    workspace: "/tmp/project",
    systemPrompt: undefined,
    hostMounts: [{
      name: "file-cabinet",
      hostPath: "/host/File Cabinet",
      sandboxPath: "/file-cabinet",
      mode: "writable",
    }],
  });

  assertEquals(
    prompt.includes("/file-cabinet: writable (file-cabinet)"),
    true,
  );
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

Deno.test("runCfHarnessCli threads host-mount into engine additionalMounts", async () => {
  const workspace = await Deno.makeTempDir();
  const mountRoot = await Deno.makeTempDir();
  const { io, stderr } = createIoBuffers();
  let createdOptions: Record<string, unknown> | undefined;
  let runPromptOptions: RunHarnessPromptOptions | undefined;
  const exitCode = await runCfHarnessCli(
    [
      "--workspace",
      workspace,
      "--prompt",
      "Browse mounted files",
      "--host-mount",
      `name=file-cabinet,source=${mountRoot},target=/file-cabinet,mode=writable`,
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
                  { role: "user", content: "Browse mounted files" },
                  { role: "assistant", content: "Done." },
                ],
                modelTurns: 1,
                runState: {
                  runId: "run-host-mount",
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
  assertEquals(mounts?.[1], {
    kind: "host-bind",
    name: "file-cabinet",
    hostPath: await Deno.realPath(mountRoot),
    sandboxPath: "/file-cabinet",
    readOnly: false,
    mode: "writable",
  });
  assertEquals(
    runPromptOptions?.systemPrompt?.includes(
      "/file-cabinet: writable (file-cabinet)",
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

Deno.test("parseCfHarnessCliArgs selects openai-codex without an API key", async () => {
  const parsed = await parseCfHarnessCliArgs(
    ["--model-provider", "openai-codex", "--prompt", "hello"],
    { cwd: "/tmp/project", env: {} },
  );
  if ("help" in parsed) throw new Error("expected config result");
  assertEquals(parsed.modelProvider, "openai-codex");
  assertEquals(parsed.apiKey, undefined);
});

Deno.test("parseCfHarnessCliArgs rejects gateway configuration for openai-codex", async () => {
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        [
          "--model-provider",
          "openai-codex",
          "--gateway-base-url",
          "https://example.invalid",
          "--prompt",
          "hello",
        ],
        { cwd: "/tmp/project", env: {} },
      ),
    Error,
    "gateway URL/auth options cannot be used",
  );
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        ["--model-provider", "openai-codex", "--prompt", "hello"],
        {
          cwd: "/tmp/project",
          env: { CF_HARNESS_GATEWAY_AUTH_MODE: "none" },
        },
      ),
    Error,
    "gateway URL/auth options cannot be used",
  );
});

Deno.test("runCfHarnessCli injects the Codex model client into the shared loop", async () => {
  const { io, stderr } = createIoBuffers();
  const client: HarnessModelClient = {
    providerId: "openai-codex",
    complete: () => Promise.reject(new Error("unused fake model client")),
  };
  let loopModelClient: HarnessModelClient | undefined;
  const exitCode = await runCfHarnessCli(
    ["--model-provider", "openai-codex", "--prompt", "hello"],
    {
      io,
      cwd: "/tmp/project",
      env: {},
      createModelClient: (options) => {
        assertEquals(options, {
          provider: "openai-codex",
          credentialOwnerKey: "local",
          credentialOwner: {
            type: "cf-harness.credential-owner-ref",
            version: 1,
            ownerKey: "local",
          },
          loom: false,
        });
        return client;
      },
      createPromptLoop: (options) => {
        loopModelClient = options.modelClient;
        return {
          runPrompt: () => Promise.resolve(completedCliResult("run-codex")),
          runTranscript: () => Promise.reject(new Error("unexpected resume")),
        };
      },
    },
  );

  assertEquals(exitCode, 0);
  assertEquals(stderr, []);
  assertEquals(loopModelClient, client);
});

Deno.test("Loom Codex invocation requires an authenticated owner reference", async () => {
  const { io, stderr } = createIoBuffers();
  let modelClients = 0;
  const exitCode = await runCfHarnessCli(
    [
      "--run-manifest",
      "/tmp/loom.json",
      "--prompt",
      "hello",
    ],
    {
      io,
      cwd: "/tmp/project",
      env: {},
      readTextFile: () =>
        Promise.resolve(JSON.stringify({
          type: "cf-harness.loom-run-manifest",
          version: 1,
          source: "loom",
          modelProvider: "openai-codex",
        })),
      createModelClient: () => {
        modelClients += 1;
        throw new Error("must not resolve credentials");
      },
    },
  );

  assertEquals(exitCode, 1);
  assertEquals(modelClients, 0);
  assertEquals(stderr, [
    "Loom openai-codex runs require an authenticated credential owner reference\n",
  ]);
});

Deno.test("Loom Codex invocation preserves two users' owner bindings", async () => {
  const owners: string[] = [];
  for (const ownerKey of ["loom:user-a", "loom:user-b"]) {
    const { io, stderr } = createIoBuffers();
    const exitCode = await runCfHarnessCli(
      ["--run-manifest", `/tmp/${ownerKey}.json`, "--prompt", "hello"],
      {
        io,
        cwd: "/tmp/project",
        env: {},
        readTextFile: () =>
          Promise.resolve(JSON.stringify({
            type: "cf-harness.loom-run-manifest",
            version: 1,
            source: "loom",
            modelProvider: "openai-codex",
            credentialOwner: {
              type: "cf-harness.credential-owner-ref",
              version: 1,
              ownerKey,
            },
          })),
        createModelClient: (options) => {
          assertEquals(options.loom, true);
          owners.push(options.credentialOwnerKey);
          return {
            providerId: "openai-codex",
            credentialOwner: options.credentialOwner,
            complete: () => Promise.reject(new Error("unused")),
          };
        },
        createPromptLoop: () => ({
          runPrompt: () =>
            Promise.resolve(completedCliResult(`run-${ownerKey}`)),
          runTranscript: () => Promise.reject(new Error("unexpected resume")),
        }),
      },
    );
    assertEquals(exitCode, 0);
    assertEquals(stderr, []);
  }
  assertEquals(owners, ["loom:user-a", "loom:user-b"]);
});

Deno.test("Loom Codex client injection preserves the authenticated tenant binding", async () => {
  const { io, stderr } = createIoBuffers();
  const exitCode = await runCfHarnessCli(
    ["--run-manifest", "/tmp/loom-tenant.json", "--prompt", "hello"],
    {
      io,
      cwd: "/tmp/project",
      env: {},
      readTextFile: () =>
        Promise.resolve(JSON.stringify({
          type: "cf-harness.loom-run-manifest",
          version: 1,
          source: "loom",
          modelProvider: "openai-codex",
          credentialOwner: {
            type: "cf-harness.credential-owner-ref",
            version: 1,
            ownerKey: "shared-user-key",
            tenantKey: "tenant-a",
          },
        })),
      createModelClient: (options) => {
        assertEquals(options.credentialOwner, {
          type: "cf-harness.credential-owner-ref",
          version: 1,
          ownerKey: "shared-user-key",
          tenantKey: "tenant-a",
        });
        return {
          providerId: "openai-codex",
          credentialOwner: options.credentialOwner,
          complete: () => Promise.reject(new Error("unused")),
        };
      },
      createPromptLoop: () => ({
        runPrompt: () => Promise.resolve(completedCliResult("run-tenant")),
        runTranscript: () => Promise.reject(new Error("unexpected resume")),
      }),
    },
  );

  assertEquals(exitCode, 0);
  assertEquals(stderr, []);
});

Deno.test("local auth status and logout are provider-scoped and secret-free", async () => {
  const store = new InMemoryHarnessCredentialStore();
  await store.set("local", "openai-codex", {
    type: "oauth",
    providerId: "openai-codex",
    accessToken: "access-do-not-print",
    refreshToken: "refresh-do-not-print",
    expiresAt: 4_000_000_000_000,
    accountId: "account-do-not-print",
  });
  const statusIo = createIoBuffers();
  assertEquals(
    await runCfHarnessCli(["auth", "status", "openai-codex"], {
      io: statusIo.io,
      env: {},
      credentialStore: store,
    }),
    0,
  );
  assertEquals(statusIo.stdout, ["openai-codex: connected (ready)\n"]);
  assertEquals(JSON.stringify(statusIo).includes("do-not-print"), false);

  const logoutIo = createIoBuffers();
  assertEquals(
    await runCfHarnessCli(["auth", "logout", "openai-codex"], {
      io: logoutIo.io,
      env: {},
      credentialStore: store,
    }),
    0,
  );
  assertEquals(await store.get("local", "openai-codex"), undefined);
});

Deno.test("models openai-codex reports live provider order", async () => {
  const { io, stdout, stderr } = createIoBuffers();
  const exitCode = await runCfHarnessCli(["models", "openai-codex"], {
    io,
    cwd: "/tmp/project",
    env: {},
    createModelClient: () => ({
      providerId: "openai-codex",
      complete: () => Promise.reject(new Error("unused")),
      listModels: () =>
        Promise.resolve([{
          id: "model-b",
          displayName: "Model B",
          inputModalities: ["text"],
          supportedReasoningEfforts: ["high"],
          supportsParallelToolCalls: true,
        }, {
          id: "model-a",
          displayName: "Model A",
          inputModalities: ["text"],
          supportedReasoningEfforts: [],
          supportsParallelToolCalls: false,
        }]),
    }),
  });

  assertEquals(exitCode, 0);
  assertEquals(stderr, []);
  assertEquals(JSON.parse(stdout[0]).map((model: { id: string }) => model.id), [
    "model-b",
    "model-a",
  ]);
});

Deno.test("resume preserves the recorded Codex provider and continuation", async () => {
  const transcript = [{ role: "user" as const, content: "Continue" }, {
    role: "assistant" as const,
    content: "Working",
    providerContinuation: {
      providerId: "openai-codex",
      state: { responseId: "resp-retained", output: [] },
    },
  }];
  const readRunArtifacts = () =>
    Promise.resolve({
      runRoot: "/tmp/project/.cf-harness-artifacts/run-codex-resume",
      runStatePath:
        "/tmp/project/.cf-harness-artifacts/run-codex-resume/run-state.json",
      transcriptPath:
        "/tmp/project/.cf-harness-artifacts/run-codex-resume/transcript.json",
      runState: {
        runId: "run-codex-resume",
        status: "failed" as const,
        createdAt: "2026-07-22T12:00:00.000Z",
        updatedAt: "2026-07-22T12:00:01.000Z",
        cfcEnforcementMode: "disabled" as const,
        currentDir: "/workspace",
        model: "gpt-5.4",
        modelProvider: "openai-codex" as const,
        credentialOwnerKey: "local",
        policyEvents: [],
        toolOutputs: [],
      },
      transcript,
    });
  const { io, stderr } = createIoBuffers();
  let resumedTranscript: readonly unknown[] | undefined;
  const exitCode = await runCfHarnessCli(
    ["--resume-run", "/tmp/project/.cf-harness-artifacts/run-codex-resume"],
    {
      io,
      cwd: "/tmp/project",
      env: {},
      readRunArtifacts,
      createModelClient: (options) => {
        assertEquals(options.provider, "openai-codex");
        assertEquals(options.credentialOwnerKey, "local");
        return {
          providerId: "openai-codex",
          complete: () => Promise.reject(new Error("unused")),
        };
      },
      createPromptLoop: () => ({
        runPrompt: () => Promise.reject(new Error("unexpected prompt")),
        runTranscript: (options) => {
          resumedTranscript = options.transcript;
          return Promise.resolve(completedCliResult("run-codex-resume"));
        },
      }),
    },
  );

  assertEquals(exitCode, 0);
  assertEquals(stderr, []);
  assertEquals(resumedTranscript, transcript);

  const mismatchIo = createIoBuffers();
  assertEquals(
    await runCfHarnessCli([
      "--resume-run",
      "/tmp/project/.cf-harness-artifacts/run-codex-resume",
      "--model-provider",
      "openai-compatible-gateway",
    ], {
      io: mismatchIo.io,
      cwd: "/tmp/project",
      env: { CF_HARNESS_API_KEY: "gateway-key" },
      readRunArtifacts,
    }),
    1,
  );
  assertEquals(mismatchIo.stderr, [
    "resume provider mismatch: run uses openai-codex, requested openai-compatible-gateway\n",
  ]);
});

Deno.test("resume rejects manifest provider and credential-owner switches", async () => {
  const recordedOwner = {
    type: "cf-harness.credential-owner-ref" as const,
    version: 1 as const,
    ownerKey: "shared-user-key",
    tenantKey: "tenant-a",
  };
  const readRunArtifacts = () =>
    Promise.resolve({
      runRoot: "/tmp/run",
      runStatePath: "/tmp/run/run-state.json",
      transcriptPath: "/tmp/run/transcript.json",
      runState: {
        runId: "run-loom-resume",
        status: "failed" as const,
        createdAt: "2026-07-22T12:00:00.000Z",
        updatedAt: "2026-07-22T12:00:01.000Z",
        cfcEnforcementMode: "disabled" as const,
        currentDir: "/workspace",
        model: "gpt-5.4",
        modelProvider: "openai-codex" as const,
        credentialOwnerKey: recordedOwner.ownerKey,
        runManifest: {
          type: "cf-harness.loom-run-manifest" as const,
          version: 1 as const,
          source: "loom" as const,
          modelProvider: "openai-codex" as const,
          credentialOwner: recordedOwner,
        },
        policyEvents: [],
        toolOutputs: [],
      },
      transcript: [{ role: "user" as const, content: "Continue" }],
    });
  const run = async (manifest: Record<string, unknown>) => {
    const buffers = createIoBuffers();
    const exitCode = await runCfHarnessCli(
      ["--resume-run", "/tmp/run", "--run-manifest", "/tmp/resume.json"],
      {
        io: buffers.io,
        cwd: "/tmp/project",
        env: {},
        readRunArtifacts,
        readTextFile: () => Promise.resolve(JSON.stringify(manifest)),
      },
    );
    return { exitCode, stderr: buffers.stderr };
  };

  const providerSwitch = await run({
    type: "cf-harness.loom-run-manifest",
    version: 1,
    source: "loom",
    modelProvider: "openai-compatible-gateway",
    credentialOwner: recordedOwner,
  });
  assertEquals(providerSwitch.exitCode, 1);
  assertEquals(providerSwitch.stderr, [
    "resume provider mismatch: run uses openai-codex, requested openai-compatible-gateway\n",
  ]);

  const ownerSwitch = await run({
    type: "cf-harness.loom-run-manifest",
    version: 1,
    source: "loom",
    modelProvider: "openai-codex",
    credentialOwner: { ...recordedOwner, tenantKey: "tenant-b" },
  });
  assertEquals(ownerSwitch.exitCode, 1);
  assertEquals(ownerSwitch.stderr, [
    "resume credential owner mismatch: requested owner does not match the recorded run\n",
  ]);
});
