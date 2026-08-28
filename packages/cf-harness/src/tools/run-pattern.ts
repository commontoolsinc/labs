import type { JSONSchema } from "@commonfabric/api";
import {
  type Cell,
  compileAndSavePattern,
  getPatternIdentityRef,
  PatternManager,
  type RuntimeProgram,
} from "@commonfabric/runner";
import {
  type CfcAddress,
  type CfcRefusalAttribution,
  type CfcRefusalDetail,
  type CfcRefusalGate,
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
import { keylessInstantiation } from "../fabric-instantiations.ts";
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
import type {
  HarnessPatternIndexClientFactory,
  PatternIndexEventType,
  PatternIndexPublishRequest,
} from "../pattern-index/client.ts";
import { PatternIndexError } from "../pattern-index/client.ts";
import {
  classifyRenderedHtml,
  PATTERN_DISCOVERABILITY_REASONS,
  PATTERN_PUBLICATION_MESSAGES,
  type PatternPublicationReason,
  type PatternPublicationStatus,
  PROBE_HTML_MAX_CHARS,
  renderPatternUiToHtml,
  syntheticArgument,
} from "../pattern-index/publish-render-gate.ts";
import {
  composedPatternIds,
  materializeComposedPatterns,
  PatternCompositionError,
  patternIndexDependencies,
  runtimeProgramFromIndex,
} from "../pattern-index/composition.ts";
import type { HarnessToolDefinition } from "./types.ts";

export interface RunPatternToolInput {
  sourceText?: string;

  /**
   * What the pattern is for, in one line. Published with the pattern when the
   * run contributes to the index; a run that gives none publishes nothing,
   * since a pattern nobody can read the purpose of is a pattern nobody finds.
   */
  description?: string;

  /** Tags the published pattern is found under. */
  hashtags?: readonly string[];

  /**
   * A pattern published to the index, run in place of inline source. The
   * program is fetched host-side and compiled down the same path; its source
   * never reaches the model, on the success path or on any error path.
   */
  patternId?: string;
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

  /**
   * What became of this run's contribution to the pattern index, when the
   * run had one to make. Absent when the run published nothing at all — it
   * named a `patternId`, it gave no description, or the run has no index.
   */
  patternPublication?: RunPatternPublicationReport;

  /**
   * The probe render's own output, retained for the persisted artifact and
   * stripped from the model-facing rendering, on the same terms as thrown
   * text: rendered DOM can carry both labeled data a pattern reached for
   * itself and text from `cf:pattern:` source the model has never seen.
   *
   * Stripped from the tool result is the whole of the claim. The artifact it
   * lands in is reachable by `bash`, which does not reserve the artifact root
   * the way the file tools do — a property of that root, which already holds
   * `rawValue` and every withheld thrown message, rather than of this field.
   * CT-2117 carries the structural fix. Until it lands, the DOM is written
   * only for a verdict that withheld discoverability, so a passing run adds
   * nothing to that root.
   */
  rawCauseMessage?: string;
}

/**
 * What the render gate decided about this run's contribution to the index.
 *
 * Every field is pinned to a fixed set — the two unions and a boolean, with
 * `message` drawn from `PATTERN_PUBLICATION_MESSAGES` and never composed. See
 * `pattern-index/publish-render-gate.ts` for why nothing derived from the
 * rendered DOM may join them.
 */
export interface RunPatternPublicationReport {
  status: PatternPublicationStatus;
  reason: PatternPublicationReason;
  message: string;

  /**
   * Whether the synthetic instance the probe was driven with covers the
   * pattern's whole argument schema. `false` where the schema declares no
   * shape, or where generating it hit a depth or node bound.
   */
  syntheticInputsComplete: boolean;
}

/**
 * What the commit boundary refused, in terms the caller can act on: the
 * boundary that refused, the label atoms outside it, and the keys of this
 * call's own `inputs` that carried those atoms in. When `attribution` is
 * `complete`, a run without those keys meets the boundary.
 *
 * Everything here reaches the model as it stands — the model-facing
 * rendering strips `rawValue`, `rawCauseMessage`, `pieceId` and
 * `resultRefSchema` and scrubs the free-text fields, and a structured field
 * passes through untouched. So nothing here is a document id, a space, or a
 * path into a document: an offending read that no input key accounts for is
 * counted rather than named.
 */
export interface RunPatternPolicyRefusal {
  /**
   * The rules that refused, deduplicated. `sink-ceiling` is an egress whose
   * confidentiality ceiling the flow exceeded; `writer-fit` is a write whose
   * target does not admit what the write carries.
   */
  gates: readonly CfcRefusalGate[];

  /**
   * The sinks whose ceilings refused, deduplicated. Empty when what refused
   * was a write rather than an egress.
   */
  sinks: readonly string[];

  /**
   * The label atoms outside what the boundary admits, rendered as the
   * boundary renders them.
   */
  offendingAtoms: readonly string[];

  /**
   * Offending atoms left out of `offendingAtoms`. A structured atom can
   * carry the principal that introduced it, and there is no seam that
   * redacts a rendered atom, so it is counted rather than named.
   */
  withheldAtomCount?: number;

  /**
   * The keys of this call's own `inputs` whose values carried the offending
   * atoms in — the inputs to drop and retry without.
   */
  inputKeys: readonly string[];

  /**
   * Offending reads that no key of this call's `inputs` accounts for,
   * counted by document.
   */
  unattributedInputCount?: number;

  /**
   * Whether `inputKeys` is the whole remedy. `complete` — every offending
   * atom came in through them, so a run without them proceeds. `partial` —
   * dropping them narrows the flow without necessarily clearing it. `none` —
   * nothing was attributed to an input of this call.
   */
  attribution: CfcRefusalAttribution;
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

  /**
   * What the commit boundary refused and which of this call's own inputs
   * carried it, when a policy refusal is what stopped the run.
   */
  policyRefusal?: RunPatternPolicyRefusal;
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
    "Compile and run a Common Fabric pattern in the configured space, returning a reference to its live result cell. Give it either your own sourceText or the patternId of a pattern search_patterns found. The piece stays out of the space's piece list; assign_slug names and lists it when it deserves a public address.",
  effectClass: "side-effect",
  inputSchema: {
    type: "object",
    properties: {
      sourceText: {
        type: "string",
        description:
          "Pattern source (TypeScript/TSX). At most 256 KiB. The pattern factory must return its result object literal directly (computed() wrapping individual fields at most); a factory that returns a computed() or other derived wrapper as the whole result creates a piece no other runtime can load.",
      },
      patternId: {
        type: "string",
        description:
          "Id of a pattern published to the index, as search_patterns reports it. Exactly one of sourceText and patternId is given; the published program is fetched and compiled without passing through this conversation.",
      },
      description: {
        type: "string",
        description:
          'One line saying what the pattern you are running does, e.g. "Totals an invoice\'s line items and applies a discount". Source you wrote is published to the pattern index when it runs, so fill this in and others — including you, later — can find it. A run without one publishes nothing.',
      },
      hashtags: {
        type: "array",
        items: { type: "string" },
        description:
          'Tags the published pattern is found under, e.g. ["invoice", "arithmetic"]. Use the words someone searching for this capability would type.',
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
    // Exactly one of `sourceText` and `patternId` is required, which is a
    // condition on the pair rather than on either alone; the tool states it
    // in prose here and enforces it on invocation.
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
        patternPublication: {
          type: "object",
          properties: {
            status: {
              type: "string",
              enum: ["discoverable", "recorded"],
            },
            reason: {
              type: "string",
              enum: [
                "ui-rendered",
                "no-ui",
                "ui-default-tostring",
                "ui-rendered-empty",
                "probe-failed",
                "superseded",
              ],
            },
            message: { type: "string" },
            syntheticInputsComplete: { type: "boolean" },
          },
          required: [
            "status",
            "reason",
            "message",
            "syntheticInputsComplete",
          ],
          additionalProperties: false,
        },
        rawCauseMessage: { type: "string" },
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
        policyRefusal: {
          type: "object",
          properties: {
            gates: {
              type: "array",
              items: { type: "string", enum: ["sink-ceiling", "writer-fit"] },
            },
            sinks: { type: "array", items: { type: "string" } },
            offendingAtoms: { type: "array", items: { type: "string" } },
            withheldAtomCount: { type: "integer", minimum: 0 },
            inputKeys: { type: "array", items: { type: "string" } },
            unattributedInputCount: { type: "integer", minimum: 0 },
            attribution: {
              type: "string",
              enum: ["complete", "partial", "none"],
            },
          },
          required: [
            "gates",
            "sinks",
            "offendingAtoms",
            "inputKeys",
            "attribution",
          ],
          additionalProperties: false,
        },
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
 * Reports what a run did with an indexed pattern, without letting the report
 * bear on the run. The index ranks on these events, so a failure to record
 * one costs ranking accuracy and nothing else — it is logged and dropped
 * rather than turned into a tool error for a pattern that ran.
 */
const recordPatternIndexEvent = (
  getClient: HarnessPatternIndexClientFactory,
  patternId: string,
  eventType: PatternIndexEventType,
): void => {
  void (async () => {
    try {
      const client = await getClient();
      await client.recordEvent({ patternId, eventType });
    } catch (error) {
      console.error(
        `run_pattern could not record the ${eventType} event for pattern index entry "${patternId}": ${
          errorMessage(error)
        }`,
      );
    }
  })();
};

/**
 * Publishes an authored pattern to the index, without letting the publication
 * bear on the run that authored it. Like the usage events, this is a
 * contribution to a shared catalog rather than part of the tool's result: it
 * is not awaited, and a failure is logged. A publication the index answers as
 * already held (`created: false`) records nothing further — the entry was
 * created once, by whoever got there first.
 */
const publishPatternToIndex = (
  getClient: HarnessPatternIndexClientFactory,
  request: PatternIndexPublishRequest,
): void => {
  void (async () => {
    try {
      const client = await getClient();
      const response = await client.publishPattern(request);
      if (response.created) {
        recordPatternIndexEvent(getClient, response.patternId, "created");
      }
    } catch (error) {
      console.error(
        `run_pattern could not publish the pattern it ran to the pattern index: ${
          errorMessage(error)
        }`,
      );
    }
  })();
};

/**
 * The entry path `compileAndSavePattern` wraps bare source under. Written out
 * here because the published program has to be the one the compile consumed,
 * down to the name its single file carries into the content hash.
 */
const RUN_PATTERN_SOURCE_MAIN = "/main.tsx";

/** What a call naming neither a source nor a published pattern is told. */
const RUN_PATTERN_NO_PROGRAM_MESSAGE =
  "run_pattern requires sourceText or patternId";

/**
 * What a refusal message says about the raw reason, which stays in the
 * artifact for the same cause the thrown text does: it names the labels and
 * the documents the flow touched.
 */
const RUN_PATTERN_REFUSAL_ARTIFACT_NOTE =
  "The refusal reason is retained in the run artifact and withheld here, " +
  "since it names the labels and documents involved";

/** What a refusal the commit boundary described only in prose is told. */
const RUN_PATTERN_OPAQUE_REFUSAL_MESSAGE =
  "the pattern ran but the space's policy refused to commit its result: " +
  "flow enforcement rejected the write at the commit boundary, so the " +
  `result never landed. ${RUN_PATTERN_REFUSAL_ARTIFACT_NOTE}`;

/**
 * Where an agent-supplied input landed. A refusal names the reads that
 * carried the offending labels; turning one back into something the caller
 * can act on means finding the key whose value that read belongs to, and the
 * key is the only part of the answer the caller may be told.
 */
interface RunPatternInputAddress {
  readonly key: string;

  /**
   * The document the caller's link resolved to, through the canonical entity
   * seam, so a read spelled differently by another seam still compares.
   */
  readonly hash: string;

  readonly path: readonly string[];
}

const pathStartsWith = (
  path: readonly string[],
  prefix: readonly string[],
): boolean =>
  prefix.length <= path.length &&
  prefix.every((segment, index) => segment === path[index]);

/**
 * The key of `inputs` a refused read belongs to, or `undefined` when none
 * does.
 *
 * A read reaches an input two ways. It reads the document the caller's link
 * addressed, which the retained addresses match. Or it reads the piece's
 * argument document, where every input — link or plain JSON — sits under its
 * own key, so the first path segment is the key. Both are matched, because
 * one refusal commonly reports the same input through both.
 */
const refusalReadInputKey = (
  read: CfcAddress,
  addresses: readonly RunPatternInputAddress[],
  argumentHash: string | undefined,
  suppliedKeys: readonly string[],
): string | undefined => {
  const readHash = comparableEntityHash(read.id);
  if (readHash === undefined) {
    return undefined;
  }
  for (const address of addresses) {
    if (address.hash === readHash && pathStartsWith(read.path, address.path)) {
      return address.key;
    }
  }
  if (argumentHash !== undefined && readHash === argumentHash) {
    const first = read.path[0];
    if (first !== undefined && suppliedKeys.includes(first)) {
      return first;
    }
  }
  return undefined;
};

/**
 * Whether a rendered label atom may be named to the model.
 *
 * A scalar atom — `"medical"`, `3`, `true` — is the word the data was tagged
 * with, and naming it is the whole point of the report. A structured atom is
 * a CFC atom object, and a `Caveat` among them carries the principal that
 * introduced it; `redactCaveatSourcesForDisplay` strips that principal from a
 * whole label view, and there is no seam that strips it from an atom already
 * rendered to a string. So a structured atom is counted rather than named.
 */
const namableRefusalAtom = (rendered: string): boolean => {
  try {
    const parsed: unknown = JSON.parse(rendered);
    return parsed === null || typeof parsed !== "object";
  } catch {
    return false;
  }
};

/**
 * Fold the boundary's refusal details into the one report the caller reads,
 * resolving each offending read to a key of this call's `inputs`.
 *
 * `attribution` is the harness's own question, stricter than the boundary's:
 * the boundary asks whether every offending atom reached a named READ, and
 * this asks whether every such read is an input the caller can drop. A read
 * the caller does not own leaves the answer at `partial` even when the
 * boundary called its own attribution complete, because dropping inputs
 * cannot reach it.
 */
export const runPatternPolicyRefusal = (
  refusals: readonly CfcRefusalDetail[],
  inputKeyFor: (read: CfcAddress) => string | undefined,
): RunPatternPolicyRefusal | undefined => {
  if (refusals.length === 0) {
    return undefined;
  }
  const gates: CfcRefusalGate[] = [];
  const sinks: string[] = [];
  const offendingAtoms: string[] = [];
  const inputKeys: string[] = [];
  const seenAtoms = new Set<string>();
  const unattributed = new Set<string>();
  let withheldAtomCount = 0;
  let everyDetailComplete = true;
  for (const detail of refusals) {
    if (!gates.includes(detail.gate)) gates.push(detail.gate);
    if (detail.sink !== undefined && !sinks.includes(detail.sink)) {
      sinks.push(detail.sink);
    }
    if (detail.attribution !== "complete") everyDetailComplete = false;
    for (const atom of detail.offendingAtoms) {
      if (seenAtoms.has(atom)) continue;
      seenAtoms.add(atom);
      if (namableRefusalAtom(atom)) offendingAtoms.push(atom);
      else withheldAtomCount += 1;
    }
    for (const input of detail.inputs) {
      const key = inputKeyFor(input.read);
      if (key === undefined) {
        // Counted by document, so one document read at three paths is one
        // input the caller cannot name rather than three.
        unattributed.add(comparableEntityHash(input.read.id) ?? "");
      } else if (!inputKeys.includes(key)) {
        inputKeys.push(key);
      }
    }
  }
  const attribution: CfcRefusalAttribution = inputKeys.length === 0
    ? "none"
    : everyDetailComplete && unattributed.size === 0
    ? "complete"
    : "partial";
  return {
    gates,
    sinks,
    offendingAtoms,
    ...(withheldAtomCount > 0 ? { withheldAtomCount } : {}),
    inputKeys,
    ...(unattributed.size > 0
      ? { unattributedInputCount: unattributed.size }
      : {}),
    attribution,
  };
};

const quoteAll = (values: readonly string[]): string =>
  values.map((value) => `"${value}"`).join(", ");

/**
 * The refusal stated as an instruction: what refused, which of the caller's
 * inputs carried what it refused, and whether dropping those inputs is the
 * whole remedy or only narrows the flow.
 */
export const policyRefusalMessage = (
  refusal: RunPatternPolicyRefusal,
): string => {
  const boundary = refusal.sinks.length > 0
    ? `the sink${refusal.sinks.length > 1 ? "s" : ""} ${
      quoteAll(refusal.sinks)
    }`
    : "the write it attempted";
  const atoms = refusal.offendingAtoms.length > 0
    ? ` (${refusal.offendingAtoms.join(", ")})`
    : "";
  const opening =
    "the pattern ran but the space's policy refused to commit its result: " +
    `${boundary} does not admit the confidentiality${atoms} this run ` +
    "carries, so the result never landed";
  const plural = refusal.inputKeys.length > 1;
  const keys = `input${plural ? "s" : ""} ${quoteAll(refusal.inputKeys)}`;
  const remedy = refusal.attribution === "complete"
    ? `Every label refused here came in through ${keys}, so the same run ` +
      `without ${plural ? "them" : "it"} proceeds`
    : refusal.attribution === "partial"
    ? `Some of what was refused came in through ${keys}; dropping ` +
      `${plural ? "them" : "it"} narrows the flow without necessarily ` +
      "clearing it, since reads this call does not own carry refused " +
      "labels too"
    : "No input of this call accounts for what was refused, so dropping an " +
      "input will not clear it";
  return `${opening}. ${remedy}. ${RUN_PATTERN_REFUSAL_ARTIFACT_NOTE}`;
};

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
    const { sourceText, patternId } = input;
    if (sourceText !== undefined && patternId !== undefined) {
      return errorOutput(
        "error",
        "run_pattern takes sourceText or patternId, not both; pass your own source or the id of an indexed pattern",
      );
    }
    if (sourceText === undefined && patternId === undefined) {
      return errorOutput("error", RUN_PATTERN_NO_PROGRAM_MESSAGE);
    }
    // The run's index client, held once: which of the index paths below run
    // is decided by the call and by whether the run has an index at all, and
    // both questions are settled here rather than at each of them.
    const getPatternIndexClient = context.getPatternIndexClient;
    if (patternId !== undefined && getPatternIndexClient === undefined) {
      return errorOutput(
        "error",
        "run_pattern patternId requires a pattern index; configure --pattern-index-url, or pass sourceText instead",
      );
    }
    if (sourceText !== undefined) {
      const sourceTextBytes = new TextEncoder().encode(sourceText).length;
      if (sourceTextBytes > RUN_PATTERN_MAX_SOURCE_TEXT_BYTES) {
        return errorOutput(
          "error",
          `run_pattern sourceText exceeds the ${
            RUN_PATTERN_MAX_SOURCE_TEXT_BYTES / 1024
          } KiB limit (${sourceTextBytes} bytes)`,
        );
      }
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
    // Where each input landed, kept for the one path that needs it: a policy
    // refusal names the reads that carried the offending labels, and a read
    // is only actionable once it is back to the key the caller passed.
    const suppliedInputKeys: string[] = [];
    const inputAddresses: RunPatternInputAddress[] = [];
    if (input.inputs !== undefined) {
      const converted: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(input.inputs)) {
        suppliedInputKeys.push(key);
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
            const linkHash = comparableEntityHash(link.id);
            if (linkHash !== undefined) {
              inputAddresses.push({ key, hash: linkHash, path: link.path });
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
    // The indexed program is fetched here, on the trusted host side, and goes
    // straight into the compiler. Nothing read from the index is carried into
    // any output this tool returns.
    let program: RuntimeProgram;
    // What the index recorded the fetched pattern composes, when the run named
    // one. A published pattern's own imports are materialized on the same
    // terms as an authored source's.
    let recordedDependencies: readonly string[] = [];
    if (sourceText !== undefined) {
      program = {
        main: RUN_PATTERN_SOURCE_MAIN,
        files: [{ name: RUN_PATTERN_SOURCE_MAIN, contents: sourceText }],
      };
    } else if (patternId !== undefined && getPatternIndexClient !== undefined) {
      let indexed;
      try {
        const client = await getPatternIndexClient();
        indexed = await client.getPattern({
          patternId,
          includeSource: true,
        });
      } catch (error) {
        // `PatternIndexError.message` is stable by construction; the service
        // body it withheld can quote indexed source, so it goes only to the
        // artifact.
        return {
          ...errorOutput(
            "error",
            `pattern index lookup failed for "${patternId}": ${
              errorMessage(error)
            }`,
          ),
          ...(error instanceof PatternIndexError && error.detail !== undefined
            ? { rawCauseMessage: error.detail }
            : {}),
        };
      }
      if (indexed.program === undefined) {
        return errorOutput(
          "error",
          `the pattern index returned no program for "${patternId}"`,
        );
      }
      program = runtimeProgramFromIndex(indexed.program);
      recordedDependencies = indexed.dependencies;
    } else {
      // Unreachable: a call naming neither was refused above, and one naming
      // a `patternId` without an index with it. The pair's exclusivity is a
      // fact about those checks rather than about the input type, so the
      // branch is written out instead of asserted away.
      return errorOutput("error", RUN_PATTERN_NO_PROGRAM_MESSAGE);
    }
    // A `cf:pattern:` import resolves from the space's own source cache, and
    // for a pattern this space has never run there is nothing there to
    // resolve. Each one is fetched from the index and compiled into the space
    // first, host-side, so the compile below finds it — and so no part of what
    // was fetched reaches this tool's output, on the success path or on any of
    // the failure paths.
    try {
      await materializeComposedPatterns({
        runtime: pieces.runtime,
        space,
        patternIds: composedPatternIds(program, recordedDependencies),
        getClient: getPatternIndexClient,
      });
    } catch (error) {
      if (error instanceof PatternCompositionError) {
        return {
          ...errorOutput("error", error.message),
          ...(error.rawCauseMessage !== undefined
            ? { rawCauseMessage: error.rawCauseMessage }
            : {}),
        };
      }
      return {
        ...errorOutput(
          "error",
          "the published patterns this source composes could not be made available; the failure text is retained in the run artifact and withheld here, since it can quote source you did not author",
        ),
        rawCauseMessage: errorMessage(error),
      };
    }
    let pattern;
    try {
      pattern = await compileAndSavePattern(pieces.runtime, program, {
        space,
      });
    } catch (error) {
      // Compiler diagnostics are the model's feedback loop for source it
      // wrote, so the full message goes into the artifact; the prompt loop
      // scrubs bare fabric identifiers from the model-facing rendering. An
      // indexed pattern is source the model never saw and cannot correct, and
      // a diagnostic quotes the line it failed on, so there the artifact
      // keeps the diagnostic and the model gets the fact of the failure.
      return patternId === undefined
        ? errorOutput("compile-error", errorMessage(error))
        : {
          ...errorOutput(
            "compile-error",
            `the indexed pattern "${patternId}" did not compile; the diagnostic is retained in the run artifact and withheld here, since it quotes source you did not author`,
          ),
          rawCauseMessage: errorMessage(error),
        };
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
    // The same window over what the runtime materializes, for the check that
    // the created piece carries a pointer another runtime can load. A session
    // built without an instantiation recorder asks nothing.
    const instantiationStart = session.instantiations?.sequence() ?? 0;
    /**
     * Reports this invocation's outcome to the index, when the pattern came
     * from there. A cancelled run reports nothing: it neither succeeded nor
     * failed, and the index ranks on what a pattern did.
     */
    const recordOutcome = (eventType: PatternIndexEventType): void => {
      if (patternId !== undefined && getPatternIndexClient !== undefined) {
        recordPatternIndexEvent(getPatternIndexClient, patternId, eventType);
      }
    };
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
      recordOutcome("run_failed");
      // The pattern's own body runs inside this call, so what it throws can
      // quote the source it was written from. For source the model wrote
      // that is its feedback loop; for an indexed pattern it is source the
      // model never saw, so the artifact keeps the text and the model gets
      // the fact of the failure — the same division the compile path makes.
      return patternId === undefined
        ? errorOutput("error", errorMessage(error))
        : {
          ...errorOutput(
            "error",
            `the indexed pattern "${patternId}" failed while starting; the failure text is retained in the run artifact and withheld here, since it can quote source you did not author`,
          ),
          rawCauseMessage: errorMessage(error),
        };
    }
    recordOutcome("instantiated");
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
    // A piece whose graph was materialized under a session-synthetic pattern
    // pointer exists for this session and no other: a fresh runtime asked to
    // open it cannot resolve the pointer at all. This session renders
    // nothing, so any keyless instantiation in the window is that shape (see
    // `keylessInstantiation`). The run is reported as a failure rather than
    // handed back as a piece that dies on the first visit, and the pattern is
    // not contributed to the index below, since the same shape would strand
    // every later run that ran it.
    const strandedInstantiation = session.instantiations === undefined
      ? undefined
      : keylessInstantiation(
        session.instantiations.keylessSince(instantiationStart),
      );
    if (strandedInstantiation !== undefined) {
      recordOutcome("run_failed");
      return {
        ...errorOutput(
          "error",
          `the pattern ran, but the piece it created can only be opened by this session, so the run is reported as a failure. This is the shape a factory takes when it returns a derived wrapper — a computed() or a lift() over the whole result — instead of the result itself: the wrapper becomes the piece's own body, and nothing durable names it. Return the result object literal directly and put computed() on the individual fields that derive from an input`,
        ),
        pieceId: piece.id,
        rawCauseMessage:
          `pattern materialized under session-only identity ${strandedInstantiation.identity}#${strandedInstantiation.symbol} on entity ${strandedInstantiation.cell}`,
      };
    }
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
        recordOutcome("run_failed");
        // The piece's argument document is where every input reaches the
        // pattern under its own key, so a refused read of it names an input
        // by its first path segment. Its address is resolved here rather
        // than kept from creation because only a refusal asks for it, and an
        // argument cell that will not resolve costs that second route to a
        // key while the caller's own resolved addresses still answer.
        let argumentHash: string | undefined;
        try {
          argumentHash = comparableEntityHash(
            (await piece.input.getCell()).getAsNormalizedFullLink().id,
          );
        } catch {
          argumentHash = undefined;
        }
        const policyRefusal = runPatternPolicyRefusal(
          refusal.refusals ?? [],
          (read) =>
            refusalReadInputKey(
              read,
              inputAddresses,
              argumentHash,
              suppliedInputKeys,
            ),
        );
        return {
          ...errorOutput(
            "error",
            policyRefusal === undefined
              ? RUN_PATTERN_OPAQUE_REFUSAL_MESSAGE
              : policyRefusalMessage(policyRefusal),
          ),
          pieceId: piece.id,
          rawCauseMessage: refusal.message,
          ...(policyRefusal !== undefined ? { policyRefusal } : {}),
        };
      }
      if (pieceErrors.length > 0) {
        // The thrown text stays out of the model-facing message: a
        // computation over data the model cannot read may carry that data in
        // what it throws, so the artifact keeps the diagnostic and the model
        // gets the fact of the failure.
        recordOutcome("run_failed");
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
        recordOutcome("run_failed");
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
    // A result the caller's own `resultSchema` refused is reported as neither
    // outcome: the pattern ran and landed a result, and the schema it did not
    // match was written by whoever called the tool, so it is evidence about
    // the caller's contract rather than about the pattern.
    if (valueError === undefined) {
      recordOutcome("run_succeeded");
    }
    /**
     * The render gate: what the pattern's own `$UI` does before the pattern
     * is contributed to the index.
     *
     * The render runs against a PROBE — a second, detached instance of the
     * same compiled pattern, built from a synthetic instance of the pattern's
     * own argument schema rather than from this run's inputs. The run's own
     * piece is never rendered, so no labeled data reaches the render through
     * the argument path. A pattern that reaches the space for itself is the
     * case that argument does not cover; `pattern-index/publish-render-gate.ts`
     * carries the whole of the reasoning, including what the verdict may say.
     *
     * The probe is unregistered like the run's own piece, and its `cause` is
     * left to default, so each check gets a piece with no state carried over
     * from an earlier one.
     *
     * A verdict never bears on the run: every path returns a verdict, and the
     * caller's only use for it is whether to publish.
     */
    const renderGateVerdict = async (): Promise<
      {
        status: PatternPublicationStatus;
        reason: PatternPublicationReason;
        syntheticInputsComplete: boolean;
        html?: string;
      } | "cancelled"
    > => {
      const synthetic = syntheticArgument(pattern.argumentSchema);
      const recorded = (reason: PatternPublicationReason, html?: string) => ({
        status: "recorded" as const,
        reason,
        syntheticInputsComplete: synthetic.complete,
        ...(html !== undefined ? { html } : {}),
      });
      const discoverable = (
        reason: PatternPublicationReason,
        html?: string,
      ) => ({
        status: "discoverable" as const,
        reason,
        syntheticInputsComplete: synthetic.complete,
        ...(html !== undefined ? { html } : {}),
      });
      let probeCell: Cell<unknown> | undefined;
      try {
        probeCell = await pieces.runPersistent(
          pattern,
          synthetic.value,
          undefined,
          { start: true },
        );
        const settle = (async () => {
          await pieces.runtime.settled();
          await pieces.synced();
        })();
        if (await raceWithAbort(settle, signal) === "aborted") {
          return "cancelled";
        }
        const probeResult = await new PieceController(pieces, probeCell)
          .result.getCell();
        if (signal?.aborted === true) return "cancelled";
        let rendered: Awaited<ReturnType<typeof renderPatternUiToHtml>>;
        const render = (async () => {
          rendered = await renderPatternUiToHtml(
            probeResult,
            () => pieces.runtime.idle(),
          );
        })();
        if (await raceWithAbort(render, signal) === "aborted") {
          return "cancelled";
        }
        if (rendered === undefined) {
          return discoverable("no-ui");
        }
        const html = rendered.html.length > PROBE_HTML_MAX_CHARS
          ? `${
            rendered.html.slice(0, PROBE_HTML_MAX_CHARS)
          }\n[truncated at ${PROBE_HTML_MAX_CHARS} characters]`
          : rendered.html;
        const reason = classifyRenderedHtml(rendered.html);
        // A default-`toString` in the output is positive evidence of a
        // defect, and keeps the entry out of search however thin the
        // synthetic instance was or whatever else the render reported. A
        // render the reconciler complained about is no evidence either way,
        // and is recorded as such rather than read as a pass.
        if (reason === "ui-default-tostring") return recorded(reason, html);
        if (rendered.errors.length > 0) return recorded("probe-failed", html);
        if (reason === "ui-rendered-empty") return recorded(reason, html);
        return discoverable(reason, html);
      } catch (error) {
        // An abort can land inside an await this function does not race —
        // starting the probe, or loading its result cell — and arrives here
        // as an ordinary throw. Reading that as "no verdict" would publish
        // under a run that was cancelled, which is the defect the raced
        // aborts above exist to prevent, so the signal is consulted before
        // the throw is interpreted.
        if (signal?.aborted === true) return "cancelled";
        // What a probe throws is the pattern's own text, which the artifact
        // keeps for the run's own failure paths and which has no reading here
        // beyond "no verdict". A defect in the GATE lands here too and reads
        // identically from outside, so its text goes to the artifact rather
        // than nowhere — a check that fails silently for its own reasons is
        // the failure this gate exists to remove.
        return recorded("probe-failed", errorMessage(error));
      } finally {
        if (probeCell !== undefined) {
          try {
            pieces.runtime.runner.stop(probeCell);
          } catch {
            // Best-effort: the verdict stands either way.
          }
        }
      }
    };
    // Source the model wrote and successfully ran is contributed back to the
    // index, so the next run that needs this capability can find it instead
    // of writing it again — CAN, because recording and being offered to
    // search are separate here. Everything that ran is recorded; the render
    // gate below decides discoverability, and the session's ledger gives one
    // discoverable entry per capability. A run naming a `patternId` records
    // nothing: it ran what the index already holds.
    const description = input.description?.trim();
    let publication: RunPatternPublicationReport | undefined;
    let probeHtml: string | undefined;
    if (
      patternId === undefined &&
      getPatternIndexClient !== undefined &&
      context.patternIndexPublishEnabled === true &&
      description !== undefined && description !== ""
    ) {
      // The compile's own entry identity, which is the identity the index
      // stores a pattern under. Taken from the compiled artifact rather than
      // recomputed over the source, so it holds for a program the light
      // identity path does not model: a source composing `cf:pattern:`
      // imports folds each imported pattern's identity into the entry's.
      const entryIdentity = pieces.runtime.patternManager
        .getArtifactEntryRef(pattern)?.identity;
      // A keyless identity names a pattern only within the session that
      // minted it, so publishing under one would put an entry in the index
      // that no other runtime can ever load.
      if (
        entryIdentity === undefined ||
        PatternManager.isKeylessPatternIdentity(entryIdentity)
      ) {
        console.error(
          "run_pattern could not publish the pattern it ran: the compiled pattern carries no durable content-addressed entry identity",
        );
      } else {
        const verdict = await renderGateVerdict();
        // A cancelled gate is a cancelled run. Nothing is staged: an index
        // entry is a claim about a run that finished, and this one did not.
        if (verdict === "cancelled") {
          return cancelledOutput(
            `the pattern ran and created piece ${piece.id}, which is not undone; it was not contributed to the pattern index`,
          );
        }
        publication = {
          status: verdict.status,
          reason: verdict.reason,
          message: PATTERN_PUBLICATION_MESSAGES[verdict.reason],
          syntheticInputsComplete: verdict.syntheticInputsComplete,
        };
        // The rendered DOM is kept only for a verdict someone may have to
        // adjudicate — why an entry is not offered to search. A pass has
        // nothing to adjudicate and the entry is discoverable, so the pattern
        // can be looked at directly. Narrowing it this way is not a fix for
        // the artifact root being readable through `bash` (CT-2117); it
        // simply stops writing this into that root on the runs where it earns
        // nothing, which is most of them.
        probeHtml = verdict.status === "recorded" ? verdict.html : undefined;
        {
          const request: PatternIndexPublishRequest = {
            patternId: entryIdentity,
            program: {
              main: program.main,
              files: program.files.map((file) => ({
                name: file.name,
                contents: file.contents,
              })),
            },
            description,
            hashtags: input.hashtags ?? [],
            // What the pattern was written to answer. The run's own task is
            // that request; a run carrying no task text has only the model's
            // description of what it wrote, which is the same claim in the
            // model's words.
            directQuery: context.taskText ?? description,
            argumentSchema: pattern.argumentSchema,
            resultSchema: pattern.resultSchema,
            dependencies: patternIndexDependencies(program.files),
            // Recording and surfacing are separate. Everything that ran is
            // recorded; the gate decides only whether search offers it.
            ...(verdict.status === "recorded"
              ? {
                nonDiscoverable: {
                  reason: PATTERN_DISCOVERABILITY_REASONS[verdict.reason],
                },
              }
              : {}),
          };
          // The session's ledger publishes once per capability, at the end of
          // the session. A run invoked without one — a direct call rather
          // than one through the engine — publishes as it goes.
          if (context.patternIndexPublications !== undefined) {
            context.patternIndexPublications.stage(request);
          } else {
            publishPatternToIndex(getPatternIndexClient, request);
          }
        }
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
      ...(publication !== undefined ? { patternPublication: publication } : {}),
      ...(probeHtml !== undefined ? { rawCauseMessage: probeHtml } : {}),
    };
  },
};
