import type { JSONSchema } from "@commonfabric/api";
import {
  type Cell,
  compileAndSavePattern,
  validateSlug,
} from "@commonfabric/runner";
import { validateAgainstSchema } from "@commonfabric/runner/cfc";
import {
  createLLMFriendlyLink,
  FRAMEWORK_RESULT_KEYS,
  matchLLMFriendlyLink,
  parseLLMFriendlyLink,
} from "@commonfabric/runner/shared";
import {
  assignSlug,
  resolvePieceAddress,
  SlugResolutionError,
} from "@commonfabric/piece";
import {
  PieceController,
  type PiecesController,
} from "@commonfabric/piece/ops";
import { isObjectNotArray } from "@commonfabric/utils/types";
import type { HarnessToolDescriptor } from "../contracts/tool-descriptor.ts";
import { fabricRuntimeObservations } from "../fabric-observations.ts";
import { defineOwnEntry } from "../handle-table.ts";
import {
  isSealedOpaqueLinkObject,
  parseStructuredResultSchema,
  validateAndSanitizeStructuredResult,
} from "../structured-result.ts";
import type { HarnessToolDefinition } from "./types.ts";

/**
 * Asks for the created piece to be registered in the space's piece list under
 * `slug`, the named address a person opens. A slug rather than a free-text
 * name because the slug is the only handle the tool can set: what the piece
 * list displays is the pattern's own `NAME` result, which the pattern source
 * carries and nothing outside it writes.
 */
export interface RunPatternRegistrationRequest {
  slug: string;
}

export interface RunPatternToolInput {
  sourceText?: string;
  inputs?: Record<string, unknown>;
  resultSchema?: JSONSchema;
  register?: RunPatternRegistrationRequest;
}

/** What a registered piece gives a person: a named address, and a URL for it
 * when one can be composed honestly. */
export interface RunPatternRegistration {
  slug: string;
  /**
   * Absolute URL for the registered piece, composed from the session's API URL
   * and the space's configured name. Absent when the session was configured by
   * `did:key` rather than by name: the only URL available then would carry the
   * space DID, a bare fabric identifier that does not cross the model
   * boundary, so no URL is offered rather than a fabricated one.
   */
  url?: string;
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
  /**
   * Present only when `register` was given and registration succeeded. Its
   * `slug` is the caller's own word and its `url` is composed from the
   * session's API URL and space name, so neither carries a fabric identifier
   * and both reach the model.
   */
  registration?: RunPatternRegistration;
  /**
   * Why `registration` is absent despite a `register` request. Registration
   * happens after the piece is live, so a failure here leaves a working piece
   * and a usable `resultRef` — the run is still `ok`, and only the publishing
   * step did not happen.
   */
  registrationError?: string;
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
    "Compile and run a Common Fabric pattern in the configured space, returning a reference to its live result cell. The piece is not registered in the space's piece list unless `register` asks for it.",
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
      register: {
        type: "object",
        properties: {
          slug: {
            type: "string",
            description:
              "Named address for the piece: lowercase letters, numbers, and single hyphens between words, at most 80 characters.",
          },
        },
        required: ["slug"],
        additionalProperties: false,
        description:
          "Ask for the piece to be registered in the space's piece list at this address, so a person can open it. Omit it and the piece stays out of the list, which is what pure computation wants. A slug that already names a piece is refused rather than repointed, so pick an unused one. The output then carries `registration.slug` and, when the space is configured by name, `registration.url` — the link to hand a person. To give the piece a title in that list, set `NAME` in the pattern source; nothing outside the pattern writes it.",
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
        registration: {
          type: "object",
          properties: {
            slug: { type: "string" },
            url: { type: "string" },
          },
          required: ["slug"],
          additionalProperties: false,
        },
        registrationError: { type: "string" },
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
 * The slug a `register` request asks for, validated by the same rule every
 * other named address in the fabric answers to. Validation happens before
 * anything is compiled or created, so an unusable slug is a model-correctable
 * error that persists no piece. Returns `undefined` when no registration was
 * asked for; throws with the reason when the request is unusable.
 */
const parseRegistrationSlug = (
  register: unknown,
): string | undefined => {
  if (register === undefined) {
    return undefined;
  }
  if (!isObjectNotArray(register)) {
    throw new Error("run_pattern register must be an object with a slug");
  }
  const { slug } = register;
  if (typeof slug !== "string") {
    throw new Error("run_pattern register requires a string slug");
  }
  try {
    return validateSlug(slug);
  } catch (error) {
    throw new Error(
      `run_pattern register slug is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
};

/**
 * The `SlugResolutionError` codes that positively say the slug names no
 * piece: its document is absent, holds no usable redirect, or redirects to
 * something that is not a piece. Each is a statement about what the space
 * holds, arrived at by reading it, so each means the slug is free — a
 * registration only ever competes with a piece.
 *
 * Every other outcome is a failure to establish anything: a storage error, a
 * sync that never landed, a lost connection. `invalid` sits on that side too
 * — the slug was validated before this is asked, so a resolver calling it
 * unusable means the two disagree about the rule rather than that the space
 * is empty.
 */
const VACANT_SLUG_CODES: ReadonlySet<
  NonNullable<SlugResolutionError["code"]>
> = new Set(["missing", "malformed", "not-piece", "missing-piece-id"]);

/**
 * Whether `slug` already names a piece in the session's space, or whether
 * that could not be established at all.
 *
 * Assignment is a blind write: the slug document is pointed at the new piece
 * whatever it held before, and last writer wins. So without asking first, a
 * `register` request naming a slug a person already opens would repoint that
 * name at whatever the model just wrote. That makes an unanswered question a
 * refusal rather than a "free": a resolution that failed operationally says
 * nothing about what the slug holds, and treating it as vacancy would reopen
 * exactly the overwrite this asks to prevent.
 *
 * The two are told apart by the typed `code` `resolvePieceAddress` carries on
 * its `SlugResolutionError`, never by the message text.
 */
const slugAvailability = async (
  pieces: PiecesController,
  slug: string,
): Promise<
  { state: "free" } | { state: "taken" } | { state: "unknown"; reason: string }
> => {
  try {
    await resolvePieceAddress(pieces, slug);
    return { state: "taken" };
  } catch (error) {
    if (
      error instanceof SlugResolutionError && error.code !== undefined &&
      VACANT_SLUG_CODES.has(error.code)
    ) {
      return { state: "free" };
    }
    return { state: "unknown", reason: errorMessage(error) };
  }
};

/**
 * What the model is told when the slug it asked for is already in use. A
 * model-correctable error: it names the slug and says what to do instead, and
 * the run persists nothing.
 */
const takenSlugRefusal = (slug: string): string =>
  `run_pattern register slug "${slug}" already names a piece in this space, and registering would repoint that address at the new piece. Choose another slug, or omit \`register\` to leave the piece unlisted.`;

/**
 * What the model is told when the space could not say whether the slug is
 * free. It does not claim the slug is taken — nothing read says that — and
 * the run persists nothing, so retrying the same call is the correction.
 */
const unknownSlugRefusal = (slug: string, reason: string): string =>
  `run_pattern could not establish whether register slug "${slug}" is available: ${reason}. Nothing was created. Try the same call again, or omit \`register\` to leave the piece unlisted.`;

/**
 * The URL a person opens for a registered piece, or `undefined` when none can
 * be composed without inventing one. The address is the session's API URL,
 * then the space, then the slug — the same shape `cf piece new` prints. Only a
 * space configured by NAME yields one: a space configured by `did:key` would
 * put a bare fabric identifier in the URL, and that does not cross the model
 * boundary.
 */
const registeredPieceUrl = (
  pieces: PiecesController,
  slug: string,
): string | undefined => {
  const spaceName = pieces.getSpaceName();
  if (spaceName === undefined) {
    return undefined;
  }
  try {
    const url = new URL(pieces.runtime.apiUrl);
    const base = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
    url.pathname = `${base}${encodeURIComponent(spaceName)}/${slug}`;
    return url.toString();
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
    let registrationSlug;
    try {
      registrationSlug = parseRegistrationSlug(input.register);
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
    // Availability is asked as soon as there is a session to ask, and before
    // anything is compiled or created, so a taken slug — or a question the
    // space could not answer — costs a refusal and nothing else.
    //
    // Resolution and assignment are not atomic, and nothing here makes them
    // so: a slug that becomes taken between this check and the assignment
    // below is still overwritten by it. This is a check, not a lock. It
    // refuses the case that arises — a model asking for a name already in use
    // — and it does not close a race against a writer working concurrently in
    // the same space.
    if (registrationSlug !== undefined) {
      const availability = await slugAvailability(pieces, registrationSlug);
      if (availability.state === "taken") {
        return errorOutput("error", takenSlugRefusal(registrationSlug));
      }
      if (availability.state === "unknown") {
        return errorOutput(
          "error",
          unknownSlugRefusal(registrationSlug, availability.reason),
        );
      }
      if (signal?.aborted) {
        return cancelledOutput();
      }
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
    for (const { key, cell } of liveCellInputs) {
      if (argumentSchemaForKey(key) === undefined) {
        continue;
      }
      await cell.sync();
      const mismatch = argumentMismatch(key, cell.get());
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
    // Registration is the publishing step, and it runs only when asked for.
    // Without it the piece stays absent from the space's piece list, which is
    // what pure computation wants; with it the piece gains a named address and
    // joins the list through the space's default pattern, then has the slug
    // pointed at it. That is `pieces.add` then `assignSlug`, the reverse of the
    // order `cf piece new` uses, and deliberately so for the reason the inline
    // comment below gives. A failure here leaves a live piece and a usable
    // `resultRef`, so it is reported alongside the result rather than as the
    // run's outcome. An abort during it is not: the caller asked to stop, so
    // the piece is stopped, whatever it had joined is undone, and the run
    // reports `cancelled`, exactly as an abort during the settle barrier does.
    // A slug assignment already under way is the one thing the abort does not
    // undo — the redirect it writes carries no mark saying which caller wrote
    // it, so nothing could tell this run's assignment from an identical one a
    // later writer made — and the cancelled output names the slug instead.
    let registration: RunPatternRegistration | undefined;
    let registrationError: string | undefined;
    if (registrationSlug !== undefined) {
      let failure: { error: unknown } | undefined;
      // Set once the piece is in the space's piece list, so the cancellation
      // path below knows whether there is a join to undo.
      let joinedPieceList = false;
      // Set by the cancellation path before it returns. Losing the race does
      // not stop the publishing continuation — it keeps running after the
      // cancelled output is handed back — so the continuation reads this mark
      // at each point it is between operations, so a cancelled run leaves the
      // piece unlisted and starts no assignment it had not already started.
      let cancelled = false;
      // Set as the assignment is entered, and read by the cancellation path,
      // which cannot wait for an assignment in flight to find out how it
      // ended without going back behind the operation the abort escaped.
      // Nothing withdraws the assignment, so the name the run had begun
      // taking is a name it keeps.
      let slugAssignmentBegun = false;
      let delistedPiece = false;
      const publishing = (async () => {
        try {
          // The registry join goes first, so a space with no piece list to
          // join leaves no orphan slug behind; the slug was validated before
          // anything was created, so this order costs nothing.
          await pieces.add([piece.getCell()]);
          joinedPieceList = true;
          if (cancelled) {
            // The abort won while the join was in flight, so the cancellation
            // path saw nothing to undo and the join undoes itself. Setting
            // `joinedPieceList` and reading the mark happen together, with no
            // await between them, so exactly one of the two paths removes.
            await pieces.remove(piece.getCell());
            return;
          }
          // Marked and entered together, with no await between them, so the
          // cancellation path never reads `false` for an assignment that has
          // started.
          slugAssignmentBegun = true;
          await assignSlug(pieces, piece.getCell(), registrationSlug);
        } catch (error) {
          failure = { error };
        }
      })();
      if (await raceWithAbort(publishing, signal) === "aborted") {
        // Marked before anything else on this path, so the continuation reads
        // it at whichever point it next looks.
        cancelled = true;
        stopPieceForAbort();
        if (joinedPieceList) {
          try {
            // Stopping a piece leaves it in the list it joined — removal is a
            // separate operation — so the cancellation path performs it. A
            // cancelled run hands back no `resultRef`, so a piece left listed
            // under no slug is one the caller was given no way to reach —
            // except where the abort landed inside the slug assignment, whose
            // name may go on reaching it, which is why the output below says so.
            // `remove` answers whether the piece left the list — it returns
            // false when the list did not hold it — so the report follows that
            // answer rather than the fact that the call was made.
            delistedPiece = await pieces.remove(piece.getCell());
          } catch {
            // Best-effort. The cancelled output stands either way, and reports
            // the piece as left listed rather than claiming a removal that did
            // not happen.
          }
        }
        // The detail reports what this path observed and nothing beyond it. An
        // assignment that had started may or may not have committed — the abort
        // races the write rather than waiting on it — so the name is described
        // as one that may still resolve, and the piece's presence in the list
        // is stated from the removal actually performed.
        return cancelledOutput(
          slugAssignmentBegun
            ? `the name "${registrationSlug}" was being assigned when the run was cancelled and is not withdrawn, so it may still resolve to the created piece, which is stopped and ${
              delistedPiece ? "no longer listed" : "was left listed"
            }`
            : undefined,
        );
      }
      if (failure !== undefined) {
        registrationError = errorMessage(failure.error);
      } else {
        const url = registeredPieceUrl(pieces, registrationSlug);
        registration = {
          slug: registrationSlug,
          ...(url !== undefined ? { url } : {}),
        };
      }
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
    // A result that settled to nothing is not a success to report. When the
    // sanitized value failed its schema, or the raw result holds no fields of
    // its own beyond the framework keys, the runtime's observation window
    // says why: an action error attributed to this piece names the failing
    // computation, and a non-settling episode names the other observed shape
    // — actions deferred past the convergence budget, which is what both a
    // reactive cycle and a policy-refused commit look like from here. The
    // refusal reason itself has no channel yet (CT-2037), so the message
    // names the shapes rather than claiming to know which one happened.
    const inertResultKeys = isObjectNotArray(rawValue)
      ? Object.keys(rawValue).filter((key) => !key.startsWith("$"))
      : undefined;
    const resultAbsent = rawValue === undefined || rawValue === null ||
      (inertResultKeys !== undefined && inertResultKeys.length === 0);
    if (valueError !== undefined || resultAbsent) {
      const pieceErrors = observations.errorsSince(observationStart, piece.id);
      const registrationNote = registration !== undefined
        ? `; the piece was registered at slug "${registration.slug}" and resolves to this broken result`
        : "";
      if (pieceErrors.length > 0) {
        return errorOutput(
          "error",
          `the pattern ran but its computation failed while settling: ${
            pieceErrors[0].message
          }${registrationNote}`,
        );
      }
      const episodes = observations.episodesSince(observationStart);
      if (episodes.length > 0) {
        return errorOutput(
          "error",
          `the pattern ran but its writes never landed: the scheduler deferred ${
            episodes[episodes.length - 1].deferredActionCount
          } action(s) past its convergence budget while settling. A reactive cycle, a non-idempotent computation, or a write the space's policy refuses all produce this shape${registrationNote}`,
        );
      }
    }
    return {
      outputId,
      status: "ok",
      resultRef,
      resultRefSchema: pattern.resultSchema,
      pieceId: piece.id,
      ...(registration !== undefined ? { registration } : {}),
      ...(registrationError !== undefined ? { registrationError } : {}),
      ...(value !== undefined ? { value } : {}),
      ...(linkedStringCount !== undefined ? { linkedStringCount } : {}),
      ...(valueError !== undefined ? { valueError } : {}),
      ...(rawValue !== undefined ? { rawValue } : {}),
    };
  },
};
