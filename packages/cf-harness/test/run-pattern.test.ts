import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { normalize } from "@std/path/posix";
import { createSession, Identity } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import { Runtime } from "@commonfabric/runner";
import { createLLMFriendlyLink } from "@commonfabric/runner/shared";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { CfHarnessEngine } from "../src/engine.ts";
import { CAPABILITY_PROBE_SENTINEL } from "../src/diagnostics.ts";
import {
  RUN_PATTERN_MAX_SOURCE_TEXT_BYTES,
  type RunPatternToolErrorOutput,
  type RunPatternToolSuccessOutput,
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

const NAMED_DOUBLING_PATTERN_SOURCE = [
  "import { computed, NAME, pattern } from 'commonfabric';",
  "interface Input { n: number; }",
  "interface Output { doubled: number; $NAME: string; }",
  "export default pattern<Input, Output>(({ n }) => ({",
  "  [NAME]: 'Doubler',",
  "  doubled: computed(() => n * 2),",
  "}));",
  "",
].join("\n");

const DOUBLED_RESULT_SCHEMA = {
  type: "object",
  properties: { doubled: { type: "number" } },
  required: ["doubled"],
} as const;

/**
 * A minimal default-pattern program exposing the piece registry, so the
 * space has a REAL registry rather than the detached always-empty fallback.
 */
const DEFAULT_PATTERN_SOURCE = [
  "/// <cf-disable-transform />",
  "import { handler, pattern } from 'commonfabric';",
  "const addPiece = handler<{ piece: unknown }, { pieceRegistry: unknown[] }>(",
  "  ({ piece }, { pieceRegistry }) => {",
  "    pieceRegistry.push(piece);",
  "  },",
  "  { proxy: true },",
  ");",
  "export default pattern<{ pieceRegistry: unknown[] }>(({ pieceRegistry }) => ({",
  "  pieceRegistry,",
  "  addPiece: addPiece({ pieceRegistry }),",
  "}));",
].join("\n");

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

  function createEngine() {
    return new CfHarnessEngine({
      sandboxRuntime: new FakeSandboxRuntime(),
      runId: `run-pattern-test-${crypto.randomUUID()}`,
      cfcEnforcementMode: "disabled",
      fabricSessionFactory: () => Promise.resolve({ pieces }),
    });
  }

  /** Counts `runPersistent` calls, the single path that persists a piece. */
  function spyOnRunPersistent(): { calls: number } {
    const spy = { calls: 0 };
    const original = pieces.runPersistent.bind(pieces);
    pieces.runPersistent = ((
      ...args: Parameters<
        PiecesController["runPersistent"]
      >
    ) => {
      spy.calls += 1;
      return original(...args);
    }) as PiecesController["runPersistent"];
    return spy;
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

    it("keeps a computed number when the result carries framework keys the schema does not declare", async () => {
      // Every pattern result carries the framework's own keys, and a schema
      // describing only what the pattern computes declares none of them. The
      // sanitizer seals a whole object over one unmodeled key, so without the
      // framework keys being dropped first the number goes over as an opaque
      // link along with everything else.
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: NAMED_DOUBLING_PATTERN_SOURCE,
        inputs: { n: 21 },
        resultSchema: DOUBLED_RESULT_SCHEMA,
      });
      const output = result.output as RunPatternToolSuccessOutput;
      expect(output.status).toBe("ok");
      expect((output.rawValue as Record<string, unknown>)["$NAME"]).toBe(
        "Doubler",
      );
      expect(output.value).toEqual({ doubled: 42 });
      expect(output.linkedStringCount).toBe(0);
    });

    it("refuses a result the schema rejects for what it carries under a framework key", async () => {
      // The raw result is what the schema measures. A branch that asks what
      // `$NAME` holds gets the answer the pattern gave, so a result that does
      // not match is refused — projecting the framework keys out before
      // validating would hand the branch the rest of the result and accept it.
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: NAMED_DOUBLING_PATTERN_SOURCE,
        inputs: { n: 21 },
        resultSchema: {
          oneOf: [{
            type: "object",
            properties: {
              doubled: { type: "number" },
              $NAME: { type: "string", const: "Approved" },
            },
            required: ["doubled", "$NAME"],
          }],
        },
      });
      const output = result.output as RunPatternToolSuccessOutput;
      expect(output.status).toBe("ok");
      expect(output.value).toBeUndefined();
      expect(output.valueError).toBeDefined();
    });

    it("keeps a framework key the schema declares through a composed branch", async () => {
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: NAMED_DOUBLING_PATTERN_SOURCE,
        inputs: { n: 21 },
        resultSchema: {
          oneOf: [{
            type: "object",
            properties: {
              doubled: { type: "number" },
              $NAME: { type: "string", const: "Doubler" },
            },
            required: ["doubled", "$NAME"],
          }],
        },
      });
      const output = result.output as RunPatternToolSuccessOutput;
      expect(output.status).toBe("ok");
      expect(output.value).toEqual({ doubled: 42, $NAME: "Doubler" });
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

    it("returns an error when `sourceText` is missing", async () => {
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {});
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("requires sourceText");
    });

    it("returns an error for a `sourceText` over the size cap without creating a piece", async () => {
      const spy = spyOnRunPersistent();
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: "x".repeat(RUN_PATTERN_MAX_SOURCE_TEXT_BYTES + 1),
      });
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("256 KiB limit");
      expect(spy.calls).toBe(0);
    });

    it("returns an error for a link input targeting another space without creating a piece", async () => {
      const spy = spyOnRunPersistent();
      const engine = createEngine();
      const foreignRef = `/@did:key:z6MkforeignSpaceForRunPatternTest/of:fid1:${
        "A".repeat(43)
      }/`;
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: DOUBLING_PATTERN_SOURCE,
        inputs: { n: foreignRef },
      });
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("targets another space");
      expect(spy.calls).toBe(0);
    });

    it("returns an error for a live-cell input whose value does not match the argument schema, creating no piece", async () => {
      const space = pieces.getSpace();
      const seed = runtime.getCell(
        space,
        "run-pattern-shape-mismatch",
        {
          type: "object",
          properties: { foo: { type: "number" } },
        } as const,
      );
      const { error } = await runtime.editWithRetry((tx) => {
        seed.withTx(tx).set({ foo: 1 });
      });
      expect(error).toBeUndefined();
      await runtime.idle();
      const seedRef = createLLMFriendlyLink(
        seed.getAsNormalizedFullLink(),
        space,
      );
      const spy = spyOnRunPersistent();
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: DOUBLING_PATTERN_SOURCE,
        inputs: { n: seedRef },
      });
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain('input "n"');
      expect(output.message).toContain("argument schema");
      expect(spy.calls).toBe(0);
    });

    it("returns a `cancelled` output and stops the piece when the signal aborts during the settle barrier", async () => {
      const controller = new AbortController();
      // Abort exactly when the tool reaches its post-create barrier, and
      // hold the barrier open so only the signal can win the race.
      const runtimeWithSettled = runtime as unknown as {
        settled: () => Promise<void>;
      };
      runtimeWithSettled.settled = () => {
        controller.abort();
        return new Promise<void>(() => {});
      };
      const stopped: unknown[] = [];
      const runner = runtime.runner as unknown as {
        stop: (cell: unknown) => unknown;
      };
      const originalStop = runner.stop.bind(runtime.runner);
      runner.stop = (cell) => {
        stopped.push(cell);
        return originalStop(cell);
      };
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: DOUBLING_PATTERN_SOURCE,
        inputs: { n: 1 },
      }, { signal: controller.signal });
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("cancelled");
      expect(output.message).toContain("cancelled");
      expect(stopped.length).toBe(1);
      expect(result.runState.status).toBe("completed");
    });

    it("surfaces a rejected session construction as a structured error and invokes the factory again on the next call", async () => {
      let factoryCalls = 0;
      const engine = new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime(),
        runId: `run-pattern-test-${crypto.randomUUID()}`,
        cfcEnforcementMode: "disabled",
        fabricSessionFactory: () => {
          factoryCalls += 1;
          return Promise.reject(
            new Error("authorization denied for the configured space"),
          );
        },
      });
      const first = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: DOUBLING_PATTERN_SOURCE,
      });
      const firstOutput = first.output as RunPatternToolErrorOutput;
      expect(firstOutput.status).toBe("error");
      expect(firstOutput.message).toContain("fabric session unavailable");
      expect(firstOutput.message).toContain("authorization denied");
      const second = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: DOUBLING_PATTERN_SOURCE,
      });
      expect((second.output as RunPatternToolErrorOutput).status).toBe(
        "error",
      );
      expect(factoryCalls).toBe(2);
    });

    it("leaves the created piece out of the space's real registered piece list", async () => {
      // A real default pattern first: without one, `getRegisteredPieces()`
      // reads a detached always-empty fallback and the assertion below
      // holds vacuously.
      const defaultRoot = await pieces.create(DEFAULT_PATTERN_SOURCE, {
        input: { pieceRegistry: [] },
      });
      await pieces.linkDefaultPattern(defaultRoot.getCell());
      await runtime.idle();
      await pieces.synced();
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: DOUBLING_PATTERN_SOURCE,
        inputs: { n: 1 },
      });
      expect((result.output as RunPatternToolSuccessOutput).status).toBe("ok");
      const registered = await pieces.getRegisteredPieces();
      expect(registered.length).toBe(0);
      // The registry observes registration, proving the zero above is a
      // decision by the tool and not an inert list.
      const control = await pieces.create(DOUBLING_PATTERN_SOURCE, {
        input: { n: 2 },
      });
      await pieces.add([control.getCell()]);
      const afterAdd = await pieces.getRegisteredPieces();
      expect(afterAdd.length).toBe(1);
    });
  });
});
