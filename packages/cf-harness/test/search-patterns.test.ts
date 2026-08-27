import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { normalize } from "@std/path/posix";
import { Identity } from "@commonfabric/identity";
import { CfHarnessEngine } from "../src/engine.ts";
import type { HarnessFetch } from "../src/contracts/http-fetch.ts";
import { PatternIndexClient } from "../src/pattern-index/client.ts";
import {
  searchPatternsTool,
  type SearchPatternsToolErrorOutput,
  type SearchPatternsToolSuccessOutput,
} from "../src/tools/search-patterns.ts";
import type {
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxRuntime,
  SandboxRuntimeDescription,
  SandboxShellRequest,
} from "../src/sandbox/types.ts";

const signer = await Identity.fromPassphrase("cf-harness search-patterns tool");

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

const SEARCH_HIT = {
  patternId: "pat-expenses",
  description: "Totals an expense list",
  hashtags: ["expenses", "money"],
  ownerDid: "did:key:zOwner",
  createdAt: "2026-08-01T00:00:00.000Z",
  dependencies: [],
  signals: { uses: 12, score: 0.9 },
};

const PATTERN_RECORD = {
  patternId: "pat-expenses",
  ownerDid: "did:key:zOwner",
  createdAt: "2026-08-01T00:00:00.000Z",
  description: "Totals an expense list",
  hashtags: ["expenses", "money"],
  dependencies: [],
  argumentSchema: {
    type: "object",
    properties: { amounts: { type: "array", items: { type: "number" } } },
    required: ["amounts"],
  },
  resultSchema: {
    type: "object",
    properties: { total: { type: "number" } },
    required: ["total"],
  },
};

interface IndexStub {
  fetchFn: HarnessFetch;
  calls: { fn: string; body: unknown }[];
}

/**
 * An index that answers `searchPatterns` with `results` and `getPattern` with
 * whatever `patterns` holds for the requested id. A pattern absent from the
 * map answers 404, which is how a hit whose record cannot be read is staged.
 */
const stubIndex = (
  results: readonly unknown[],
  patterns: Record<string, unknown> = {},
): IndexStub => {
  const calls: { fn: string; body: unknown }[] = [];
  const fetchFn: HarnessFetch = (input, init) => {
    const fn = String(input).split("/").pop() ?? "";
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
    calls.push({ fn, body });
    if (fn === "searchPatterns") {
      return Promise.resolve(
        new Response(JSON.stringify({ results }), { status: 200 }),
      );
    }
    const pattern = patterns[(body as { patternId: string }).patternId];
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

const createEngine = (index?: IndexStub): CfHarnessEngine =>
  new CfHarnessEngine({
    sandboxRuntime: new FakeSandboxRuntime(),
    runId: `search-patterns-test-${crypto.randomUUID()}`,
    cfcEnforcementMode: "disabled",
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

describe("search-patterns", () => {
  it("reports each hit with the import specifier that composes it", async () => {
    const index = stubIndex([SEARCH_HIT], { "pat-expenses": PATTERN_RECORD });
    const result = await createEngine(index).invokeBuiltinTool(
      "search_patterns",
      { tags: ["expenses"] },
    );
    const output = result.output as SearchPatternsToolSuccessOutput;
    expect(output.status).toBe("ok");
    expect(output.results.length).toBe(1);
    expect(output.results[0].patternId).toBe("pat-expenses");
    expect(output.results[0].description).toBe("Totals an expense list");
    expect(output.results[0].hashtags).toEqual(["expenses", "money"]);
    expect(output.results[0].signals).toEqual({ uses: 12, score: 0.9 });
    expect(output.results[0].importHint).toBe(
      'import X from "cf:pattern:pat-expenses"',
    );
  });

  it("renders the declared argument and result shapes as types", async () => {
    const index = stubIndex([SEARCH_HIT], { "pat-expenses": PATTERN_RECORD });
    const result = await createEngine(index).invokeBuiltinTool(
      "search_patterns",
      { text: "expenses" },
    );
    const output = result.output as SearchPatternsToolSuccessOutput;
    expect(output.results[0].argumentType).toContain("amounts");
    expect(output.results[0].argumentType).toContain("number[]");
    expect(output.results[0].resultType).toContain("total: number");
  });

  it("asks the index for the shapes without asking for source", async () => {
    const index = stubIndex([SEARCH_HIT], { "pat-expenses": PATTERN_RECORD });
    await createEngine(index).invokeBuiltinTool("search_patterns", {
      tags: ["expenses"],
    });
    const lookup = index.calls.find((call) => call.fn === "getPattern");
    expect(lookup?.body).toEqual({
      patternId: "pat-expenses",
      includeSource: false,
    });
  });

  it("still reports a hit whose record could not be read", async () => {
    const index = stubIndex([SEARCH_HIT]);
    const result = await createEngine(index).invokeBuiltinTool(
      "search_patterns",
      { tags: ["expenses"] },
    );
    const output = result.output as SearchPatternsToolSuccessOutput;
    expect(output.status).toBe("ok");
    expect(output.results[0].patternId).toBe("pat-expenses");
    expect(output.results[0].argumentType).toBeUndefined();
    expect(output.results[0].resultType).toBeUndefined();
  });

  it("refuses a search that names neither tags nor text", async () => {
    const index = stubIndex([]);
    const result = await createEngine(index).invokeBuiltinTool(
      "search_patterns",
      {},
    );
    const output = result.output as SearchPatternsToolErrorOutput;
    expect(output.status).toBe("error");
    expect(output.message).toContain("requires tags, text, or both");
  });

  it("refuses when the run has no pattern index configured", async () => {
    const result = await createEngine().invokeBuiltinTool("search_patterns", {
      tags: ["expenses"],
    });
    const output = result.output as SearchPatternsToolErrorOutput;
    expect(output.status).toBe("error");
    expect(output.message).toContain("--pattern-index-url");
  });

  it("declares itself a read, since a search alters nothing", () => {
    expect(searchPatternsTool.descriptor.effectClass).toBe("read");
  });

  it("reports what the index answered when a search fails", async () => {
    const failing: HarnessFetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }),
      );
    const result = await createEngine({ fetchFn: failing, calls: [] })
      .invokeBuiltinTool("search_patterns", { tags: ["expenses"] });
    const output = result.output as SearchPatternsToolErrorOutput;
    expect(output.status).toBe("error");
    expect(output.message).toContain("403");
    // The service body ("forbidden") stays off the model-facing message.
    expect(output.message).toContain("searchPatterns failed (403)");
    expect(output.message).not.toContain("forbidden");
  });
});
