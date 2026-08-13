import type { JSONSchema } from "@commonfabric/api";
import { matchLLMFriendlyLink } from "@commonfabric/runner";
import {
  createLLMFriendlyLink,
  parseLLMFriendlyLink,
} from "@commonfabric/runner/shared";
import {
  join as joinHostPath,
  normalize as normalizeHostPath,
} from "@std/path";
import type { HarnessToolDescriptor } from "../contracts/tool-descriptor.ts";
import { defineOwnEntry } from "../handle-table.ts";
import {
  parseStructuredResultSchema,
  validateAndSanitizeStructuredResult,
} from "../structured-result.ts";
import type { HarnessToolDefinition } from "./types.ts";

export interface RunPatternToolInput {
  sourceText?: string;
  sourcePath?: string;
  inputs?: Record<string, unknown>;
  resultSchema?: JSONSchema;
}

export interface RunPatternToolSuccessOutput {
  outputId: string;
  status: "ok";
  /** Canonical LLM-friendly link to the piece's result cell. */
  resultRef: string;
  /**
   * Piece id for the persisted tool-output artifact. A bare fabric
   * identifier the handle boundary never swaps, and the piece cell is the
   * result cell, so the prompt loop strips it from the model-facing
   * rendering; only `resultRef` reaches model context.
   */
  pieceId: string;
  /** Sanitized result value; present only when `resultSchema` was given. */
  value?: unknown;
  linkedStringCount?: number;
  /** Why `value` is absent despite a `resultSchema`: the raw result did not
   * match the schema. */
  valueError?: string;
  /**
   * Raw result value for the persisted tool-output artifact. Stripped from
   * the model-facing rendering by the prompt loop, so only the sanitized
   * `value` reaches model context.
   */
  rawValue?: unknown;
}

export interface RunPatternToolErrorOutput {
  outputId: string;
  status: "compile-error" | "error";
  message: string;
}

export type RunPatternToolOutput =
  | RunPatternToolSuccessOutput
  | RunPatternToolErrorOutput;

export const isRunPatternToolSuccessOutput = (
  output: unknown,
): output is RunPatternToolSuccessOutput =>
  typeof output === "object" && output !== null &&
  "status" in output && output.status === "ok" &&
  "resultRef" in output && typeof output.resultRef === "string";

export const runPatternToolDescriptor: HarnessToolDescriptor = {
  toolId: "run_pattern",
  title: "Run Pattern",
  description:
    "Compile and run a Common Fabric pattern in the configured space, returning a reference to its live result cell. The piece is not registered in the space's piece list.",
  effectClass: "side-effect",
  inputSchema: {
    type: "object",
    properties: {
      sourceText: {
        type: "string",
        description:
          "Pattern source (TypeScript/TSX). Exactly one of sourceText and sourcePath must be given.",
      },
      sourcePath: {
        type: "string",
        description:
          "Workspace-relative path to a pattern source file. Exactly one of sourceText and sourcePath must be given.",
      },
      inputs: {
        type: "object",
        additionalProperties: true,
        description:
          'Input values for the pattern. A string value that is a whole-string LLM-friendly link (e.g. "/of:fid1:abc.../path") is passed as a live cell reference; everything else passes through as plain JSON.',
      },
      resultSchema: {
        anyOf: [
          { type: "boolean" },
          { type: "object", additionalProperties: true },
        ],
        description:
          "Optional JSON Schema for the result value. When provided, the sanitized result value is returned alongside resultRef.",
      },
    },
    additionalProperties: false,
  } satisfies JSONSchema,
  outputSchema: {
    oneOf: [{
      type: "object",
      properties: {
        outputId: { type: "string" },
        status: { type: "string", enum: ["ok"] },
        resultRef: { type: "string" },
        pieceId: { type: "string" },
        value: {},
        linkedStringCount: { type: "integer", minimum: 0 },
        valueError: { type: "string" },
      },
      required: ["outputId", "status", "resultRef", "pieceId"],
      additionalProperties: false,
    }, {
      type: "object",
      properties: {
        outputId: { type: "string" },
        status: { type: "string", enum: ["compile-error", "error"] },
        message: { type: "string" },
      },
      required: ["outputId", "status", "message"],
      additionalProperties: false,
    }],
  } satisfies JSONSchema,
  tags: ["fabric", "pattern", "piece"],
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * A raw result may hold values `JSON.stringify` cannot carry into the
 * tool-output artifact (a cycle through the reactive graph, say), so the
 * round trip both proves serializability and normalizes cells to their
 * serialized link form. Returns `undefined` when the value does not
 * serialize.
 */
const asSerializableValue = (value: unknown): unknown => {
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? undefined : JSON.parse(encoded);
  } catch {
    return undefined;
  }
};

export const runPatternTool: HarnessToolDefinition<
  RunPatternToolInput,
  RunPatternToolOutput
> = {
  descriptor: runPatternToolDescriptor,
  async invoke(context, input) {
    const outputId = context.nextOutputId("run_pattern");
    const errorOutput = (
      status: RunPatternToolErrorOutput["status"],
      message: string,
    ): RunPatternToolErrorOutput => ({ outputId, status, message });
    if (context.getFabricSession === undefined) {
      return errorOutput(
        "error",
        "run_pattern requires a fabric session; configure --fabric-api-url, --fabric-identity, and --fabric-space",
      );
    }
    if (
      (input.sourceText === undefined) === (input.sourcePath === undefined)
    ) {
      return errorOutput(
        "error",
        "run_pattern requires exactly one of sourceText and sourcePath",
      );
    }
    let parsedResultSchema;
    try {
      parsedResultSchema = parseStructuredResultSchema(input.resultSchema, {
        label: "run_pattern resultSchema",
      });
    } catch (error) {
      return errorOutput("error", errorMessage(error));
    }
    let sourceText: string;
    if (input.sourcePath !== undefined) {
      const workspaceRoot = context.workspaceHostPath;
      if (workspaceRoot === undefined) {
        return errorOutput(
          "error",
          "run_pattern sourcePath requires a workspace",
        );
      }
      const resolved = normalizeHostPath(
        joinHostPath(workspaceRoot, input.sourcePath),
      );
      if (!await context.isHostPathWithinWorkspace(resolved)) {
        return errorOutput(
          "error",
          `run_pattern sourcePath resolves outside the workspace: ${input.sourcePath}`,
        );
      }
      try {
        sourceText = await Deno.readTextFile(resolved);
      } catch (error) {
        return errorOutput(
          "error",
          `run_pattern could not read sourcePath ${input.sourcePath}: ${
            errorMessage(error)
          }`,
        );
      }
    } else {
      sourceText = input.sourceText!;
    }
    let session;
    try {
      session = await context.getFabricSession();
    } catch (error) {
      return errorOutput(
        "error",
        `fabric session unavailable: ${errorMessage(error)}`,
      );
    }
    const { pieces } = session;
    const space = pieces.getSpace();
    // Whole-string LLM-friendly links become live cell references; the
    // prompt loop has already resolved any handle tokens, so the strings
    // seen here carry canonical addresses. Non-link strings and non-strings
    // pass through as plain JSON.
    let pieceInput: Record<string, unknown> | undefined;
    if (input.inputs !== undefined) {
      const converted: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(input.inputs)) {
        let entry = value;
        if (
          typeof value === "string" && matchLLMFriendlyLink.test(value.trim())
        ) {
          try {
            entry = pieces.runtime.getCellFromLink(
              parseLLMFriendlyLink(value, space),
            );
          } catch {
            // Not a parseable link after all — keep the plain string.
          }
        }
        defineOwnEntry(converted, key, entry);
      }
      pieceInput = converted;
    }
    let piece;
    try {
      // Deliberately unregistered: no `pieces.add()` and no default-pattern
      // touch, so the piece never appears in the space's piece list. The
      // origin must be URL-shaped or the piece renders as detached.
      piece = await pieces.create(sourceText, {
        ...(pieceInput !== undefined ? { input: pieceInput } : {}),
        start: true,
        origin: `https://cf-harness.invalid/run/${context.runId}`,
      });
    } catch (error) {
      // Compiler diagnostics are the model's feedback loop, so the raw
      // message goes back unredacted.
      return errorOutput("compile-error", errorMessage(error));
    }
    await pieces.runtime.settled();
    await pieces.synced();
    const resultCell = await piece.result.getCell();
    const resultRef = createLLMFriendlyLink(
      resultCell.getAsNormalizedFullLink(),
      space,
    );
    const rawValue = asSerializableValue(await piece.result.get());
    let value: unknown;
    let linkedStringCount: number | undefined;
    let valueError: string | undefined;
    if (parsedResultSchema !== undefined) {
      try {
        const sanitized = validateAndSanitizeStructuredResult({
          schema: parsedResultSchema.schema,
          value: rawValue,
          opaqueHandleId: outputId,
        });
        value = sanitized.value;
        linkedStringCount = sanitized.linkedStringCount;
      } catch (error) {
        valueError = errorMessage(error);
      }
    }
    return {
      outputId,
      status: "ok",
      resultRef,
      pieceId: piece.id,
      ...(value !== undefined ? { value } : {}),
      ...(linkedStringCount !== undefined ? { linkedStringCount } : {}),
      ...(valueError !== undefined ? { valueError } : {}),
      ...(rawValue !== undefined ? { rawValue } : {}),
    };
  },
};
