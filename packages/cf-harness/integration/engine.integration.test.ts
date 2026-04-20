import { assertEquals, assertStringIncludes } from "@std/assert";
import { CfHarnessEngine } from "../src/engine.ts";
import { resolveDockerRunscSandboxConfig } from "../src/sandbox/docker-runsc.ts";

const INTEGRATION = Deno.env.get("CF_HARNESS_INTEGRATION") === "1";
const DOCKER_RUNTIME = Deno.env.get("CF_HARNESS_INTEGRATION_RUNTIME") ??
  "runsc-cfc";
const DOCKER_IMAGE = Deno.env.get("CF_HARNESS_INTEGRATION_IMAGE") ??
  "alpine:3.20";

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

const withHarness = async (
  runId: string,
  fn: (engine: CfHarnessEngine, hostPath: string) => Promise<void>,
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
      sandbox: resolveDockerRunscSandboxConfig({
        workspaceHostPath,
        runtimeName: DOCKER_RUNTIME,
        image: DOCKER_IMAGE,
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
      assertEquals(readResult.output.content, "line one\nline two\n");
      const diskContent = await Deno.readTextFile(`${hostPath}/notes/log.txt`);
      assertEquals(diskContent, "line one\nline two\n");
    });
  },
});
