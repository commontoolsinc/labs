import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { normalize } from "@std/path/posix";
import { createSession, Identity } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { CfHarnessEngine } from "../src/engine.ts";
import type { HarnessFetch } from "../src/contracts/http-fetch.ts";
import { PatternIndexClient } from "../src/pattern-index/client.ts";
import {
  type RunPatternToolErrorOutput,
  type RunPatternToolSuccessOutput,
  runtimeProgramFromIndex,
} from "../src/tools/run-pattern.ts";
import type {
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxRuntime,
  SandboxRuntimeDescription,
  SandboxShellRequest,
} from "../src/sandbox/types.ts";

const signer = await Identity.fromPassphrase("cf-harness run-pattern index");

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

const INDEXED_PATTERN = {
  patternId: "pat-doubler",
  ownerDid: "did:key:zOwner",
  createdAt: "2026-08-01T00:00:00.000Z",
  description: "Doubles a number",
  hashtags: ["math"],
  dependencies: [],
  program: {
    main: "/main.tsx",
    files: [{ name: "/main.tsx", contents: DOUBLING_PATTERN_SOURCE }],
  },
};

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

  runShell(_request: SandboxShellRequest): Promise<SandboxCommandResult> {
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }
}

interface IndexStub {
  fetchFn: HarnessFetch;
  calls: { fn: string; body: Record<string, unknown> }[];
}

/**
 * An index answering `getPattern` with `patterns` and every event with `ok`.
 * A pattern absent from the map answers 404.
 */
const stubIndex = (patterns: Record<string, unknown>): IndexStub => {
  const calls: { fn: string; body: Record<string, unknown> }[] = [];
  const fetchFn: HarnessFetch = (input, init) => {
    const fn = String(input).split("/").pop() ?? "";
    const body = JSON.parse(
      typeof init?.body === "string" ? init.body : "{}",
    ) as Record<string, unknown>;
    calls.push({ fn, body });
    if (fn === "recordEvent") {
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );
    }
    const pattern = patterns[body.patternId as string];
    return Promise.resolve(
      pattern === undefined
        ? new Response(JSON.stringify({ error: "unknown pattern" }), {
          status: 404,
        })
        : new Response(JSON.stringify(pattern), { status: 200 }),
    );
  };
  return { fetchFn, calls };
};

describe("run-pattern over the pattern index", () => {
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
        spaceName: `run-pattern-index-${crypto.randomUUID()}`,
      }),
      runtime,
    );
    await pieces.synced();
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  const createEngine = (index?: IndexStub): CfHarnessEngine =>
    new CfHarnessEngine({
      sandboxRuntime: new FakeSandboxRuntime(),
      runId: `run-pattern-index-test-${crypto.randomUUID()}`,
      cfcEnforcementMode: "disabled",
      fabricSessionFactory: () => Promise.resolve({ pieces }),
      ...(index === undefined ? {} : {
        patternIndexClientFactory: () =>
          Promise.resolve(
            new PatternIndexClient({
              baseUrl: "https://index.test",
              fetchFn: index.fetchFn,
              signer,
            }),
          ),
      }),
    });

  describe("runtimeProgramFromIndex()", () => {
    it("carries every field a published program declares", () => {
      expect(runtimeProgramFromIndex({
        main: "/main.tsx",
        mainExport: "doubler",
        files: [
          { name: "/main.tsx", contents: "source" },
          { name: "/rows.csv", contents: "a,b" },
        ],
        sourceRoots: ["/extra.tsx"],
        dataFiles: ["/rows.csv"],
      })).toEqual({
        main: "/main.tsx",
        mainExport: "doubler",
        files: [
          { name: "/main.tsx", contents: "source" },
          { name: "/rows.csv", contents: "a,b" },
        ],
        sourceRoots: ["/extra.tsx"],
        dataFiles: ["/rows.csv"],
      });
    });

    it("omits the optional fields a published program leaves out", () => {
      expect(runtimeProgramFromIndex({
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents: "source" }],
      })).toEqual({
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents: "source" }],
      });
    });
  });

  describe("runPatternTool", () => {
    it("runs an indexed pattern and returns its result", async () => {
      const index = stubIndex({ "pat-doubler": INDEXED_PATTERN });
      const result = await createEngine(index).invokeBuiltinTool(
        "run_pattern",
        {
          patternId: "pat-doubler",
          inputs: { n: 21 },
          resultSchema: DOUBLED_RESULT_SCHEMA,
        },
      );
      const output = result.output as RunPatternToolSuccessOutput;
      expect(output.status).toBe("ok");
      expect((output.value as { doubled: number }).doubled).toBe(42);
    });

    it("fetches the program with its source and never echoes it back", async () => {
      const index = stubIndex({ "pat-doubler": INDEXED_PATTERN });
      const result = await createEngine(index).invokeBuiltinTool(
        "run_pattern",
        { patternId: "pat-doubler", inputs: { n: 1 } },
      );
      const lookup = index.calls.find((call) => call.fn === "getPattern");
      expect(lookup?.body).toEqual({
        patternId: "pat-doubler",
        includeSource: true,
      });
      expect(JSON.stringify(result.output)).not.toContain(
        "export default pattern",
      );
    });

    it("reports instantiation to the index", async () => {
      const index = stubIndex({ "pat-doubler": INDEXED_PATTERN });
      await createEngine(index).invokeBuiltinTool("run_pattern", {
        patternId: "pat-doubler",
        inputs: { n: 1 },
      });
      const events = index.calls.filter((call) => call.fn === "recordEvent");
      expect(events.map((event) => event.body.eventType)).toContain(
        "instantiated",
      );
      expect(events[0].body.patternId).toBe("pat-doubler");
    });

    it("refuses a call naming both sourceText and patternId", async () => {
      const index = stubIndex({ "pat-doubler": INDEXED_PATTERN });
      const result = await createEngine(index).invokeBuiltinTool(
        "run_pattern",
        {
          sourceText: DOUBLING_PATTERN_SOURCE,
          patternId: "pat-doubler",
        },
      );
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("not both");
    });

    it("refuses a call naming neither sourceText nor patternId", async () => {
      const index = stubIndex({ "pat-doubler": INDEXED_PATTERN });
      const result = await createEngine(index).invokeBuiltinTool(
        "run_pattern",
        {},
      );
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("requires sourceText or patternId");
    });

    it("refuses a patternId when the run has no pattern index", async () => {
      const result = await createEngine().invokeBuiltinTool("run_pattern", {
        patternId: "pat-doubler",
      });
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("--pattern-index-url");
    });

    it("reports what the index answered for a pattern it does not hold", async () => {
      const index = stubIndex({});
      const result = await createEngine(index).invokeBuiltinTool(
        "run_pattern",
        { patternId: "pat-missing" },
      );
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("pat-missing");
      expect(output.message).toContain("404");
    });

    it("withholds the diagnostic when an indexed pattern does not compile", async () => {
      const index = stubIndex({
        "pat-broken": {
          ...INDEXED_PATTERN,
          patternId: "pat-broken",
          program: {
            main: "/main.tsx",
            files: [{
              name: "/main.tsx",
              contents: "const secretConstantName = ;",
            }],
          },
        },
      });
      const result = await createEngine(index).invokeBuiltinTool(
        "run_pattern",
        { patternId: "pat-broken" },
      );
      const output = result.output as RunPatternToolErrorOutput;
      expect(output.status).toBe("compile-error");
      expect(output.message).toContain("pat-broken");
      expect(output.message).not.toContain("secretConstantName");
      expect(output.rawCauseMessage).toBeDefined();
    });
  });
});
