import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { normalize } from "@std/path/posix";
import { createSession, Identity } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import { Runtime } from "@commonfabric/runner";
import { createLLMFriendlyLink } from "@commonfabric/runner/shared";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { CfHarnessEngine } from "../src/engine.ts";
import { CAPABILITY_PROBE_SENTINEL } from "../src/diagnostics.ts";
import type {
  RunPatternToolErrorOutput,
  RunPatternToolSuccessOutput,
} from "../src/tools/run-pattern.ts";
import type {
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxRuntime,
  SandboxRuntimeDescription,
  SandboxShellRequest,
} from "../src/sandbox/types.ts";

const signer = await Identity.fromPassphrase("cf-harness run-pattern tool");

const DOUBLING_PATTERN_SOURCE = [
  "import { computed, pattern } from 'commonfabric';",
  "interface Input { n: number; }",
  "interface Output { doubled: number; }",
  "export default pattern<Input, Output>(({ n }) => ({",
  "  doubled: computed(() => n * 2),",
  "}));",
  "",
].join("\n");

const DOUBLED_RESULT_SCHEMA = {
  type: "object",
  properties: { doubled: { type: "number" } },
  required: ["doubled"],
} as const;

class FakeSandboxRuntime implements SandboxRuntime {
  describe(): SandboxRuntimeDescription {
    return {
      kind: "docker-runsc-cfc",
      defaultWorkingDirectory: this.defaultWorkingDirectory(),
      cfc: { runtimeRequested: true, workspaceMountPath: "/workspace" },
    };
  }

  resolvePath(path: string, cwd = this.defaultWorkingDirectory()): string {
    return normalize(path.startsWith("/") ? path : `${cwd}/${path}`);
  }

  isPathWithinWorkspace(path: string): boolean {
    return path === "/workspace" || path.startsWith("/workspace/");
  }

  isPathWithinAllowedRoots(path: string): boolean {
    return this.isPathWithinWorkspace(path);
  }

  defaultWorkingDirectory(): string {
    return "/workspace";
  }

  run(_request: SandboxCommandRequest): Promise<SandboxCommandResult> {
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }

  runShell(request: SandboxShellRequest): Promise<SandboxCommandResult> {
    if (request.command.includes(CAPABILITY_PROBE_SENTINEL)) {
      return Promise.resolve({
        stdout: "bash\tpresent\t/bin/bash\tGNU bash, version 5.2.26(1)-release",
        stderr: "",
        exitCode: 0,
      });
    }
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }
}

describe("run-pattern", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let pieces: PiecesController;

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
    });
    pieces = new PiecesController(
      await createSession({
        identity: signer,
        spaceName: `run-pattern-${crypto.randomUUID()}`,
      }),
      runtime,
    );
    await pieces.synced();
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  function createEngine(options: { workspaceHostPath?: string } = {}) {
    return new CfHarnessEngine({
      sandboxRuntime: new FakeSandboxRuntime(),
      runId: `run-pattern-test-${crypto.randomUUID()}`,
      cfcEnforcementMode: "disabled",
      fabricSessionFactory: () => Promise.resolve({ pieces }),
      ...(options.workspaceHostPath !== undefined
        ? { workspaceHostPath: options.workspaceHostPath }
        : {}),
    });
  }

  describe("runPatternTool", () => {
    it("runs inline `sourceText` and returns a `resultRef` with the sanitized `value`", async () => {
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: DOUBLING_PATTERN_SOURCE,
        inputs: { n: 21 },
        resultSchema: DOUBLED_RESULT_SCHEMA,
      });
      const output = result.output as RunPatternToolSuccessOutput;
      expect(output.status).toBe("ok");
      expect(output.resultRef).toMatch(/^\/of:/);
      expect(output.pieceId.length).toBeGreaterThan(0);
      expect((output.value as { doubled: number }).doubled).toBe(42);
      expect(output.linkedStringCount).toBe(0);
    });

    it("passes a whole-string LLM-friendly link input as a live cell reference", async () => {
      const space = pieces.getSpace();
      const seed = runtime.getCell<number>(space, "run-pattern-seed", {
        type: "number",
      });
      const { error } = await runtime.editWithRetry((tx) => {
        seed.withTx(tx).set(7);
      });
      expect(error).toBeUndefined();
      await runtime.idle();
      const seedRef = createLLMFriendlyLink(
        seed.getAsNormalizedFullLink(),
        space,
      );
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: DOUBLING_PATTERN_SOURCE,
        inputs: { n: seedRef },
        resultSchema: DOUBLED_RESULT_SCHEMA,
      });
      const output = result.output as RunPatternToolSuccessOutput;
      expect(output.status).toBe("ok");
      expect((output.value as { doubled: number }).doubled).toBe(14);
    });

    it("returns a `compile-error` output carrying the raw diagnostics without failing the run", async () => {
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: "this is not a pattern ((",
      });
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("compile-error");
      expect(output.message.length).toBeGreaterThan(0);
      expect(result.runState.status).toBe("completed");
    });

    it("returns an error when both `sourceText` and `sourcePath` are given", async () => {
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: DOUBLING_PATTERN_SOURCE,
        sourcePath: "pattern.tsx",
      });
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("exactly one");
    });

    it("returns an error when neither `sourceText` nor `sourcePath` is given", async () => {
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {});
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("exactly one");
    });

    it("reads `sourcePath` from inside the workspace", async () => {
      const workspace = await Deno.makeTempDir({
        prefix: "cf-harness-run-pattern-",
      });
      try {
        await Deno.writeTextFile(
          join(workspace, "pattern.tsx"),
          DOUBLING_PATTERN_SOURCE,
        );
        const engine = createEngine({ workspaceHostPath: workspace });
        const result = await engine.invokeBuiltinTool("run_pattern", {
          sourcePath: "pattern.tsx",
          inputs: { n: 4 },
          resultSchema: DOUBLED_RESULT_SCHEMA,
        });
        const output = result.output as RunPatternToolSuccessOutput;
        expect(output.status).toBe("ok");
        expect((output.value as { doubled: number }).doubled).toBe(8);
      } finally {
        await Deno.remove(workspace, { recursive: true });
      }
    });

    it("returns an error for a `sourcePath` that resolves outside the workspace", async () => {
      const workspace = await Deno.makeTempDir({
        prefix: "cf-harness-run-pattern-",
      });
      try {
        const engine = createEngine({ workspaceHostPath: workspace });
        const result = await engine.invokeBuiltinTool("run_pattern", {
          sourcePath: "../escape.tsx",
        });
        const output = result.output as RunPatternToolErrorOutput;
        expect(output.status).toBe("error");
        expect(output.message).toContain("outside the workspace");
      } finally {
        await Deno.remove(workspace, { recursive: true });
      }
    });

    it("leaves the created piece out of the space's registered piece list", async () => {
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: DOUBLING_PATTERN_SOURCE,
        inputs: { n: 1 },
      });
      expect((result.output as RunPatternToolSuccessOutput).status).toBe("ok");
      const registered = await pieces.getRegisteredPieces();
      expect(registered.length).toBe(0);
    });
  });
});
