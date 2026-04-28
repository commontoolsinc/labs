import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { CfcEnforcementMode, IFCLabel } from "@commonfabric/runner/cfc";
import { CfHarnessEngine } from "../src/engine.ts";
import { CfHarnessPromptLoop } from "../src/prompt-loop.ts";
import {
  CFC_RESULT_DIR_ENV,
  DEFAULT_DOCKER_RUNSC_IMAGE,
  resolveDockerRunscSandboxConfig,
} from "../src/sandbox/docker-runsc.ts";
import type {
  ReadFileToolOutput,
  ReadFileToolSuccessOutput,
} from "../src/tools/read-file.ts";

const INTEGRATION = Deno.env.get("CF_HARNESS_INTEGRATION") === "1";
const DOCKER_RUNTIME = Deno.env.get("CF_HARNESS_INTEGRATION_RUNTIME") ??
  "runsc-cfc";
const DOCKER_IMAGE = Deno.env.get("CF_HARNESS_INTEGRATION_IMAGE") ??
  DEFAULT_DOCKER_RUNSC_IMAGE;
const CFC_TAINT_IMAGE = Deno.env.get("CF_HARNESS_INTEGRATION_TAINT_IMAGE") ??
  "alpine:3.20";
const CFC_RESULT_DIR_CONFIGURED =
  (Deno.env.get(CFC_RESULT_DIR_ENV) ?? "").length > 0;
const TAINTED_SECRET = '{"secret":"tainted from policy"}\n';

interface WithHarnessOptions {
  cfcEnforcementMode?: CfcEnforcementMode;
  configureSandbox?: (
    workspaceHostPath: string,
  ) => Partial<Parameters<typeof resolveDockerRunscSandboxConfig>[0]>;
}

function assertReadFileSuccess(
  output: ReadFileToolOutput,
): asserts output is ReadFileToolSuccessOutput {
  if (!("content" in output)) {
    throw new Error(`read_file failed: ${JSON.stringify(output)}`);
  }
}

const assertRunscRuntimeAvailable = async () => {
  const result = await new Deno.Command("docker", {
    args: ["info", "--format", "{{json .Runtimes}}"],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  if (!result.success) {
    throw new Error(`docker info failed: ${stderr || stdout}`);
  }
  assertStringIncludes(stdout, `"${DOCKER_RUNTIME}"`);
};

const assertCfcPolicyLabelsAvailable = async () => {
  const policy = JSON.parse(
    await Deno.readTextFile("/etc/gvisor/cfc-policy.json"),
  ) as { path_labels?: Array<{ pattern?: unknown }> };
  const patterns = new Set(
    (policy.path_labels ?? [])
      .map((entry) => entry.pattern)
      .filter((pattern): pattern is string => typeof pattern === "string"),
  );
  for (const required of ["/secrets/*.json", "/data/alice/*"]) {
    assert(
      patterns.has(required),
      `/etc/gvisor/cfc-policy.json is missing path label ${required}`,
    );
  }
};

const assertConfidentialityTaint = (label: IFCLabel) => {
  assert(
    Array.isArray(label.confidentiality) &&
      label.confidentiality.length > 0,
    `expected a non-empty confidentiality label, got ${JSON.stringify(label)}`,
  );
};

const writePolicyLabeledSecret = async (secretsHostPath: string) => {
  await Deno.mkdir(secretsHostPath, { recursive: true });
  await Deno.writeTextFile(`${secretsHostPath}/space.json`, TAINTED_SECRET);
};

const withHarness = async (
  runId: string,
  fn: (engine: CfHarnessEngine, hostPath: string) => Promise<void>,
  options: WithHarnessOptions = {},
) => {
  const tempDir = await Deno.makeTempDir({
    prefix: "cf-harness-int-",
    dir: "/tmp",
  });
  const workspaceHostPath = await Deno.realPath(tempDir);
  try {
    await assertRunscRuntimeAvailable();
    const engine = new CfHarnessEngine({
      runId,
      ...(options.cfcEnforcementMode !== undefined
        ? { cfcEnforcementMode: options.cfcEnforcementMode }
        : {}),
      sandbox: resolveDockerRunscSandboxConfig({
        workspaceHostPath,
        runtimeName: DOCKER_RUNTIME,
        image: DOCKER_IMAGE,
        ...options.configureSandbox?.(workspaceHostPath),
      }),
    });
    await fn(engine, workspaceHostPath);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
};

Deno.test({
  name: "cf-harness integration: bash smoke test through runsc-cfc",
  ignore: !INTEGRATION,
  permissions: { env: true, read: true, run: true, write: true },
  async fn() {
    await withHarness("integration-bash", async (engine) => {
      const result = await engine.invokeBuiltinTool("bash", {
        command: "pwd",
      });
      assertEquals(result.output.stdout, "/workspace\n");
      assertEquals(result.runState.status, "completed");
      assertEquals(result.runState.toolOutputs.length, 1);
    });
  },
});

Deno.test({
  name:
    "cf-harness integration: policy-labeled read produces opaque runsc CFC result",
  ignore: !INTEGRATION || !CFC_RESULT_DIR_CONFIGURED,
  permissions: { env: true, read: true, run: true, write: true },
  async fn() {
    await assertCfcPolicyLabelsAvailable();
    const secretsHostPath = await Deno.makeTempDir({
      prefix: "cf-harness-secrets-",
      dir: "/tmp",
    });
    try {
      await writePolicyLabeledSecret(secretsHostPath);
      await withHarness(
        "integration-tainted-sidecar",
        async (engine) => {
          const result = await engine.invokeBuiltinTool("bash", {
            command: "cat /secrets/space.json",
          });

          assertStringIncludes(result.output.stdout, TAINTED_SECRET.trim());
          assert(result.output.cfcResult !== undefined);
          assertEquals(result.output.cfcResult.stdout.policy, "opaque");
          assertEquals(result.output.cfcResult.stderr.policy, "opaque");
          assertEquals(result.output.cfcResult.exitCode.policy, "opaque");
          assertConfidentialityTaint(result.output.cfcResult.stdout.label);
          assertStringIncludes(
            result.output.cfcResult.diagnostics?.[0]?.details?.runscTaint as
              | string
              | undefined ?? "",
            "did:key:alice",
          );
        },
        {
          configureSandbox: () => ({
            image: CFC_TAINT_IMAGE,
            extraDockerArgs: [
              "--mount",
              `type=bind,src=${secretsHostPath},dst=/secrets,readonly`,
            ],
          }),
        },
      );
    } finally {
      await Deno.remove(secretsHostPath, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "cf-harness integration: prompt loop withholds tainted bash stdout from model",
  ignore: !INTEGRATION || !CFC_RESULT_DIR_CONFIGURED,
  permissions: { env: true, read: true, run: true, write: true },
  async fn() {
    await assertCfcPolicyLabelsAvailable();
    const secretsHostPath = await Deno.makeTempDir({
      prefix: "cf-harness-secrets-",
      dir: "/tmp",
    });
    try {
      await writePolicyLabeledSecret(secretsHostPath);
      await withHarness(
        "integration-tainted-prompt-loop",
        async (engine) => {
          const requests: Array<{
            messages: Array<{ role: string; content: string }>;
          }> = [];
          const loop = new CfHarnessPromptLoop({
            apiKey: "test-key",
            engine,
            maxModelTurns: 2,
            fetchFn: (_input, init) => {
              const request = JSON.parse(String(init?.body ?? "{}")) as {
                messages: Array<{ role: string; content: string }>;
              };
              requests.push(request);
              const payload = requests.length === 1
                ? {
                  choices: [{
                    index: 0,
                    message: {
                      role: "assistant",
                      content: "",
                      tool_calls: [{
                        id: "call-tainted",
                        type: "function",
                        function: {
                          name: "bash",
                          arguments: JSON.stringify({
                            command: "cat /secrets/space.json",
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
                      content: "tainted output was mediated",
                    },
                  }],
                };
              return Promise.resolve(
                new Response(JSON.stringify(payload), { status: 200 }),
              );
            },
          });

          await loop.runPrompt({
            model: "gpt-5.4",
            prompt: "Read the tainted secret.",
            promptSlotBinding: {
              type: "cf-harness.prompt-slot-binding",
              role: "direct-command",
              kernelName: "integration",
              surface: "cli",
            },
          });

          assertEquals(requests.length, 2);
          const secondRequestJson = JSON.stringify(requests[1]);
          assert(
            !secondRequestJson.includes(TAINTED_SECRET.trim()),
            "raw tainted stdout was sent to the model",
          );
          const toolMessage = requests[1].messages.at(-1);
          assertEquals(toolMessage?.role, "tool");
          const toolContent = JSON.parse(toolMessage?.content ?? "{}") as {
            stdout?: { type?: string; reason?: string };
            cfc?: { stdout?: { policy?: string; label?: IFCLabel } };
          };
          assertEquals(
            toolContent.stdout?.type,
            "cf-harness.observation-denied",
          );
          assertEquals(toolContent.stdout?.reason, "needs-opaque-pass-through");
          assertEquals(toolContent.cfc?.stdout?.policy, "opaque");
          assertConfidentialityTaint(toolContent.cfc?.stdout?.label ?? {});
        },
        {
          cfcEnforcementMode: "enforce-strict",
          configureSandbox: () => ({
            image: CFC_TAINT_IMAGE,
            extraDockerArgs: [
              "--mount",
              `type=bind,src=${secretsHostPath},dst=/secrets,readonly`,
            ],
          }),
        },
      );
    } finally {
      await Deno.remove(secretsHostPath, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "cf-harness integration: write_file and read_file roundtrip through runsc-cfc",
  ignore: !INTEGRATION,
  permissions: { env: true, read: true, run: true, write: true },
  async fn() {
    await withHarness("integration-roundtrip", async (engine, hostPath) => {
      const writeResult = await engine.invokeBuiltinTool("write_file", {
        path: "notes/hello.txt",
        content: "hello from cf-harness\n",
        createParents: true,
      });
      assertEquals(writeResult.output.path, "/workspace/notes/hello.txt");

      const readResult = await engine.invokeBuiltinTool("read_file", {
        path: "notes/hello.txt",
      });
      assertReadFileSuccess(readResult.output);
      assertEquals(readResult.output.content, "hello from cf-harness\n");
      const diskContent = await Deno.readTextFile(
        `${hostPath}/notes/hello.txt`,
      );
      assertEquals(diskContent, "hello from cf-harness\n");
    });
  },
});

Deno.test({
  name:
    "cf-harness integration: append mode persists additional content through runsc-cfc",
  ignore: !INTEGRATION,
  permissions: { env: true, read: true, run: true, write: true },
  async fn() {
    await withHarness("integration-append", async (engine, hostPath) => {
      await engine.invokeBuiltinTool("write_file", {
        path: "notes/log.txt",
        content: "line one\n",
        createParents: true,
      });
      await engine.invokeBuiltinTool("write_file", {
        path: "notes/log.txt",
        content: "line two\n",
        mode: "append",
      });

      const readResult = await engine.invokeBuiltinTool("read_file", {
        path: "notes/log.txt",
      });
      assertReadFileSuccess(readResult.output);
      assertEquals(readResult.output.content, "line one\nline two\n");
      const diskContent = await Deno.readTextFile(`${hostPath}/notes/log.txt`);
      assertEquals(diskContent, "line one\nline two\n");
    });
  },
});
