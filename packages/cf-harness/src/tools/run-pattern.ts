import type { JSONSchema } from "@commonfabric/api";
import { type Cell, compileAndSavePattern } from "@commonfabric/runner";
import { validateAgainstSchema } from "@commonfabric/runner/cfc";
import {
  createLLMFriendlyLink,
  FRAMEWORK_RESULT_KEYS,
  matchLLMFriendlyLink,
  parseLLMFriendlyLink,
} from "@commonfabric/runner/shared";
import { PieceController } from "@commonfabric/piece/ops";
import { isObjectNotArray } from "@commonfabric/utils/types";
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
   * The compiled pattern's result schema — the shape of whatever
   * `resultRef` names. Known here for free, since compilation produced it,
   * and recorded on the handle minted for `resultRef` so a later
   * `describe_handle` can answer what the reference is without reading it.
   * Stripped from the model-facing rendering by the prompt loop: the model
   * wrote the pattern this describes, and asks for the shape by token when
   * it wants it back. Always present: a compiled pattern carries a result
   * schema.
   */
  resultRefSchema: JSONSchema;
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
  "resultRef" in output && typeof output.resultRef === "string" &&
  "resultRefSchema" in output;

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
          'JSON Schema for the result value. Without it you get resultRef only and no value at all, so pass it whenever you need to read what the pattern computed. A value is returned only for the fields the schema models: an inert one (a number, a boolean, an enum or const string) comes back as itself, anything else as an opaque link. Example: {"type":"object","properties":{"total":{"type":"number"}},"required":["total"]}. The framework\'s own result keys ($NAME, $UI and the other rendering variants) need not be declared.',
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
        resultRefSchema: {},
        pieceId: { type: "string" },
        value: {},
        linkedStringCount: { type: "integer", minimum: 0 },
        valueError: { type: "string" },
      },
      required: [
        "outputId",
        "status",
        "resultRef",
        "resultRefSchema",
        "pieceId",
      ],
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
    const argumentProperties = isObjectNotArray(pattern.argumentSchema) &&
        isObjectNotArray(pattern.argumentSchema.properties)
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
        // The raw result is what gets measured: the framework's own result
        // keys are named to the sanitizer as RESERVED rather than projected
        // out first. Projecting first would change the question the schema
        // answers — a value a branch refuses because of what it carries under
        // `$NAME` would reach that branch with the offending key already
        // gone — and would miss a `$NAME` the caller declared through a
        // `$ref` or a combinator rather than at the top level.
        const sanitized = validateAndSanitizeStructuredResult({
          schema: parsedResultSchema.schema,
          value: rawValue,
          opaqueHandleId: outputId,
          reservedKeys: FRAMEWORK_RESULT_KEYS,
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
      resultRefSchema: pattern.resultSchema,
      pieceId: piece.id,
      ...(value !== undefined ? { value } : {}),
      ...(linkedStringCount !== undefined ? { linkedStringCount } : {}),
      ...(valueError !== undefined ? { valueError } : {}),
      ...(rawValue !== undefined ? { rawValue } : {}),
    };
  },
};
