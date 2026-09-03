/**
 * The model-facing documentation query tool: what it hands the explore
 * profile, what it hands back, and the endorsement that decides which text is
 * eligible for an answer.
 */

import { expect } from "@std/expect";
import { join, normalize } from "@std/path/posix";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { CfHarnessEngine } from "../src/engine.ts";
import { checkoutDocsCorpusRoots } from "../src/docs-corpus/corpus.ts";
import { parentToolIdsForBacking } from "../src/contracts/tool-descriptor.ts";
import {
  createHarnessRunState,
  type HarnessRunState,
} from "../src/run-state.ts";
import {
  CFC_HARNESS_ATOM_CLASS,
  isOperatorProvisionedReferenceAtom,
} from "../src/contracts/docs-corpus.ts";
import {
  EXPLORE_SUBAGENT_PROFILE_CONFIG,
  MAX_EXPLORE_ANSWER_LENGTH,
  PATTERN_AUTHOR_SUBAGENT_ALLOWED_TOOL_IDS,
} from "../src/contracts/subagent.ts";
import type {
  HarnessExploreQueryReply,
  HarnessExploreQueryRequest,
} from "../src/docs-corpus/explore.ts";
import {
  createExploreQueryRunner,
  readExploreQueryReply,
} from "../src/docs-corpus/explore.ts";
import type {
  HarnessModelAttemptDiagnostic,
  HarnessModelUsage,
} from "../src/model/client.ts";
import { queryDocsToolDescriptor } from "../src/tools/query-docs.ts";
import type {
  QueryDocsToolAnswerOutput,
  QueryDocsToolErrorOutput,
} from "../src/tools/query-docs.ts";
import type {
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxRuntime,
  SandboxRuntimeDescription,
  SandboxShellRequest,
} from "../src/sandbox/types.ts";

class FakeSandboxRuntime implements SandboxRuntime {
  describe(): SandboxRuntimeDescription {
    return {
      kind: "docker-runsc-cfc",
      defaultWorkingDirectory: this.defaultWorkingDirectory(),
      cfc: { runtimeRequested: true, workspaceMountPath: "/workspace" },
    };
  }

  resolvePath(path: string, cwd = this.defaultWorkingDirectory()): string {
    return normalize(path.startsWith("/") ? path : join(cwd, path));
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

const GLAZING_DOC = [
  "# Glazing",
  "",
  "Dip the donut once and let it drain.",
  "",
  "# Frying",
  "",
  "Hold the fryer at 190 degrees.",
  "",
].join("\n");

const SENT = {
  model: "stub-explore-model",
  messages: [
    { role: "system" as const, content: "explore system prompt" },
    { role: "user" as const, content: "explore user prompt" },
  ],
};

describe("query-docs", () => {
  let root: string;
  let requests: HarnessExploreQueryRequest[];

  beforeEach(async () => {
    root = await Deno.makeTempDir({ prefix: "cf-harness-query-docs-" });
    await Deno.writeTextFile(`${root}/glazing.md`, GLAZING_DOC);
    requests = [];
  });

  afterEach(async () => {
    await Deno.remove(root, { recursive: true });
  });

  const createEngine = (
    options: {
      corpus?: boolean;
      reply?: (
        request: HarnessExploreQueryRequest,
      ) => Omit<HarnessExploreQueryReply, "sent">;
    } = {},
  ): CfHarnessEngine => {
    const engine = new CfHarnessEngine({
      sandboxRuntime: new FakeSandboxRuntime(),
      runId: `query-docs-test-${crypto.randomUUID()}`,
      cfcEnforcementMode: "disabled",
      // A run wanting no corpus says so; the checkout the tests run out of
      // would otherwise supply the default.
      ...(options.corpus === false
        ? {
          docsCorpus: {
            type: "cf-harness.docs-corpus-record" as const,
            source: "configured" as const,
            roots: [],
          },
        }
        : {
          docsCorpus: {
            type: "cf-harness.docs-corpus-record" as const,
            source: "configured" as const,
            roots: [root],
          },
        }),
    });
    if (options.reply !== undefined) {
      const reply = options.reply;
      engine.setExploreQueryRunner((request) => {
        requests.push(request);
        return Promise.resolve({ ...reply(request), sent: SENT });
      });
    }
    return engine;
  };

  describe("the descriptor", () => {
    it("returns a read-effect tool taking a question and nothing else", () => {
      expect(queryDocsToolDescriptor.effectClass).toBe("read");
      const schema = queryDocsToolDescriptor.inputSchema as {
        required: readonly string[];
        additionalProperties: boolean;
        properties: Record<string, unknown>;
      };
      expect(schema.required).toEqual(["question"]);
      expect(schema.additionalProperties).toBe(false);
      expect(Object.keys(schema.properties).sort()).toEqual([
        "maxCitations",
        "question",
      ]);
    });
  });

  describe("invoking it", () => {
    it("returns the explore answer, its citations, and the endorsement", async () => {
      const engine = createEngine({
        reply: (request) => ({
          answer: "Dip the donut once.",
          citations: [{
            path: request.sections[0].path,
            heading: request.sections[0].heading,
          }],
        }),
      });

      const result = await engine.invokeBuiltinTool("query_docs", {
        question: "how do I do glazing?",
      });
      const output = result.output as QueryDocsToolAnswerOutput;

      expect(output.status).toBe("ok");
      expect(output.answer).toBe("Dip the donut once.");
      expect(output.citations[0].heading).toBe("Glazing");
      expect(output.provenance.integrity).toEqual([
        CFC_HARNESS_ATOM_CLASS.OperatorProvisionedReference,
      ]);
      expect(output.searched.readSections).toBe(requests[0].sections.length);
    });

    it("hands the explore profile only endorsed sections", async () => {
      const engine = createEngine({
        reply: () => ({ answer: "Dip once.", citations: [] }),
      });

      await engine.invokeBuiltinTool("query_docs", {
        question: "glazing",
      });

      expect(requests).toHaveLength(1);
      expect(requests[0].sections.length).toBeGreaterThan(0);
      expect(
        requests[0].sections.every((section) =>
          section.integrity.some(isOperatorProvisionedReferenceAtom)
        ),
      ).toBe(true);
    });

    it("returns a citation carrying a path and a heading and no text", async () => {
      const engine = createEngine({
        reply: (request) => ({
          answer: "Dip the donut once.",
          citations: [{
            path: request.sections[0].path,
            heading: request.sections[0].heading,
          }],
        }),
      });

      const result = await engine.invokeBuiltinTool("query_docs", {
        question: "glazing",
      });
      const output = result.output as QueryDocsToolAnswerOutput;

      expect(Object.keys(output.citations[0]).sort()).toEqual([
        "heading",
        "path",
      ]);
    });

    it("returns no citation for a section the corpus does not hold", async () => {
      const engine = createEngine({
        reply: () => ({
          answer: "Read the fryer manual.",
          citations: [{ path: "invented/manual.md", heading: "Fryers" }],
        }),
      });

      const result = await engine.invokeBuiltinTool("query_docs", {
        question: "glazing",
      });
      const output = result.output as QueryDocsToolAnswerOutput;

      expect(output.citations).toEqual([]);
    });

    it("answers without calling the model when nothing matches", async () => {
      const engine = createEngine({
        reply: () => ({ answer: "unreached", citations: [] }),
      });

      const result = await engine.invokeBuiltinTool("query_docs", {
        question: "sourdough starter hydration",
      });
      const output = result.output as QueryDocsToolAnswerOutput;

      expect(requests).toEqual([]);
      expect(output.status).toBe("ok");
      expect(output.provenance.integrity).toEqual([]);
      expect(output.searched.readSections).toBe(0);
    });

    it("reports a failed explore turn as a tool error", async () => {
      const engine = createEngine();
      engine.setExploreQueryRunner(() =>
        Promise.reject(new Error("model unavailable"))
      );

      const result = await engine.invokeBuiltinTool("query_docs", {
        question: "glazing",
      });
      const output = result.output as QueryDocsToolErrorOutput;

      expect(output.status).toBe("error");
      expect(output.message).toContain("model unavailable");
    });

    it("records the sections it sent, with their endorsement atoms", async () => {
      const engine = createEngine({
        reply: () => ({ answer: "Dip once.", citations: [] }),
      });

      const result = await engine.invokeBuiltinTool("query_docs", {
        question: "glazing",
      });
      const output = result.output as QueryDocsToolAnswerOutput;
      const record = output.exploreRecord;

      expect(record?.model).toBe(SENT.model);
      expect(record?.question).toBe("glazing");
      expect(record?.sections[0].integrity).toEqual([
        CFC_HARNESS_ATOM_CLASS.OperatorProvisionedReference,
      ]);
      expect(record?.messages.map((message) => message.content)).toEqual(
        SENT.messages.map((message) => message.content),
      );
    });

    it("records no explore turn for an answer no turn was spent on", async () => {
      const engine = createEngine({
        reply: () => ({ answer: "unreached", citations: [] }),
      });

      const result = await engine.invokeBuiltinTool("query_docs", {
        question: "sourdough starter hydration",
      });
      const output = result.output as QueryDocsToolAnswerOutput;

      expect(output.exploreRecord).toBeUndefined();
    });

    it("refuses when the run configures no corpus root", async () => {
      const engine = createEngine({ corpus: false });

      const result = await engine.invokeBuiltinTool("query_docs", {
        question: "glazing",
      });
      const output = result.output as QueryDocsToolErrorOutput;

      expect(engine.docsCorpusAvailable).toBe(false);
      expect(output.status).toBe("error");
      expect(output.message).toContain("--docs-corpus-root");
    });
  });

  describe("the bounded reply", () => {
    const sections = [{
      path: "docs/glazing.md",
      heading: "Glazing",
      text: "Dip once.",
      integrity: [],
    }];

    it("returns an over-long answer clipped to the profile's bound", () => {
      const reply = readExploreQueryReply(
        JSON.stringify({ answer: "x".repeat(9_000), citations: [] }),
        sections,
        SENT,
      );

      expect(reply.answer).toHaveLength(MAX_EXPLORE_ANSWER_LENGTH);
    });

    it("throws for a reply that is not JSON", () => {
      expect(() => readExploreQueryReply("Sorry, I cannot.", sections, SENT))
        .toThrow("not valid JSON");
    });
  });

  describe("createExploreQueryRunner()", () => {
    it("returns the reply and reports the turn's attempt and usage", async () => {
      const attempts: string[] = [];
      const usage: HarnessModelUsage[] = [];
      const runner = createExploreQueryRunner({
        modelClient: {
          providerId: "stub",
          complete: (request) => {
            request.onAttempt?.(
              { operation: "responses" } as HarnessModelAttemptDiagnostic,
            );
            return Promise.resolve({
              assistant: {
                role: "assistant",
                content: JSON.stringify({
                  answer: "Dip once.",
                  citations: [{ path: "docs/glazing.md", heading: "Glazing" }],
                }),
              },
              usage: { totalTokens: 41 },
            });
          },
        },
        runId: "explore-runner-test",
        onAttempt: (attempt) => {
          attempts.push(attempt.operation);
        },
        onUsage: (turnUsage) => {
          usage.push(turnUsage);
        },
      });

      const reply = await runner({
        question: "glazing",
        sections: [{
          path: "docs/glazing.md",
          heading: "Glazing",
          text: "Dip once.",
          integrity: [],
        }],
      });

      expect(reply.answer).toBe("Dip once.");
      expect(reply.citations).toEqual([{
        path: "docs/glazing.md",
        heading: "Glazing",
      }]);
      expect(attempts).toEqual(["responses"]);
      expect(usage).toEqual([{ totalTokens: 41 }]);
      expect(reply.sent.messages.map((message) => message.role)).toEqual([
        "system",
        "user",
      ]);
      expect(reply.sent.messages[1].content).toContain("docs/glazing.md");
    });
  });

  describe("a run started from a checkout with no documentation flags", () => {
    // The engine is constructed the way a bare `deno task run` constructs one:
    // no docs options at all. What this pins is that the surface advertising
    // the tool and the engine backing it reach the same corpus.

    it("answers query_docs out of the checkout's own reference trees", async () => {
      const engine = new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime(),
        runId: `query-docs-default-${crypto.randomUUID()}`,
        cfcEnforcementMode: "disabled",
      });
      engine.setExploreQueryRunner((request) =>
        Promise.resolve({
          answer: "Answered from the checkout.",
          citations: request.sections.slice(0, 1).map((section) => ({
            path: section.path,
            heading: section.heading,
          })),
          sent: SENT,
        })
      );

      expect(engine.docsCorpusAvailable).toBe(true);
      expect(engine.docsCorpus?.source).toBe("checkout-default");
      expect(engine.docsCorpus?.roots).toEqual(checkoutDocsCorpusRoots());
      const corpus = await engine.getDocsCorpus();
      expect(corpus.files).toBeGreaterThan(0);

      const result = await engine.invokeBuiltinTool("query_docs", {
        question: "what does a pattern handler do?",
      });
      const output = result.output as QueryDocsToolAnswerOutput;
      expect(output.status).toBe("ok");
      expect(output.answer).toBe("Answered from the checkout.");
      expect(output.citations.length).toBeGreaterThan(0);
    });

    it("offers query_docs on the parent tool surface", () => {
      expect(parentToolIdsForBacking({
        fabricSessionAvailable: false,
        patternIndexAvailable: false,
        skillsShSearchAvailable: false,
        skillsShAcquisitionAvailable: false,
        skillRegistryAvailable: false,
        docsCorpusAvailable: true,
      })).toContain("query_docs");
    });

    it("records the resolved corpus in run state", () => {
      const engine = new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime(),
        runId: `query-docs-record-${crypto.randomUUID()}`,
        cfcEnforcementMode: "disabled",
      });

      expect(engine.getRunState().docsCorpus).toEqual({
        type: "cf-harness.docs-corpus-record",
        source: "checkout-default",
        roots: checkoutDocsCorpusRoots(),
      });
    });
  });

  describe("a resumed run", () => {
    const recorded = {
      type: "cf-harness.docs-corpus-record" as const,
      source: "configured" as const,
      roots: ["/host/recorded-reference"],
    };

    const resumedEngine = (runState: Record<string, unknown>) =>
      new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime(),
        cfcEnforcementMode: "disabled",
        runState: {
          ...createHarnessRunState({
            runId: "run-resumed",
            cfcEnforcementMode: "disabled",
            currentDir: "/workspace",
          }),
          ...runState,
        } as HarnessRunState,
      });

    it("answers out of the corpus the run recorded, not this process's default", () => {
      const engine = resumedEngine({ docsCorpus: recorded });

      expect(engine.docsCorpus).toEqual(recorded);
      expect(engine.docsCorpusAvailable).toBe(true);
    });

    it("keeps query_docs absent for a run that recorded no corpus", () => {
      const engine = resumedEngine({
        docsCorpus: {
          type: "cf-harness.docs-corpus-record",
          source: "configured",
          roots: [],
        },
      });

      expect(engine.docsCorpusAvailable).toBe(false);
    });
  });

  describe("the surfaces that offer it", () => {
    it("is on the `pattern-author` tool surface", () => {
      expect(PATTERN_AUTHOR_SUBAGENT_ALLOWED_TOOL_IDS).toContain("query_docs");
    });

    it("runs an `explore` profile with no tools at all", () => {
      expect(EXPLORE_SUBAGENT_PROFILE_CONFIG.allowedToolIds).toEqual([]);
      expect(EXPLORE_SUBAGENT_PROFILE_CONFIG.hostToolIds).toEqual([]);
      expect(EXPLORE_SUBAGENT_PROFILE_CONFIG.returnContractAuthority).toBe(
        "profile",
      );
    });
  });
});
