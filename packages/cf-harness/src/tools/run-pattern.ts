import type { JSONSchema } from "@commonfabric/api";
import { type Cell, compileAndSavePattern } from "@commonfabric/runner";
import { validateAgainstSchema } from "@commonfabric/runner/cfc";
import {
  createLLMFriendlyLink,
  matchLLMFriendlyLink,
  parseLLMFriendlyLink,
} from "@commonfabric/runner/shared";
import { PieceController } from "@commonfabric/piece/ops";
import type { HarnessToolDescriptor } from "../contracts/tool-descriptor.ts";
import { defineOwnEntry } from "../handle-table.ts";
import {
  parseStructuredResultSchema,
  validateAndSanitizeStructuredResult,
} from "../structured-result.ts";
import type { HarnessToolDefinition } from "./types.ts";

export interface RunPatternToolInput {
  sourceText?: string;
  inputs?: Record<string, unknown>;
  resultSchema?: JSONSchema;
}

/** Upper bound on `sourceText`, enforced with a structured tool error. */
export const RUN_PATTERN_MAX_SOURCE_TEXT_BYTES = 256 * 1024;

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
  status: "compile-error" | "error" | "cancelled";
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
        description: "Pattern source (TypeScript/TSX). At most 256 KiB.",
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
    required: ["sourceText"],
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
        status: {
          type: "string",
          enum: ["compile-error", "error", "cancelled"],
        },
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
 * Replaces bare fabric identifiers in model-facing diagnostic text with a
 * fixed placeholder. Compiler diagnostics can embed compiler-generated bare
 * tagged hashes (e.g. the `/fid1:.../` virtual module roots), DIDs, and
 * `data:` URIs — none of which the handle boundary swaps, since it only
 * handles the `of:`/`computed:` schemed link forms. A negative lookbehind
 * leaves those schemed forms (and `cfh:` handle tokens) alone: their embedded
 * hash is always preceded by a colon. Raw text stays in the persisted
 * artifact; only the model-facing rendering is scrubbed.
 */
export const scrubBareFabricIdentifiers = (text: string): string =>
  text
    .replaceAll(/\bdata:[^\s"'`)\]}]+/g, "[fabric-id]")
    .replaceAll(/\bdid:[a-z0-9]+:[A-Za-z0-9._%-]+/g, "[fabric-id]")
    .replaceAll(
      /(?<![A-Za-z0-9:])[A-Za-z0-9]+:[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g,
      "[fabric-id]",
    );

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Awaits `work` unless `signal` aborts first. Resolution (not rejection)
 * signals the abort so the losing promise never surfaces as an unhandled
 * rejection; the signal is the only cancellation source — no timeout puts an
 * upper bound on `work` completing.
 */
const raceWithAbort = async (
  work: Promise<void>,
  signal: AbortSignal | undefined,
): Promise<"completed" | "aborted"> => {
  if (signal === undefined) {
    await work;
    return "completed";
  }
  if (signal.aborted) {
    work.catch(() => {});
    return "aborted";
  }
  let onAbort!: () => void;
  const aborted = new Promise<"aborted">((resolve) => {
    onAbort = () => resolve("aborted");
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([
      work.then(() => "completed" as const),
      aborted,
    ]);
  } finally {
    signal.removeEventListener("abort", onAbort);
    work.catch(() => {});
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
    const cancelledOutput = (): RunPatternToolErrorOutput =>
      errorOutput("cancelled", "run_pattern was cancelled");
    if (context.getFabricSession === undefined) {
      return errorOutput(
        "error",
        "run_pattern requires a fabric session; configure --fabric-api-url, --fabric-identity, and --fabric-space",
      );
    }
    if (input.sourceText === undefined) {
      return errorOutput("error", "run_pattern requires sourceText");
    }
    const sourceText = input.sourceText;
    const sourceTextBytes = new TextEncoder().encode(sourceText).length;
    if (sourceTextBytes > RUN_PATTERN_MAX_SOURCE_TEXT_BYTES) {
      return errorOutput(
        "error",
        `run_pattern sourceText exceeds the ${
          RUN_PATTERN_MAX_SOURCE_TEXT_BYTES / 1024
        } KiB limit (${sourceTextBytes} bytes)`,
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
    const signal = context.signal;
    if (signal?.aborted) {
      return cancelledOutput();
    }
    // Whole-string LLM-friendly links become live cell references; the
    // prompt loop has already resolved any handle tokens, so the strings
    // seen here carry canonical addresses. Non-link strings and non-strings
    // pass through as plain JSON. A link that resolves outside the session's
    // configured space is refused before anything is created: the session's
    // authority ends at its own space.
    let pieceInput: Record<string, unknown> | undefined;
    const liveCellInputs: Array<{ key: string; cell: Cell<unknown> }> = [];
    if (input.inputs !== undefined) {
      const converted: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(input.inputs)) {
        let entry = value;
        if (
          typeof value === "string" && matchLLMFriendlyLink.test(value.trim())
        ) {
          let link;
          try {
            link = parseLLMFriendlyLink(value, space);
          } catch {
            // Not a parseable link after all — keep the plain string.
          }
          if (link !== undefined) {
            if (link.space !== space) {
              return errorOutput(
                "error",
                `run_pattern input "${key}" reference targets another space; only references into the configured session space are allowed`,
              );
            }
            const cell = pieces.runtime.getCellFromLink(link);
            liveCellInputs.push({ key, cell });
            entry = cell;
          }
        }
        defineOwnEntry(converted, key, entry);
      }
      pieceInput = converted;
    }
    let pattern;
    try {
      pattern = await compileAndSavePattern(pieces.runtime, sourceText, {
        space,
      });
    } catch (error) {
      // Compiler diagnostics are the model's feedback loop, so the full
      // message goes into the artifact; the prompt loop scrubs bare fabric
      // identifiers from the model-facing rendering.
      return errorOutput("compile-error", errorMessage(error));
    }
    // A live-cell input's current value must match the compiled pattern's
    // argument schema for its key before any piece exists, so a mismatch is
    // a model-correctable error rather than a persisted broken piece.
    const argumentProperties = isRecord(pattern.argumentSchema) &&
        isRecord(pattern.argumentSchema.properties)
      ? pattern.argumentSchema.properties
      : undefined;
    if (argumentProperties !== undefined) {
      for (const { key, cell } of liveCellInputs) {
        const propertySchema = argumentProperties[key];
        if (propertySchema === undefined) {
          continue;
        }
        await cell.sync();
        const failure = validateAgainstSchema(
          propertySchema as JSONSchema,
          cell.get(),
          pattern.argumentSchema,
        );
        if (failure !== undefined) {
          return errorOutput(
            "error",
            `run_pattern input "${key}" does not match the pattern's argument schema: ${failure}`,
          );
        }
      }
    }
    let piece: PieceController<unknown>;
    try {
      // Deliberately unregistered: no `pieces.add()` and no default-pattern
      // touch, so the piece never appears in the space's piece list. No
      // origin either: model-authored source starts detached under the piece
      // source-lifecycle spec, and run→piece provenance lives in the run's
      // persisted artifacts — run-state and the tool-output artifact record
      // the `pieceId`.
      const pieceCell = await pieces.runPersistent(
        pattern,
        pieceInput ?? {},
        undefined,
        { start: true },
      );
      piece = new PieceController(pieces, pieceCell);
    } catch (error) {
      return errorOutput("error", errorMessage(error));
    }
    const barrier = (async () => {
      await pieces.runtime.settled();
      await pieces.synced();
    })();
    if (await raceWithAbort(barrier, signal) === "aborted") {
      // Stop without the usual `stopPiece` idle wait: the abort path must
      // not wait on the very scheduler the signal is escaping.
      try {
        pieces.runtime.runner.stop(piece.getCell());
      } catch {
        // Best-effort: the cancelled output stands either way.
      }
      return cancelledOutput();
    }
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
