/**
 * The `research` tool: bounded Common Fabric documentation, skill, published
 * pattern, source, dependency, and handle-contract research performed by a
 * cheap private model loop on the trusted host.
 */

import type { JSONSchema } from "@commonfabric/api";
import {
  RESEARCH_CFC_SCHEMA,
  RESEARCH_KIT_SCHEMA,
} from "../contracts/research-schema.ts";

import {
  HARNESS_RESEARCH_RUN_TYPE,
  type HarnessResearchCfcProjection,
  type HarnessResearchKit,
  type HarnessResearchRunSummary,
} from "../contracts/research.ts";
import type { HarnessToolDescriptor } from "../contracts/tool-descriptor.ts";
import { errorMessage } from "../error-message.ts";
import {
  createHarnessResearchCfcProjection,
  HarnessResearchError,
  type HarnessResearchRecord,
} from "../research/runner.ts";
import { describeHandleForResearch } from "./describe-handle.ts";
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

  /** Known source labels and explicit CFC metadata gaps for this result. */
  cfc: HarnessResearchCfcProjection;

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

  /** Known source labels and explicit CFC metadata gaps before failure. */
  cfc: HarnessResearchCfcProjection;

  /** Exact failure text retained only in the persisted tool artifact. */
  rawCauseMessage?: string;

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
        kit: RESEARCH_KIT_SCHEMA,
        researchRecord: { type: "object" },
        guidance: { type: "string" },
        cfc: RESEARCH_CFC_SCHEMA,
      },
      required: [
        "outputId",
        "status",
        "kit",
        "guidance",
        "cfc",
        "researchRecord",
      ],
      additionalProperties: false,
    }, {
      type: "object",
      properties: {
        outputId: { type: "string" },
        status: { type: "string", enum: ["error"] },
        message: { type: "string" },
        cfc: RESEARCH_CFC_SCHEMA,
        rawCauseMessage: { type: "string" },
        researchRecord: { type: "object" },
      },
      required: ["outputId", "status", "message", "cfc"],
      additionalProperties: false,
    }],
  } satisfies JSONSchema,
  tags: ["fabric", "docs", "skills", "patterns", "research"],
};

/** Stable model-facing explanation for an internal research failure. */
const RESEARCH_FAILURE_MESSAGE =
  "research failed before returning an implementation kit";

/** Caller guidance derived from the host-admitted kit status. */
export const researchKitGuidance = (kit: HarnessResearchKit): string =>
  kit.status === "complete"
    ? "This kit passed host admission. Preserve its cited contracts and still run the listed verification."
    : kit.example?.kind === "pattern-source" &&
        kit.example.syntax?.status === "invalid"
    ? "This kit retains its cited evidence and complete source, but the source has the exact TypeScript syntax errors listed under kit.example.syntax.diagnostics. Correct those errors locally without repeating research, then resolve any other item under kit.missing before presenting or implementing the kit as complete. Syntax acceptance alone will not establish its imports, types, compilation, or runtime behavior."
    : "This kit is incomplete. Do not present or implement it as complete. Correct local recipe errors directly; use focused research for missing evidence and report any unresolved limitation.";

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
    typeof record.cfc === "object" && record.cfc !== null &&
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
    const initialCfc = createHarnessResearchCfcProjection([
      context.researchTaskCfcLabel,
    ]);
    const errorOutput = (message: string): ResearchToolErrorOutput => ({
      outputId,
      status: "error",
      message,
      cfc: initialCfc,
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
          await describeHandleForResearch(context, { token }),
        ...(context.researchTaskCfcLabel !== undefined
          ? { taskCfcLabel: context.researchTaskCfcLabel }
          : {}),
        priorResearchRuns: context.researchRuns ?? [],
        attachedPatterns: (context.patternRefs ?? []).map((ref) => ref.record),
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
        cfc: structuredClone(reply.record.cfc),
        completedAt: context.now(),
      };
      await context.recordResearchRun?.(summary);
      return {
        outputId,
        status: "ok",
        kit: reply.kit,
        guidance: researchKitGuidance(reply.kit),
        cfc: reply.record.cfc,
        researchRecord: reply.record,
      };
    } catch (error) {
      await context.recordResearchFailure?.();
      return {
        ...errorOutput(RESEARCH_FAILURE_MESSAGE),
        rawCauseMessage: errorMessage(error),
        ...(error instanceof HarnessResearchError
          ? { cfc: error.record.cfc, researchRecord: error.record }
          : {}),
      };
    }
  },
};
