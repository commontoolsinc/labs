import type { JSONSchema } from "@commonfabric/api";
import {
  type Cell,
  compileAndSavePattern,
  getPatternIdentityRef,
} from "@commonfabric/runner";
import {
  selectReferencedCfcSchemaDefs,
  validateAgainstSchema,
} from "@commonfabric/runner/cfc";
import {
  createLLMFriendlyLink,
  FRAMEWORK_RESULT_KEYS,
  matchLLMFriendlyLink,
  type NormalizedFullLink,
  parseLLMFriendlyLink,
} from "@commonfabric/runner/shared";
import { PieceController } from "@commonfabric/piece/ops";
import { isObjectNotArray } from "@commonfabric/utils/types";
import type { HarnessToolDescriptor } from "../contracts/tool-descriptor.ts";
import {
  comparableEntityHash,
  fabricRuntimeObservations,
} from "../fabric-observations.ts";
import { defineOwnEntry } from "../handle-table.ts";
import {
  addressSealedPositions,
  isSealedOpaqueLinkObject,
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

  /**
   * The durable piece a post-persistence failure leaves behind, for the
   * persisted artifact's run-to-piece provenance. Stripped from the
   * model-facing rendering like the success output's `pieceId`.
   */
  pieceId?: string;

  /**
   * The failing computation's own message, retained for the persisted
   * artifact and stripped from the model-facing rendering: a computation
   * over data the model cannot read may carry that data in its thrown text.
   */
  rawCauseMessage?: string;
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
    "Compile and run a Common Fabric pattern in the configured space, returning a reference to its live result cell. The piece stays out of the space's piece list; assign_slug names and lists it when it deserves a public address.",
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
          'JSON Schema for the result value. Without it you get resultRef only and no value at all, so pass it whenever you need to read what the pattern computed. A value is returned only for the fields the schema models: an inert one (a number, a boolean, an enum or const string) comes back as itself; anything else is withheld as text and comes back as a reference token addressing that position, which describe_handle can inspect and a later run_pattern can wire by reference. Example: {"type":"object","properties":{"total":{"type":"number"}},"required":["total"]}. The framework\'s own result keys ($NAME, $UI and the other rendering variants) need not be declared.',
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
        rawValue: {},
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
        pieceId: { type: "string" },
        rawCauseMessage: { type: "string" },
      },
      required: ["outputId", "status", "message"],
      additionalProperties: false,
    }],
  } satisfies JSONSchema,
  tags: ["fabric", "pattern", "piece"],
};

/**
 * The `@link` object addressing one sealed position of a result: the result
 * cell's link extended by the sealed path. It rides as a whole object, which
 * the outbound swap mints from in one piece — the free-text scanner would
 * stop an address short at a property name's whitespace. A path the link
 * grammar cannot round-trip — an empty final segment parses back as its
 * parent — answers `undefined`, keeping the seal rather than becoming a
 * reference to the wrong cell.
 */
export const sealedPositionLink = (
  resultLink: NormalizedFullLink,
  path: readonly (string | number)[],
  space: NormalizedFullLink["space"],
): { "@link": string } | undefined => {
  const segments = [...resultLink.path, ...path.map(String)];
  const ref = createLLMFriendlyLink({ ...resultLink, path: segments }, space);
  try {
    const parsed = parseLLMFriendlyLink(ref, space);
    if (
      parsed.path.length !== segments.length ||
      parsed.path.some((segment, i) => segment !== segments[i])
    ) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return { "@link": ref };
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
export const asSerializableValue = (value: unknown): unknown => {
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? undefined : JSON.parse(encoded);
  } catch {
    return undefined;
  }
};

/**
 * The reserved seal target, as `cfcOpaqueLinkForPath` mints it: the literal
 * `opaque:` scheme, then a percent-encoded handle id, then optionally `#` and
 * a JSON pointer that always opens with `/`. The handle-id charset is exactly
 * what `encodeURIComponent` can emit, which is what keeps this narrower than
 * "any string starting with `opaque:`" — a sentence, a path, or a quoted
 * phrase carrying that prefix has a space or a delimiter in it and does not
 * match.
 */
const RESERVED_OPAQUE_TARGET =
  /^opaque:[A-Za-z0-9\-_.!~*'()%]+(?:#\/[\s\S]*)?$/;

/**
 * Whether `value` is the reserved seal target string. The target is the seal:
 * the `@link` object is only the wrapper a sanitized result happens to put it
 * in, and a model that lifts the string out of that wrapper — or reads it out
 * of one whose other keys it also copied — is passing back the same redaction.
 */
const isSealedOpaqueTarget = (value: unknown): boolean =>
  typeof value === "string" && RESERVED_OPAQUE_TARGET.test(value);

/**
 * The path at which `value` carries a sealed opaque link, or `undefined` when
 * it carries none. `path` names the position `value` itself sits at, so a
 * caller starting from an input key gets back a path that points at the
 * offending position within that input. The search is exhaustive because a
 * sealed value reaches an input however the model composed it — nested inside
 * an object or an array it built around what a tool result handed back, and in
 * whatever form it lifted it out in.
 */
const sealedOpaqueLinkPath = (
  value: unknown,
  path: string,
): string | undefined => {
  if (isSealedOpaqueTarget(value)) {
    return path;
  }
  if (
    isSealedOpaqueLinkObject(value) ||
    (isObjectNotArray(value) && isSealedOpaqueTarget(value["@link"]))
  ) {
    return path;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = sealedOpaqueLinkPath(value[index], `${path}[${index}]`);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }
  if (isObjectNotArray(value)) {
    for (const [key, entry] of Object.entries(value)) {
      const found = sealedOpaqueLinkPath(entry, `${path}.${key}`);
      if (found !== undefined) {
        return found;
      }
    }
  }
  return undefined;
};

/**
 * What the model is told when it passes back a value a structured result
 * sealed. The distinction the message has to carry is the whole of the fix: a
 * seal is a redaction, so it names nothing, and the reference the model was
 * given for that same data is what it should have passed instead.
 */
const sealedInputRefusal = (key: string, path: string): string =>
  `run_pattern input "${key}" ${
    path === key
      ? "is a sealed opaque link"
      : `carries a sealed opaque link at "${path}"`
  } — the reserved "opaque:..." target, whether as a bare string or as the "@link" of an object. A sealed value is a redaction, not an address: it marks a position an earlier result withheld, so it names nothing that can be read, and storing it would leave a dead literal where the pattern declared a live reference, with everything computed from it empty. Pass the reference you were given for that data instead — the whole cfh:a: handle token, or the LLM-friendly link it stands for — as the input's own string value.`;

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

    /**
     * `detail` is what the cancellation left behind that the caller would
     * otherwise have to discover by looking: a durable effect the run had
     * already made and does not undo. The cancelled output carries no fields
     * beyond `message`, so it is said there.
     */
    const cancelledOutput = (detail?: string): RunPatternToolErrorOutput =>
      errorOutput(
        "cancelled",
        detail === undefined
          ? "run_pattern was cancelled"
          : `run_pattern was cancelled; ${detail}`,
      );
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
    // authority ends at its own space. So is a value carrying a sealed
    // opaque link anywhere within it, which is a redaction the model copied
    // back out of an earlier result rather than a reference to anything.
    let pieceInput: Record<string, unknown> | undefined;
    const liveCellInputs: Array<{ key: string; cell: Cell<unknown> }> = [];
    const plainInputs: Array<{ key: string; value: unknown }> = [];
    if (input.inputs !== undefined) {
      const converted: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(input.inputs)) {
        const sealedPath = sealedOpaqueLinkPath(value, key);
        if (sealedPath !== undefined) {
          return errorOutput("error", sealedInputRefusal(key, sealedPath));
        }
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
        if (entry === value) {
          plainInputs.push({ key, value });
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
    // An input's value must match the compiled pattern's argument schema for
    // its key before any piece exists, so a mismatch is a model-correctable
    // error rather than a persisted broken piece. What supplies the value
    // does not change the question: a live cell is measured by what it
    // currently holds, and a plain JSON value by itself.
    const argumentSchema = pattern.argumentSchema;
    const argumentProperties = isObjectNotArray(argumentSchema) &&
        isObjectNotArray(argumentSchema.properties)
      ? argumentSchema.properties
      : undefined;
    // An input the compiled pattern declares no argument for is refused for
    // the same reason: the pattern would run with that argument undefined and
    // every field computed from it empty, which renders as a complete page
    // holding nothing. Only a pattern whose argument schema names its
    // properties is measured this way — one that admits further properties, or
    // that declares its argument through a `$ref` or a combinator, states no
    // closed set of names to measure against. `additionalProperties` admits
    // them both when it is `true` and when it is a schema: a schema there is an
    // index signature, which names what an undeclared key is allowed to hold
    // rather than forbidding one. A plain-function pattern compiles with no
    // argument schema at all — not even a boolean one — so the read is
    // guarded rather than assumed.
    const additionalArguments = isObjectNotArray(argumentSchema)
      ? (argumentSchema as { additionalProperties?: unknown })
        .additionalProperties
      : undefined;
    const admitsUndeclaredArguments = additionalArguments === true ||
      isObjectNotArray(additionalArguments);
    if (
      argumentProperties !== undefined && input.inputs !== undefined &&
      !admitsUndeclaredArguments
    ) {
      const declared = Object.keys(argumentProperties);
      const undeclared = Object.keys(input.inputs).filter(
        (key) => !Object.hasOwn(argumentProperties, key),
      );
      if (undeclared.length > 0) {
        return errorOutput(
          "error",
          `run_pattern inputs name ${
            undeclared.map((key) => `"${key}"`).join(", ")
          }, which the pattern's argument schema does not declare; it declares ${
            declared.length === 0
              ? "no inputs"
              : declared.map((key) => `"${key}"`).join(", ")
          }`,
        );
      }
    }
    // An `additionalProperties` schema is what the argument schema says an
    // undeclared key may hold, so an input admitted by it is measured against
    // it: admitting a key is a statement about its value, not an exemption
    // from having one checked. An `additionalProperties` of `true` states
    // nothing to measure against — the pattern declared its argument open, so
    // an undeclared key there is unconstrained by declaration rather than
    // unchecked by omission — and neither does a key the argument schema
    // declares no shape for at all.
    const undeclaredArgumentSchema = isObjectNotArray(additionalArguments)
      ? additionalArguments as JSONSchema
      : undefined;
    const argumentSchemaForKey = (key: string): JSONSchema | undefined =>
      argumentProperties !== undefined && Object.hasOwn(argumentProperties, key)
        ? argumentProperties[key] as JSONSchema
        : undeclaredArgumentSchema;
    const argumentMismatch = (
      key: string,
      value: unknown,
    ): RunPatternToolErrorOutput | undefined => {
      const propertySchema = argumentSchemaForKey(key);
      if (propertySchema === undefined) {
        return undefined;
      }
      const failure = validateAgainstSchema(
        propertySchema,
        value,
        argumentSchema,
      );
      return failure === undefined ? undefined : errorOutput(
        "error",
        `run_pattern input "${key}" does not match the pattern's argument schema: ${failure}`,
      );
    };
    // A property schema referring into the argument schema's `$defs` leaves
    // its root behind when it becomes a cell's whole schema, so the read
    // schema carries the referenced definitions along —
    // `selectReferencedCfcSchemaDefs` computes that closure, honoring a
    // property's own `$defs` scope over the root's.
    const argumentDefs = isObjectNotArray(argumentSchema) &&
        isObjectNotArray((argumentSchema as { $defs?: unknown }).$defs)
      ? (argumentSchema as { $defs: Record<string, JSONSchema> }).$defs
      : undefined;
    const readSchemaForKey = (key: string): JSONSchema | undefined => {
      const propertySchema = argumentSchemaForKey(key);
      if (propertySchema === undefined || !isObjectNotArray(propertySchema)) {
        return propertySchema;
      }
      const defs = selectReferencedCfcSchemaDefs(propertySchema, argumentDefs);
      return defs === undefined ? propertySchema : {
        ...propertySchema,
        $defs: defs,
      };
    };
    for (const { key, cell } of liveCellInputs) {
      const readSchema = readSchemaForKey(key);
      if (readSchema === undefined) {
        continue;
      }
      // The read goes through the argument schema: a schema-less sync can
      // complete without data for a referent that needs schema-driven
      // materialization (a registry grant is one), and its `undefined` would
      // be measured here as the cell's value.
      const typedCell = cell.asSchema(readSchema);
      await typedCell.sync();
      const mismatch = argumentMismatch(key, typedCell.get());
      if (mismatch !== undefined) {
        return mismatch;
      }
    }
    for (const { key, value } of plainInputs) {
      const mismatch = argumentMismatch(key, value);
      if (mismatch !== undefined) {
        return mismatch;
      }
    }
    // Position in the runtime's observation stream before the piece exists,
    // so the post-settle read covers exactly this invocation's window.
    const observations = fabricRuntimeObservations(pieces.runtime);
    const observationStart = observations.sequence();
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
    // Stops the created piece without the usual `stopPiece` idle wait: an
    // abort path must not wait on the very scheduler the signal is escaping.
    const stopPieceForAbort = () => {
      try {
        pieces.runtime.runner.stop(piece.getCell());
      } catch {
        // Best-effort: the cancelled output stands either way.
      }
    };
    const barrier = (async () => {
      await pieces.runtime.settled();
      await pieces.synced();
    })();
    if (await raceWithAbort(barrier, signal) === "aborted") {
      stopPieceForAbort();
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
        // A position the schema could not release as text is fabric-backed
        // by construction — the result reference plus the sealed path is its
        // address — so it goes over as that address rather than as a dead
        // output-scoped link. The outbound swap renders each one as a handle
        // token, which describe_handle answers and a later run_pattern can
        // wire by reference. `linkedStringCount` still counts the string
        // positions withheld as text.
        const resultLink = resultCell.getAsNormalizedFullLink();
        value = addressSealedPositions(
          sanitized.value,
          sanitized.sealedPaths,
          (path) => sealedPositionLink(resultLink, path, space),
        );
        linkedStringCount = sanitized.linkedStringCount;
      } catch (error) {
        valueError = errorMessage(error);
      }
    }
    // A result that settled to nothing is not a success to report. When the
    // sanitized value failed its schema, or the raw result holds no fields of
    // its own beyond the framework keys, the runtime's observation window
    // says why: an action error attributed to this piece names the cause —
    // a CFC commit refusal arrives there as a terminal
    // `CfcCommitRefusalError` — and a non-settling episode names the other
    // observed shape, actions deferred past the convergence budget, which is
    // what a reactive cycle or a non-idempotent computation looks like from
    // here.
    const inertResultKeys = isObjectNotArray(rawValue)
      ? Object.keys(rawValue).filter((key) => !key.startsWith("$"))
      : undefined;
    const resultAbsent = rawValue === undefined || rawValue === null ||
      (inertResultKeys !== undefined && inertResultKeys.length === 0);
    if (valueError !== undefined || resultAbsent) {
      const pieceErrors = observations.errorsSince(observationStart, piece.id);
      // A policy refusal is named as what it is. The refusal reason stays
      // out of the model-facing message the same way thrown text does: it
      // names the documents and label atoms involved — fabric identifiers
      // and policy detail the model does not read — so the artifact keeps it
      // and the model gets the fact of the refusal.
      const refusal = pieceErrors.find((record) =>
        record.name === "CfcCommitRefusalError"
      );
      if (refusal !== undefined) {
        return {
          ...errorOutput(
            "error",
            `the pattern ran but the space's policy refused to commit its result: flow enforcement rejected the write at the commit boundary, so the result never landed. The refusal reason is retained in the run artifact and withheld here, since it names the labels and documents involved`,
          ),
          pieceId: piece.id,
          rawCauseMessage: refusal.message,
        };
      }
      if (pieceErrors.length > 0) {
        // The thrown text stays out of the model-facing message: a
        // computation over data the model cannot read may carry that data in
        // what it throws, so the artifact keeps the diagnostic and the model
        // gets the fact of the failure.
        return {
          ...errorOutput(
            "error",
            `the pattern ran but a computation attributed to the created piece failed while settling and the result never landed; the failure text is retained in the run artifact and withheld here, since a computation's thrown message can carry the data it read`,
          ),
          pieceId: piece.id,
          rawCauseMessage: pieceErrors[0].message,
        };
      }
      // A convergence-budget episode is claimed when a deferred action's
      // piece attribution matches this piece, or — for an action carrying no
      // observation identity — when its label names this pattern's module
      // identity. An unrelated piece churning during this invocation's
      // settle window is not evidence about this one. The identity match is
      // exact; the label match is as fine as labels resolve: another live
      // piece created from the same source shares the module identity, so
      // the message says "this pattern's module" rather than claiming the
      // episode as this piece's own. An episode lists at most its first ten
      // deferred actions, so a wide episode can omit this pattern and
      // under-report, which falls back to the plain ok-with-valueError
      // rather than misattributing.
      // The scheduler composes deferred-action ids as
      // `cf:module/<identity>:<symbol>:<instanceKey>` from the same entry
      // ref this meta stamp stores, so the label match is on that composed
      // prefix rather than a bare substring — a representation drift on
      // either side fails the settle-cause test that drives this path,
      // loudly.
      const patternIdentity = getPatternIdentityRef(resultCell)?.identity;
      const pieceHash = comparableEntityHash(piece.id);
      const ownEpisodes = observations.episodesSince(observationStart).filter(
        (episode) =>
          episode.deferredActions.some((entry) =>
            (pieceHash !== undefined && entry.pieceId === pieceHash) ||
            (patternIdentity !== undefined &&
              entry.label.includes(`cf:module/${patternIdentity}:`))
          ),
      );
      if (ownEpisodes.length > 0) {
        return {
          ...errorOutput(
            "error",
            `the pattern ran but its result never landed: while it settled, the scheduler deferred ${
              ownEpisodes[ownEpisodes.length - 1].deferredActionCount
            } action(s) of this piece or this pattern's module past its convergence budget. A reactive cycle or a non-idempotent computation produces this shape`,
          ),
          pieceId: piece.id,
        };
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
