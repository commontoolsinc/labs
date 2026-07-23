import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import type {
  CfcEnforcementMode,
  CfcLabelView,
  IFCLabel,
} from "@commonfabric/runner/cfc";
import { CfHarnessEngine } from "../src/engine.ts";
import { CfHarnessPromptLoop } from "../src/prompt-loop.ts";
import {
  readHarnessRunState,
  readHarnessTranscript,
} from "../src/artifacts.ts";
import {
  CFC_INVOCATION_CONTEXT_DIR_ENV,
  CFC_RESULT_DIR_ENV,
  DEFAULT_DOCKER_RUNSC_IMAGE,
  resolveDockerRunscSandboxConfig,
} from "../src/sandbox/docker-runsc.ts";
import { CFC_PROMPT_SLOT_BOUND_ATOM_TYPE } from "../src/contracts/prompt-slot.ts";
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
const CFC_INVOCATION_CONTEXT_DIR_CONFIGURED =
  (Deno.env.get(CFC_INVOCATION_CONTEXT_DIR_ENV) ?? "").length > 0;
const TAINTED_SECRET = '{"secret":"tainted from policy"}\n';
const INVOCATION_TAINT_SUBJECT = "did:key:argv-reader";
const FABRIC_MOUNT = Deno.env.get("CF_HARNESS_INTEGRATION_FABRIC_MOUNT");
const FABRIC_INTEGRATION = INTEGRATION &&
  FABRIC_MOUNT !== undefined &&
  FABRIC_MOUNT.trim() !== "";
const FABRIC_CFC_FLOW_INTEGRATION = FABRIC_INTEGRATION &&
  Deno.env.get("CF_HARNESS_INTEGRATION_FABRIC_CFC_FLOW") === "1";
const FABRIC_CFC_DURABLE_HOST_LABEL_INTEGRATION = FABRIC_CFC_FLOW_INTEGRATION &&
  Deno.env.get("CF_HARNESS_INTEGRATION_FABRIC_CFC_DURABLE_HOST_LABEL") === "1";
const FABRIC_CFC_READ_PATH = Deno.env.get(
  "CF_HARNESS_INTEGRATION_FABRIC_CFC_READ_PATH",
);
const FABRIC_CFC_WRITE_PATH = Deno.env.get(
  "CF_HARNESS_INTEGRATION_FABRIC_CFC_WRITE_PATH",
);
const FABRIC_CFC_LABEL_SUBJECT =
  Deno.env.get("CF_HARNESS_INTEGRATION_FABRIC_CFC_LABEL_SUBJECT")?.trim() ||
  "did:key:fabric";
const CF_CLI_INTEGRATION = INTEGRATION &&
  Deno.env.get("CF_HARNESS_INTEGRATION_CF_CLI") === "1";
const LABS_ROOT_URL = new URL("../../..", import.meta.url);

const defaultCfcPolicyFile = (): string => {
  const home = Deno.env.get("HOME");
  if (Deno.build.os === "darwin" && home !== undefined && home.length > 0) {
    return `${home}/.local/share/runsc-cfc/cfc-policy.json`;
  }
  return "/etc/gvisor/cfc-policy.json";
};

const CFC_POLICY_FILE =
  Deno.env.get("CF_HARNESS_INTEGRATION_CFC_POLICY_FILE") ??
    Deno.env.get("CFC_POLICY_FILE") ?? defaultCfcPolicyFile();

const integrationTempRoot = async (): Promise<string> => {
  const home = Deno.env.get("HOME");
  if (Deno.build.os !== "darwin" || home === undefined || home.length === 0) {
    return "/tmp";
  }
  const root = `${home}/.cache/cf-harness/integration`;
  await Deno.mkdir(root, { recursive: true });
  return root;
};

const makeIntegrationTempDir = async (prefix: string): Promise<string> =>
  Deno.makeTempDir({
    prefix,
    dir: await integrationTempRoot(),
  });

const labsRootPath = (): Promise<string> =>
  Deno.realPath(fromFileUrl(LABS_ROOT_URL));

interface WithHarnessOptions {
  cfcEnforcementMode?: CfcEnforcementMode;
  artifactRoot?: string;
  model?: string;
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
    await Deno.readTextFile(CFC_POLICY_FILE),
  ) as { path_labels?: Array<{ pattern?: unknown }> };
  const patterns = new Set(
    (policy.path_labels ?? [])
      .map((entry) => entry.pattern)
      .filter((pattern): pattern is string => typeof pattern === "string"),
  );
  for (const required of ["/secrets/*.json", "/data/alice/*"]) {
    assert(
      patterns.has(required),
      `${CFC_POLICY_FILE} is missing path label ${required}`,
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

const assertLabelIncludesSubject = (label: IFCLabel, subject: string) => {
  assertConfidentialityTaint(label);
  assertStringIncludes(JSON.stringify(label.confidentiality), subject);
};

const requireSandboxFabricPath = (
  path: string | undefined,
  envName: string,
): string => {
  const trimmed = path?.trim() ?? "";
  if (trimmed === "") {
    throw new Error(`${envName} is required for Fabric CFC flow tests`);
  }
  const segments = trimmed.slice(1).split("/");
  if (
    !trimmed.startsWith("/fabric/") ||
    segments.some((segment) =>
      segment === "" || segment === "." ||
      segment === ".."
    )
  ) {
    throw new Error(
      `${envName} must be a concrete absolute sandbox path under /fabric without . or .. segments`,
    );
  }
  return trimmed;
};

const singleQuoteShell = (value: string): string =>
  `'${value.replaceAll("'", `'"'"'`)}'`;

const fabricParentDirectories = (path: string): string[] => {
  const parts = path.slice(1).split("/");
  const dirs: string[] = [];
  for (let index = 0; index < parts.length - 1; index++) {
    dirs.push(`/${parts.slice(0, index + 1).join("/")}`);
  }
  return dirs;
};

const warmFabricParentDirectories = (path: string): string[] =>
  fabricParentDirectories(path).flatMap((dir) => {
    const quoted = singleQuoteShell(dir);
    return [
      `for _ in 1 2 3 4 5; do ls -ld ${quoted} >/dev/null 2>&1 && break; sleep 0.1; done`,
      `ls -ld ${quoted} >/dev/null`,
    ];
  });

const warmFabricParents = async (
  engine: CfHarnessEngine,
  path: string,
): Promise<void> => {
  const commands = warmFabricParentDirectories(path);
  if (commands.length === 0) return;
  const result = await engine.invokeBuiltinTool("bash", {
    command: ["set -eu", ...commands].join("\n"),
  });
  assertEquals(result.output.exitCode, 0);
};

const fabricHostPathForSandboxPath = (
  fabricHostPath: string,
  sandboxPath: string,
): string =>
  join(fabricHostPath, ...sandboxPath.slice("/fabric/".length).split("/"));

type BoundedCommandStatus =
  | { kind: "completed"; status: Deno.CommandStatus }
  | { kind: "timed-out"; killError?: string };

const commandStatusWithTimeout = async (
  command: Deno.Command,
  timeoutMs: number,
): Promise<BoundedCommandStatus> => {
  const child = command.spawn();
  const statusPromise = child.status;
  let timeoutId: number | undefined;
  const timeoutPromise = new Promise<"timed-out">((resolve) => {
    timeoutId = setTimeout(() => resolve("timed-out"), timeoutMs);
  });
  const result = await Promise.race([statusPromise, timeoutPromise]);
  if (timeoutId !== undefined) clearTimeout(timeoutId);
  if (result !== "timed-out") return { kind: "completed", status: result };

  const describeError = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);
  const appendError = (
    existing: string | undefined,
    label: string,
    error: unknown,
  ): string => {
    const message = `${label}: ${describeError(error)}`;
    return existing === undefined ? message : `${existing}; ${message}`;
  };

  let killError: string | undefined;
  try {
    child.kill("SIGKILL");
  } catch (error) {
    killError = appendError(killError, "SIGKILL failed", error);
  }

  let cleanupTimeoutId: number | undefined;
  const cleanupTimeoutPromise = new Promise<"cleanup-timed-out">((resolve) => {
    cleanupTimeoutId = setTimeout(() => resolve("cleanup-timed-out"), 1_000);
  });
  const cleanupResult = await Promise.race([
    statusPromise.then(() => "closed" as const).catch((error) => ({
      kind: "status-error" as const,
      message: describeError(error),
    })),
    cleanupTimeoutPromise,
  ]);
  if (cleanupTimeoutId !== undefined) clearTimeout(cleanupTimeoutId);

  if (cleanupResult === "cleanup-timed-out") {
    child.unref();
  } else if (cleanupResult !== "closed") {
    killError = killError === undefined
      ? `child status failed after timeout: ${cleanupResult.message}`
      : `${killError}; child status failed after timeout: ${cleanupResult.message}`;
  }

  return killError === undefined
    ? { kind: "timed-out" }
    : { kind: "timed-out", killError };
};

const waitForFabricHostCfcSubject = async (
  fabricHostPath: string,
  sandboxPath: string,
  subject: string,
): Promise<void> => {
  const hostPath = fabricHostPathForSandboxPath(fabricHostPath, sandboxPath);
  const lastValuePath = await Deno.makeTempFile({
    prefix: "cf-harness-cfc-xattr-",
    suffix: ".txt",
  });
  const script = [
    "import os, sys, time",
    "path, subject, last_value_path = sys.argv[1:4]",
    "last = ''",
    "def record(value):",
    "    with open(last_value_path, 'w', encoding='utf-8') as out:",
    "        out.write(value)",
    "for _ in range(50):",
    "    try:",
    "        last = os.getxattr(path, 'user.commonfabric.cfc.contentLabel').decode()",
    "    except OSError as exc:",
    "        last = f'{type(exc).__name__}: {exc}'",
    "    if subject in last:",
    "        record(last)",
    "        raise SystemExit(0)",
    "    time.sleep(0.1)",
    "record(last)",
    "raise SystemExit(1)",
  ].join("\n");
  try {
    const result = await commandStatusWithTimeout(
      new Deno.Command("python3", {
        args: ["-c", script, hostPath, subject, lastValuePath],
        stdout: "null",
        stderr: "null",
      }),
      10_000,
    );
    if (result.kind === "timed-out") {
      throw new Error(
        `timed out waiting for host CFC xattr subprocess for ${hostPath}; ` +
          `getxattr may be blocked by the live FUSE mount${
            result.killError === undefined ? "" : `; ${result.killError}`
          }`,
      );
    }
    if (!result.status.success) {
      let lastValue = "";
      try {
        lastValue = (await Deno.readTextFile(lastValuePath)).trim();
      } catch (error) {
        lastValue = error instanceof Error ? error.message : String(error);
      }
      throw new Error(
        `timed out waiting for ${subject} in CFC xattr for ${hostPath}: ${lastValue}`,
      );
    }
  } finally {
    await Deno.remove(lastValuePath).catch((error) => {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    });
  }
};

Deno.test({
  name:
    "cf-harness integration helper: command timeout returns before child exits",
  permissions: { run: true },
  async fn() {
    const result = await commandStatusWithTimeout(
      new Deno.Command(
        Deno.execPath(),
        {
          args: ["eval", "await new Promise(() => {})"],
          stdout: "null",
          stderr: "null",
        },
      ),
      20,
    );
    assertEquals(result.kind, "timed-out");
  },
});

const invocationInputLabels = (): CfcLabelView => ({
  version: 1,
  entries: [{
    path: ["argv"],
    label: {
      confidentiality: [{
        type: "test.cfc/User",
        subject: INVOCATION_TAINT_SUBJECT,
      }],
    },
  }],
});

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
    dir: await integrationTempRoot(),
  });
  const workspaceHostPath = await Deno.realPath(tempDir);
  try {
    await assertRunscRuntimeAvailable();
    const engine = new CfHarnessEngine({
      runId,
      ...(options.artifactRoot !== undefined
        ? { artifactRoot: options.artifactRoot }
        : {}),
      ...(options.cfcEnforcementMode !== undefined
        ? { cfcEnforcementMode: options.cfcEnforcementMode }
        : {}),
      ...(options.model !== undefined ? { model: options.model } : {}),
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

const requireFabricMount = async (): Promise<string> => {
  if (FABRIC_MOUNT === undefined || FABRIC_MOUNT.trim() === "") {
    throw new Error(
      "CF_HARNESS_INTEGRATION_FABRIC_MOUNT is required for Fabric mount integration tests",
    );
  }
  const realPath = await Deno.realPath(FABRIC_MOUNT);
  const stat = await Deno.stat(realPath);
  if (!stat.isDirectory) {
    throw new Error(
      `CF_HARNESS_INTEGRATION_FABRIC_MOUNT must be a directory: ${realPath}`,
    );
  }
  return realPath;
};

const withFabricHarness = async (
  runId: string,
  fn: (
    engine: CfHarnessEngine,
    workspaceHostPath: string,
    fabricHostPath: string,
  ) => Promise<void>,
) => {
  const fabricHostPath = await requireFabricMount();
  const tempDir = await makeIntegrationTempDir("cf-harness-int-");
  const workspaceHostPath = await Deno.realPath(tempDir);
  try {
    await assertRunscRuntimeAvailable();
    const engine = new CfHarnessEngine({
      runId,
      sandbox: resolveDockerRunscSandboxConfig({
        workspaceHostPath,
        runtimeName: DOCKER_RUNTIME,
        image: DOCKER_IMAGE,
        additionalMounts: [{
          kind: "fabric-fuse",
          hostPath: fabricHostPath,
        }],
      }),
    });
    await fn(engine, workspaceHostPath, fabricHostPath);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
};

Deno.test({
  name: "cf-harness integration: bash smoke test through runsc-cfc",
  ignore: !INTEGRATION,
  permissions: { env: true, read: true, run: true, write: true },
  async fn() {
    await withHarness(
      "integration-bash",
      async (engine) => {
        const result = await engine.invokeBuiltinTool("bash", {
          command: "pwd",
        });
        assertEquals(result.output.stdout, "/workspace\n");
        assertEquals(result.output.cwd, "/workspace");
        assertEquals(result.runState.status, "completed");
        assertEquals(result.runState.toolOutputs.length, 1);
      },
      { cfcEnforcementMode: "observe" },
    );
  },
});

Deno.test({
  name:
    "cf-harness integration: a real sandbox path-escape is a tool result, not a run-fatal error",
  ignore: !INTEGRATION,
  permissions: { env: true, read: true, run: true, write: true },
  async fn() {
    await withHarness(
      "integration-tool-error-recovery",
      async (engine) => {
        const requests: Array<{
          messages: Array<{ role: string; content: string }>;
        }> = [];
        const loop = new CfHarnessPromptLoop({
          apiKey: "test-key",
          engine,
          maxModelTurns: 3,
          fetchFn: (_input, init) => {
            const request = JSON.parse(String(init?.body ?? "{}")) as {
              messages: Array<{ role: string; content: string }>;
            };
            requests.push(request);
            // Turn 1: the model tries to `ls` the container root. cwd "/"
            // escapes the sandbox roots, so the real DockerRunscSandbox
            // `resolvePath` throws — the exact D9 scenario that used to kill
            // the whole run on turn 1.
            const payload = requests.length === 1
              ? {
                choices: [{
                  index: 0,
                  message: {
                    role: "assistant",
                    content: "",
                    tool_calls: [{
                      id: "call-escape",
                      type: "function",
                      function: {
                        name: "bash",
                        arguments: JSON.stringify({ command: "ls", cwd: "/" }),
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
                    content: "recovered after the sandbox rejected the path",
                  },
                }],
              };
            return Promise.resolve(
              new Response(JSON.stringify(payload), { status: 200 }),
            );
          },
        });

        const result = await loop.runPrompt({
          model: "gpt-5.4",
          prompt: "List the container root.",
        });

        // The run completed instead of dying on the path-escape throw.
        assertEquals(result.runState.status, "completed");
        assertEquals(
          result.finalAssistantText,
          "recovered after the sandbox rejected the path",
        );
        // The model got a second turn: the error was fed back as a tool result.
        assertEquals(requests.length, 2);
        const toolMessage = requests[1].messages.at(-1);
        assertEquals(toolMessage?.role, "tool");
        assertStringIncludes(
          toolMessage?.content ?? "",
          "tool_execution_failed",
        );
        assertStringIncludes(toolMessage?.content ?? "", "path escapes");
      },
      { cfcEnforcementMode: "observe" },
    );
  },
});

Deno.test({
  name: "cf-harness integration: local Labs deno task cf help runs in sandbox",
  ignore: !CF_CLI_INTEGRATION,
  permissions: { env: true, read: true, run: true, write: true },
  async fn() {
    await assertRunscRuntimeAvailable();
    const engine = new CfHarnessEngine({
      runId: "integration-cf-cli-help",
      cfcEnforcementMode: "observe",
      sandbox: resolveDockerRunscSandboxConfig({
        workspaceHostPath: await labsRootPath(),
        runtimeName: DOCKER_RUNTIME,
        image: DOCKER_IMAGE,
      }),
    });

    const result = await engine.invokeBuiltinTool("bash", {
      command: "deno task cf --help",
      timeoutMs: 120_000,
    });
    assertEquals(result.output.exitCode, 0);
    assertStringIncludes(result.output.stdout, "Usage:");
    assertStringIncludes(result.output.stdout, "cf");
  },
});

Deno.test({
  name:
    "cf-harness integration: policy-labeled read produces opaque runsc CFC result",
  ignore: !INTEGRATION || !CFC_RESULT_DIR_CONFIGURED,
  permissions: { env: true, read: true, run: true, write: true },
  async fn() {
    await assertCfcPolicyLabelsAvailable();
    const secretsHostPath = await makeIntegrationTempDir(
      "cf-harness-secrets-",
    );
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
    "cf-harness integration: invocation input labels taint host bind output",
  ignore: !INTEGRATION || !CFC_RESULT_DIR_CONFIGURED ||
    !CFC_INVOCATION_CONTEXT_DIR_CONFIGURED,
  permissions: { env: true, read: true, run: true, write: true },
  async fn() {
    await withHarness(
      "integration-input-label-host-bind",
      async (engine, hostPath) => {
        const writeResult = await engine.invokeBuiltinTool("bash", {
          command:
            "printf 'from invocation label\n' > /workspace/input-labeled.txt; printf 'wrote input-labeled file\n'",
          cfcInputLabels: invocationInputLabels(),
        });

        assertEquals(
          await Deno.readTextFile(`${hostPath}/input-labeled.txt`),
          "from invocation label\n",
        );
        assert(writeResult.output.cfcResult !== undefined);
        assertEquals(writeResult.output.cfcResult.stdout.policy, "opaque");
        assertLabelIncludesSubject(
          writeResult.output.cfcResult.stdout.label,
          INVOCATION_TAINT_SUBJECT,
        );

        const readBack = await engine.invokeBuiltinTool("bash", {
          command: "cat /workspace/input-labeled.txt",
        });
        assert(readBack.output.cfcResult !== undefined);
        assertEquals(readBack.output.cfcResult.stdout.policy, "opaque");
        assertLabelIncludesSubject(
          readBack.output.cfcResult.stdout.label,
          INVOCATION_TAINT_SUBJECT,
        );
      },
      { cfcEnforcementMode: "enforce-strict" },
    );
  },
});

Deno.test({
  name:
    "cf-harness integration: invocation labels join policy reads before writes",
  ignore: !INTEGRATION || !CFC_RESULT_DIR_CONFIGURED ||
    !CFC_INVOCATION_CONTEXT_DIR_CONFIGURED,
  permissions: { env: true, read: true, run: true, write: true },
  async fn() {
    await assertCfcPolicyLabelsAvailable();
    const secretsHostPath = await makeIntegrationTempDir(
      "cf-harness-secrets-",
    );
    try {
      await writePolicyLabeledSecret(secretsHostPath);
      await withHarness(
        "integration-input-label-join-host-read",
        async (engine, hostPath) => {
          const joinedWrite = await engine.invokeBuiltinTool("bash", {
            command: [
              "cat /secrets/space.json >/dev/null",
              "printf 'joined taint\n' > /workspace/joined.txt",
              "printf 'joined result\n'",
            ].join("; "),
            cfcInputLabels: invocationInputLabels(),
          });

          assertEquals(
            await Deno.readTextFile(`${hostPath}/joined.txt`),
            "joined taint\n",
          );
          assert(joinedWrite.output.cfcResult !== undefined);
          assertEquals(joinedWrite.output.cfcResult.stdout.policy, "opaque");
          assertLabelIncludesSubject(
            joinedWrite.output.cfcResult.stdout.label,
            INVOCATION_TAINT_SUBJECT,
          );
          assertLabelIncludesSubject(
            joinedWrite.output.cfcResult.stdout.label,
            "did:key:alice",
          );

          const readBack = await engine.invokeBuiltinTool("bash", {
            command: "cat /workspace/joined.txt",
          });
          assert(readBack.output.cfcResult !== undefined);
          assertEquals(readBack.output.cfcResult.stdout.policy, "opaque");
          assertLabelIncludesSubject(
            readBack.output.cfcResult.stdout.label,
            INVOCATION_TAINT_SUBJECT,
          );
          assertLabelIncludesSubject(
            readBack.output.cfcResult.stdout.label,
            "did:key:alice",
          );
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
    "cf-harness integration: prompt loop withholds tainted bash stdout from model",
  ignore: !INTEGRATION || !CFC_RESULT_DIR_CONFIGURED,
  permissions: { env: true, read: true, run: true, write: true },
  async fn() {
    await assertCfcPolicyLabelsAvailable();
    const secretsHostPath = await makeIntegrationTempDir(
      "cf-harness-secrets-",
    );
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
              type: CFC_PROMPT_SLOT_BOUND_ATOM_TYPE,
              source: {
                type: "cf-harness.integration.prompt-slot",
                subject: "direct-command",
              },
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
    "cf-harness integration: prompt loop mediates read_file output through runsc-cfc",
  ignore: !INTEGRATION || !CFC_RESULT_DIR_CONFIGURED ||
    !CFC_INVOCATION_CONTEXT_DIR_CONFIGURED,
  permissions: { env: true, read: true, run: true, write: true },
  async fn() {
    const artifactRoot = await makeIntegrationTempDir(
      "cf-harness-read-file-cfc-artifacts-",
    );
    const fileContent = "workspace read through runsc CFC\n";
    try {
      await withHarness(
        "integration-read-file-cfc-prompt-loop",
        async (engine, hostPath) => {
          assertEquals(
            engine.sandbox.describe?.().cfc?.invocationContextTransport,
            "sidecar",
          );
          await Deno.mkdir(`${hostPath}/notes`, { recursive: true });
          await Deno.writeTextFile(`${hostPath}/notes/public.txt`, fileContent);

          const requests: Array<{
            messages: Array<{
              role: string;
              tool_call_id?: string;
              content?: string;
            }>;
          }> = [];
          const loop = new CfHarnessPromptLoop({
            apiKey: "test-key",
            engine,
            maxModelTurns: 3,
            fetchFn: (_input, init) => {
              const request = JSON.parse(String(init?.body ?? "{}")) as {
                messages: Array<{
                  role: string;
                  tool_call_id?: string;
                  content?: string;
                }>;
              };
              requests.push(request);
              const toolResponseCount = request.messages.filter((message) =>
                message.role === "tool"
              ).length;
              const payload = toolResponseCount === 0
                ? {
                  choices: [{
                    index: 0,
                    message: {
                      role: "assistant",
                      content: "",
                      tool_calls: [{
                        id: "call-read-file",
                        type: "function",
                        function: {
                          name: "read_file",
                          arguments: JSON.stringify({
                            path: "notes/public.txt",
                          }),
                        },
                      }],
                    },
                  }],
                }
                : toolResponseCount === 1
                ? {
                  choices: [{
                    index: 0,
                    message: {
                      role: "assistant",
                      content: "",
                      tool_calls: [{
                        id: "call-followup-bash",
                        type: "function",
                        function: {
                          name: "bash",
                          arguments: JSON.stringify({
                            command: "printf followup",
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
                      content: "read_file runtime CFC smoke complete.",
                    },
                  }],
                };
              return Promise.resolve(
                new Response(JSON.stringify(payload), { status: 200 }),
              );
            },
          });

          const promptSlotBinding = {
            type: CFC_PROMPT_SLOT_BOUND_ATOM_TYPE,
            source: {
              type: "cf-harness.integration.prompt-slot",
              subject: "read-file-cfc",
            },
            role: "direct-command",
            kernelName: "integration",
            surface: "cli",
          } as const;
          const result = await loop.runPrompt({
            model: "gpt-5.4",
            prompt: "Read the workspace file, then run a followup command.",
            promptSlotBinding,
          });

          assertEquals(
            result.finalAssistantText,
            "read_file runtime CFC smoke complete.",
          );
          assertEquals(requests.length, 3);
          const readToolMessage = requests[1].messages.at(-1);
          assertEquals(readToolMessage?.role, "tool");
          assertEquals(readToolMessage?.tool_call_id, "call-read-file");
          const readToolContent = JSON.parse(
            readToolMessage?.content ?? "{}",
          ) as {
            content?: unknown;
            cfc?: {
              stdout?: { policy?: string };
              stderr?: { policy?: string };
              exitCode?: { policy?: string; value?: number };
              diagnostics?: unknown[];
            };
          };
          assertEquals(readToolContent.content, fileContent);
          assertEquals(readToolContent.cfc?.stdout?.policy, "observed");
          assertEquals(readToolContent.cfc?.stderr?.policy, "observed");
          assertEquals(readToolContent.cfc?.exitCode?.policy, "observed");
          assertEquals(readToolContent.cfc?.exitCode?.value, 0);
          assertStringIncludes(
            JSON.stringify(readToolContent.cfc?.diagnostics ?? []),
            "runsc_cfc_result",
          );

          const runRoot = join(
            artifactRoot,
            "integration-read-file-cfc-prompt-loop",
          );
          const persistedState = await readHarnessRunState(
            join(runRoot, "run-state.json"),
          );
          const persistedTranscript = await readHarnessTranscript(
            join(runRoot, "transcript.json"),
          );
          assertEquals(persistedTranscript, result.transcript);
          assertEquals(
            persistedState.toolOutputs.map((ref) => ref.toolId),
            ["read_file", "bash"],
          );
          assertEquals(
            persistedState.cfcInvocationContexts?.map((context) =>
              context.toolId
            ),
            ["read_file", "bash"],
          );
          assertEquals(
            persistedState.cfcInvocationContexts?.[0].runManifest.present,
            false,
          );
          const readOutputArtifactPath = persistedState.toolOutputs[0]
            ?.artifactPath;
          assert(
            readOutputArtifactPath !== undefined,
            "read_file output artifact path was not retained",
          );
          const readOutputArtifact = JSON.parse(
            await Deno.readTextFile(readOutputArtifactPath),
          ) as {
            content?: unknown;
            cfcResult?: {
              stdout?: { policy?: string };
              diagnostics?: unknown[];
            };
          };
          assertEquals(readOutputArtifact.content, fileContent);
          assertEquals(
            readOutputArtifact.cfcResult?.stdout?.policy,
            "observed",
          );
          assertStringIncludes(
            JSON.stringify(readOutputArtifact.cfcResult?.diagnostics ?? []),
            "runsc_cfc_result",
          );
        },
        {
          artifactRoot,
          cfcEnforcementMode: "enforce-explicit",
          model: "gpt-5.4",
        },
      );
    } finally {
      await Deno.remove(artifactRoot, { recursive: true });
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

Deno.test({
  name:
    "cf-harness integration: Fabric FUSE mount is visible through runsc-cfc",
  ignore: !FABRIC_INTEGRATION,
  permissions: { env: true, read: true, run: true, write: true },
  async fn() {
    await withFabricHarness("integration-fabric-mount", async (engine) => {
      const navResult = await engine.invokeBuiltinTool("bash", {
        command: [
          "set -eu",
          "cd /fabric",
          'printf "pwd=%s\\n" "$(pwd)"',
          "test -f .status",
          'printf "status-bytes="',
          "wc -c < .status",
        ].join("\n"),
      });
      assertEquals(navResult.output.exitCode, 0);
      assertStringIncludes(navResult.output.stdout, "pwd=/fabric\n");
      assertStringIncludes(navResult.output.stdout, "status-bytes=");

      const statusResult = await engine.invokeBuiltinTool("read_file", {
        path: "/fabric/.status",
        maxBytes: 8192,
      });
      assert(
        "content" in statusResult.output,
        JSON.stringify(statusResult.output),
      );
      assertStringIncludes(statusResult.output.content, '"startedAt"');
      assertStringIncludes(statusResult.output.content, '"spaces"');
    });
  },
});

Deno.test({
  name: "cf-harness integration: Fabric FUSE read labels immediate return",
  ignore: !FABRIC_CFC_FLOW_INTEGRATION || !CFC_RESULT_DIR_CONFIGURED,
  permissions: { env: true, read: true, run: true, write: true },
  async fn() {
    const fabricReadPath = requireSandboxFabricPath(
      FABRIC_CFC_READ_PATH,
      "CF_HARNESS_INTEGRATION_FABRIC_CFC_READ_PATH",
    );
    await withFabricHarness(
      "integration-fabric-read-host-bind",
      async (engine, hostPath) => {
        const hostPayload = "fuse read tainted host output\n";
        await warmFabricParents(engine, fabricReadPath);
        const result = await engine.invokeBuiltinTool("bash", {
          command: [
            "set -eu",
            `payload=$(cat ${singleQuoteShell(fabricReadPath)})`,
            `printf ${
              singleQuoteShell(hostPayload)
            } > /workspace/fuse-read-host.txt`,
            "printf 'fuse read tainted return\\n'",
          ].join("\n"),
        });

        assertEquals(result.output.exitCode, 0);
        assertEquals(
          await Deno.readTextFile(`${hostPath}/fuse-read-host.txt`),
          hostPayload,
        );
        assert(result.output.cfcResult !== undefined);
        assertEquals(result.output.cfcResult.stdout.policy, "opaque");
        assertLabelIncludesSubject(
          result.output.cfcResult.stdout.label,
          FABRIC_CFC_LABEL_SUBJECT,
        );
      },
    );
  },
});

Deno.test({
  name: "cf-harness integration: Fabric FUSE read labels host bind readback",
  ignore: !FABRIC_CFC_DURABLE_HOST_LABEL_INTEGRATION ||
    !CFC_RESULT_DIR_CONFIGURED,
  permissions: { env: true, read: true, run: true, write: true },
  async fn() {
    const fabricReadPath = requireSandboxFabricPath(
      FABRIC_CFC_READ_PATH,
      "CF_HARNESS_INTEGRATION_FABRIC_CFC_READ_PATH",
    );
    await withFabricHarness(
      "integration-fabric-read-host-bind-readback",
      async (engine, hostPath) => {
        const hostPayload = "fuse read durable host output\n";
        await warmFabricParents(engine, fabricReadPath);
        const result = await engine.invokeBuiltinTool("bash", {
          command: [
            "set -eu",
            `cat ${singleQuoteShell(fabricReadPath)} >/dev/null`,
            `printf ${
              singleQuoteShell(hostPayload)
            } > /workspace/fuse-read-host.txt`,
          ].join("\n"),
        });

        assertEquals(result.output.exitCode, 0);
        assertEquals(
          await Deno.readTextFile(`${hostPath}/fuse-read-host.txt`),
          hostPayload,
        );
        assert(result.output.cfcResult !== undefined);
        assertEquals(result.output.cfcResult.stdout.policy, "opaque");
        assertLabelIncludesSubject(
          result.output.cfcResult.stdout.label,
          FABRIC_CFC_LABEL_SUBJECT,
        );

        const hostReadBack = await engine.invokeBuiltinTool("bash", {
          command: "cat /workspace/fuse-read-host.txt",
        });
        assertEquals(hostReadBack.output.exitCode, 0);
        assertStringIncludes(hostReadBack.output.stdout, hostPayload);
        assert(hostReadBack.output.cfcResult !== undefined);
        assertEquals(hostReadBack.output.cfcResult.stdout.policy, "opaque");
        assertLabelIncludesSubject(
          hostReadBack.output.cfcResult.stdout.label,
          FABRIC_CFC_LABEL_SUBJECT,
        );
      },
    );
  },
});

Deno.test({
  name:
    "cf-harness integration: invocation labels taint Fabric FUSE write and return",
  ignore: !FABRIC_CFC_FLOW_INTEGRATION || !CFC_RESULT_DIR_CONFIGURED ||
    !CFC_INVOCATION_CONTEXT_DIR_CONFIGURED,
  permissions: { env: true, read: true, run: true, write: true },
  async fn() {
    const fabricWritePath = requireSandboxFabricPath(
      FABRIC_CFC_WRITE_PATH,
      "CF_HARNESS_INTEGRATION_FABRIC_CFC_WRITE_PATH",
    );
    await withFabricHarness(
      "integration-input-label-fabric-write",
      async (engine, _workspaceHostPath, fabricHostPath) => {
        const fabricPayload =
          "from invocation label through FUSE: integration-input-label-fabric-write\n";
        const normalizedFabricPayload = fabricPayload.trimEnd();
        await warmFabricParents(engine, fabricWritePath);
        const writeResult = await engine.invokeBuiltinTool("bash", {
          command: [
            "set -eu",
            `printf ${singleQuoteShell(fabricPayload)} > ${
              singleQuoteShell(fabricWritePath)
            }`,
            "printf 'wrote fabric value\\n'",
          ].join("\n"),
          cfcInputLabels: invocationInputLabels(),
        });

        assertEquals(writeResult.output.exitCode, 0);
        assert(writeResult.output.cfcResult !== undefined);
        assertEquals(writeResult.output.cfcResult.stdout.policy, "opaque");
        assertLabelIncludesSubject(
          writeResult.output.cfcResult.stdout.label,
          INVOCATION_TAINT_SUBJECT,
        );

        await waitForFabricHostCfcSubject(
          fabricHostPath,
          fabricWritePath,
          INVOCATION_TAINT_SUBJECT,
        );
        await warmFabricParents(engine, fabricWritePath);
        const readBack = await engine.invokeBuiltinTool("bash", {
          command: [
            "set -eu",
            `cat ${singleQuoteShell(fabricWritePath)}`,
          ].join("\n"),
        });
        assertEquals(readBack.output.exitCode, 0);
        assertStringIncludes(readBack.output.stdout, normalizedFabricPayload);
        assert(readBack.output.cfcResult !== undefined);
        assertEquals(readBack.output.cfcResult.stdout.policy, "opaque");
        assertLabelIncludesSubject(
          readBack.output.cfcResult.stdout.label,
          INVOCATION_TAINT_SUBJECT,
        );
      },
    );
  },
});

Deno.test({
  name:
    "cf-harness integration: invocation and Fabric labels join before Fabric write",
  ignore: !FABRIC_CFC_FLOW_INTEGRATION || !CFC_RESULT_DIR_CONFIGURED ||
    !CFC_INVOCATION_CONTEXT_DIR_CONFIGURED,
  permissions: { env: true, read: true, run: true, write: true },
  async fn() {
    const fabricReadPath = requireSandboxFabricPath(
      FABRIC_CFC_READ_PATH,
      "CF_HARNESS_INTEGRATION_FABRIC_CFC_READ_PATH",
    );
    const fabricWritePath = requireSandboxFabricPath(
      FABRIC_CFC_WRITE_PATH,
      "CF_HARNESS_INTEGRATION_FABRIC_CFC_WRITE_PATH",
    );
    await withFabricHarness(
      "integration-input-label-fabric-join-write",
      async (engine, _workspaceHostPath, fabricHostPath) => {
        const joinedPayload =
          "joined invocation and fabric labels: integration-input-label-fabric-join-write\n";
        const normalizedJoinedPayload = joinedPayload.trimEnd();
        await warmFabricParents(engine, fabricReadPath);
        await warmFabricParents(engine, fabricWritePath);
        const joinedWrite = await engine.invokeBuiltinTool("bash", {
          command: [
            "set -eu",
            `cat ${singleQuoteShell(fabricReadPath)} >/dev/null`,
            `printf ${singleQuoteShell(joinedPayload)} > ${
              singleQuoteShell(fabricWritePath)
            }`,
            "printf 'joined fabric result\\n'",
          ].join("\n"),
          cfcInputLabels: invocationInputLabels(),
        });

        assertEquals(joinedWrite.output.exitCode, 0);
        assert(joinedWrite.output.cfcResult !== undefined);
        assertEquals(joinedWrite.output.cfcResult.stdout.policy, "opaque");
        assertLabelIncludesSubject(
          joinedWrite.output.cfcResult.stdout.label,
          INVOCATION_TAINT_SUBJECT,
        );
        assertLabelIncludesSubject(
          joinedWrite.output.cfcResult.stdout.label,
          FABRIC_CFC_LABEL_SUBJECT,
        );

        await waitForFabricHostCfcSubject(
          fabricHostPath,
          fabricWritePath,
          INVOCATION_TAINT_SUBJECT,
        );
        await warmFabricParents(engine, fabricWritePath);
        const readBack = await engine.invokeBuiltinTool("bash", {
          command: [
            "set -eu",
            `cat ${singleQuoteShell(fabricWritePath)}`,
          ].join("\n"),
        });
        assertEquals(readBack.output.exitCode, 0);
        assertStringIncludes(readBack.output.stdout, normalizedJoinedPayload);
        assert(readBack.output.cfcResult !== undefined);
        assertEquals(readBack.output.cfcResult.stdout.policy, "opaque");
        assertLabelIncludesSubject(
          readBack.output.cfcResult.stdout.label,
          INVOCATION_TAINT_SUBJECT,
        );
        assertLabelIncludesSubject(
          readBack.output.cfcResult.stdout.label,
          FABRIC_CFC_LABEL_SUBJECT,
        );
      },
    );
  },
});
