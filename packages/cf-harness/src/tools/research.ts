/**
 * The `research` tool: bounded Common Fabric documentation, skill, published
 * pattern, source, dependency, and handle-contract research performed by a
 * cheap private model loop on the trusted host.
 */

import type { JSONSchema } from "@commonfabric/api";

import {
  HARNESS_RESEARCH_RUN_TYPE,
  type HarnessResearchKit,
  type HarnessResearchRunSummary,
} from "../contracts/research.ts";
import type { HarnessToolDescriptor } from "../contracts/tool-descriptor.ts";
import {
  HarnessResearchError,
  type HarnessResearchRecord,
} from "../research/runner.ts";
import { describeHandleTool } from "./describe-handle.ts";
import type { HarnessToolDefinition } from "./types.ts";

/** Whole task or focused follow-up the private loop investigates. */
export interface ResearchToolInput {
  /** Common Fabric task, question, or implementation uncertainty. */
  task: string;
}

/** Successful bounded research, including the artifact-only derivation. */
export interface ResearchToolSuccessOutput {
  /** Stable id for the persisted tool output. */
  outputId: string;

  /** Success means the loop returned a kit; the kit may still be incomplete. */
  status: "ok";

  /** Host-admitted implementation kit given to the caller. */
  kit: HarnessResearchKit;

  /** How the caller must treat the kit's admission status. */
  guidance: string;

  /**
   * Full private transcript and exact read contents. The prompt loop strips
   * this field before the outer model sees the tool result.
   */
  researchRecord: HarnessResearchRecord;
}

/** Recoverable failure the caller can react to in its next turn. */
export interface ResearchToolErrorOutput {
  /** Stable id for the persisted tool output. */
  outputId: string;

  /** Error discriminator. */
  status: "error";

  /** Stable, source-free explanation of what prevented a kit. */
  message: string;

  /** Partial private trace retained on failures that reached the loop. */
  researchRecord?: HarnessResearchRecord;
}

/** Every result shape of the `research` builtin. */
export type ResearchToolOutput =
  | ResearchToolSuccessOutput
  | ResearchToolErrorOutput;

/** Public model contract of the Common Fabric research capability. */
export const researchToolDescriptor: HarnessToolDescriptor = {
  toolId: "research",
  title: "Research Common Fabric",
  description:
    "Research a whole Common Fabric implementation task or a focused follow-up across the operator-provisioned CF docs and skills, the published pattern index, exact multi-file pattern source and dependencies, and the safe shape of available handles. A bounded cheap-model loop performs iterative search and exact reads on the trusted host, then returns a cited implementation kit with verified pattern ids/imports/contracts, a complete direct-run or composition example when applicable, API rules, verification steps, and explicit missing inputs. This is not web research. Indexed source remains in the research artifact; only the derived kit reaches your context.",
  effectClass: "read",
  inputSchema: {
    type: "object",
    properties: {
      task: {
        type: "string",
        minLength: 3,
        maxLength: 20_000,
        description:
          "The whole implementation task, or a focused follow-up that names what remains uncertain.",
      },
    },
    required: ["task"],
    additionalProperties: false,
  } satisfies JSONSchema,
  outputSchema: {
    oneOf: [{
      type: "object",
      properties: {
        outputId: { type: "string" },
        status: { type: "string", enum: ["ok"] },
        kit: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["complete", "incomplete"] },
            task: { type: "string" },
            summary: { type: "string" },
            recommendation: {
              type: "object",
              properties: {
                kind: {
                  type: "string",
                  enum: [
                    "direct-run",
                    "compose",
                    "author",
                    "focused-api",
                  ],
                },
                rationale: { type: "string" },
              },
              required: ["kind", "rationale"],
              additionalProperties: false,
            },
            inputs: { type: "array", items: { type: "object" } },
            patterns: { type: "array", items: { type: "object" } },
            steps: { type: "array", items: { type: "string" } },
            example: {
              type: "object",
              properties: {
                kind: {
                  type: "string",
                  enum: ["run-pattern-input", "pattern-source"],
                },
                content: { type: "string" },
                sourceIds: {
                  type: "array",
                  items: { type: "string" },
                },
              },
              required: ["kind", "content", "sourceIds"],
              additionalProperties: false,
            },
            rules: { type: "array", items: { type: "object" } },
            verification: { type: "array", items: { type: "string" } },
            sources: { type: "array", items: { type: "object" } },
            missing: { type: "array", items: { type: "string" } },
          },
          required: [
            "status",
            "task",
            "summary",
            "recommendation",
            "inputs",
            "patterns",
            "steps",
            "rules",
            "verification",
            "sources",
            "missing",
          ],
          additionalProperties: false,
        },
        researchRecord: { type: "object" },
        guidance: { type: "string" },
      },
      required: ["outputId", "status", "kit", "guidance", "researchRecord"],
      additionalProperties: false,
    }, {
      type: "object",
      properties: {
        outputId: { type: "string" },
        status: { type: "string", enum: ["error"] },
        message: { type: "string" },
        researchRecord: { type: "object" },
      },
      required: ["outputId", "status", "message"],
      additionalProperties: false,
    }],
  } satisfies JSONSchema,
  tags: ["fabric", "docs", "skills", "patterns", "research"],
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Narrows a raw tool result to a successful research response. */
export const isResearchToolSuccessOutput = (
  output: unknown,
): output is ResearchToolSuccessOutput => {
  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    return false;
  }
  const record = output as Record<string, unknown>;
  return record.status === "ok" && typeof record.outputId === "string" &&
    typeof record.kit === "object" && record.kit !== null &&
    typeof record.guidance === "string" &&
    typeof record.researchRecord === "object" &&
    record.researchRecord !== null;
};

/** Registered implementation of the `research` builtin. */
export const researchTool: HarnessToolDefinition<
  ResearchToolInput,
  ResearchToolOutput
> = {
  descriptor: researchToolDescriptor,
  async invoke(context, input) {
    const outputId = context.nextOutputId("research");
    const errorOutput = (message: string): ResearchToolErrorOutput => ({
      outputId,
      status: "error",
      message,
    });
    if (context.runResearch === undefined) {
      return errorOutput("research requires the host research runner");
    }
    try {
      const corpus = context.getDocsCorpus === undefined
        ? undefined
        : await context.getDocsCorpus();
      const generalTokens = (context.handleTable?.entries ?? [])
        .filter((entry) => entry.capability === undefined)
        .map((entry) => entry.token);
      const reply = await context.runResearch({
        task: input.task,
        researchRunId: outputId,
        ...(corpus !== undefined ? { corpus } : {}),
        ...(context.getPatternIndexClient !== undefined
          ? { getPatternIndex: context.getPatternIndexClient }
          : {}),
        handleTokens: generalTokens,
        describeHandle: async (token) =>
          await describeHandleTool.invoke(context, { token }),
        priorResearchRuns: context.researchRuns ?? [],
        ...(context.signal !== undefined ? { signal: context.signal } : {}),
      });
      const summary: HarnessResearchRunSummary = {
        type: HARNESS_RESEARCH_RUN_TYPE,
        researchRunId: outputId,
        outputId,
        kit: structuredClone(reply.kit),
        confirmedPatterns: reply.record.confirmedPatterns.map((record) =>
          structuredClone(record)
        ),
        describedHandles: reply.record.describedHandles.map((record) =>
          structuredClone(record)
        ),
        completedAt: context.now(),
      };
      await context.recordResearchRun?.(summary);
      return {
        outputId,
        status: "ok",
        kit: reply.kit,
        guidance: reply.kit.status === "complete"
          ? "This kit passed host admission. Preserve its cited contracts and still run the listed verification."
          : "This kit is incomplete. Do not present or implement it as complete; resolve every item under kit.missing with focused research or report the unresolved limitation.",
        researchRecord: reply.record,
      };
    } catch (error) {
      await context.recordResearchFailure?.();
      return {
        ...errorOutput(`research failed: ${errorMessage(error)}`),
        ...(error instanceof HarnessResearchError
          ? { researchRecord: error.record }
          : {}),
      };
    }
  },
};
