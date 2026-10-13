/**
 * `call_verb` sends an event to a verb of a piece the run holds: the one way
 * a pattern changes its own state, reached from a model the way
 * `cf piece call` reaches it from a shell.
 *
 * The verb is found, and its event judged, by the same code `cf piece call`
 * uses — the listing in `@commonfabric/piece/verb-listing` and the gate in
 * `@commonfabric/piece/verb-input` — so a call the command line refuses is
 * refused here too, in the same words, and a refused call sends nothing.
 * `describe_handle` lists the verbs a piece handle has from that same listing,
 * which is where a model learns what to call.
 *
 * The handler runs in the run's own runtime, against the session's space. What
 * it returns comes back the way a `run_pattern` result does: measured against
 * the release ceiling first, then reduced to what the verb's declared result
 * can release as itself, with every other position handed back as a reference
 * into the handling's receipt.
 */

import type { JSONSchema } from "@commonfabric/api";
import { callVerb, type VerbCall } from "@commonfabric/piece/verb-call";
import { isLink } from "@commonfabric/runner";
import { describeSinkReleaseRefusal } from "@commonfabric/runner/cfc";
import { localRefTarget } from "@commonfabric/runner/cfc/schema-sanitization";
import { createLLMFriendlyLink } from "@commonfabric/runner/shared";
import { isObjectNotArray } from "@commonfabric/utils/types";
import {
  HANDLE_TOKEN_PATTERN,
  REFERENT_TOKEN_PATTERN,
} from "../contracts/handle-table.ts";
import type { HarnessToolDescriptor } from "../contracts/tool-descriptor.ts";
import { errorMessage } from "../error-message.ts";
import { scrubBareFabricIdentifiers } from "../fabric-identifier-scrub.ts";
import { schemaShapeOnly } from "../schema-shape.ts";
import {
  addressSealedPositions,
  validateAndSanitizeStructuredResult,
} from "../structured-result.ts";
import { resolvePiece, sessionPieces } from "./piece-source.ts";
import {
  asSerializableValue,
  raceWithAbort,
  sealedPositionLink,
} from "./run-pattern.ts";
import type { HarnessToolDefinition } from "./types.ts";

export interface CallVerbToolInput {
  token: string;
  verb: string;
  event?: unknown;
}

export interface CallVerbToolSuccessOutput {
  outputId: string;
  status: "ok";

  /** The verb that ran, echoed so a reply stands on its own. */
  verb: string;

  /**
   * What the verb returned, as far as its declared result releases it: a
   * number, a boolean or a null comes back as itself, and every other
   * position as a reference into {@link resultRef}. Absent when the verb
   * returns nothing, or when the release boundary withheld it.
   */
  result?: unknown;

  /**
   * The handling's receipt, where the verb's result is stored. Absent when
   * the runtime wrote no receipt.
   */
  resultRef?: string;

  /** Why {@link result} is absent although the verb returned one. */
  message?: string;
}

export interface CallVerbToolErrorOutput {
  outputId: string;
  status: "error";
  message: string;
}

export type CallVerbToolOutput =
  | CallVerbToolSuccessOutput
  | CallVerbToolErrorOutput;

/** The sink a verb's result is released to, named in a release refusal. */
const CALL_VERB_ANSWER_SINK = "call_verb";

export const callVerbToolDescriptor: HarnessToolDescriptor = {
  toolId: "call_verb",
  title: "Call Verb",
  description:
    "Send an event to a verb of a piece behind a handle token, running the piece's handler for it — the way a pattern changes its own state. describe_handle on the piece's token lists its verbs, each with the event schema it takes and the result schema it returns; call one of those by name with an event that satisfies its schema. Where the event takes a piece, pass that piece's handle token, never a copy of its fields. An event the verb does not declare, a missing required field, a copy where a reference is declared, or a name that is not a verb is refused before anything is sent, so a refused call changed nothing. Returns the verb's result: numbers, booleans and nulls as themselves, a piece the verb returns as its handle token, and other values as reference tokens you can describe_handle or wire into run_pattern. The piece must be in this run's own space.",
  effectClass: "side-effect",
  inputSchema: {
    type: "object",
    properties: {
      token: {
        type: "string",
        description:
          "A handle token of the form cfh:a:<suffix> naming the piece.",
      },
      verb: {
        type: "string",
        description: "The verb's name, as describe_handle lists it.",
      },
      event: {
        description:
          "The event to send, satisfying the verb's event schema. Omit it for a verb that takes none.",
      },
    },
    required: ["token", "verb"],
    additionalProperties: false,
  } satisfies JSONSchema,
  outputSchema: {
    type: "object",
    properties: {
      outputId: { type: "string" },
      status: { enum: ["ok", "error"] },
      verb: { type: "string" },
      result: {},
      resultRef: { type: "string" },
      message: { type: "string" },
    },
    required: ["outputId", "status"],
    additionalProperties: false,
  } satisfies JSONSchema,
  tags: ["fabric", "piece", "verb"],
};

/** The first string in `event` that is a whole handle token, at any depth. */
const firstTokenIn = (event: unknown): string | undefined => {
  if (typeof event === "string") {
    const whole = (pattern: RegExp) =>
      new RegExp(`^${pattern.source}$`).test(event);
    return whole(HANDLE_TOKEN_PATTERN) || whole(REFERENT_TOKEN_PATTERN)
      ? event
      : undefined;
  }
  if (Array.isArray(event)) {
    for (const element of event) {
      const found = firstTokenIn(element);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (isObjectNotArray(event)) return firstTokenIn(Object.values(event));
  return undefined;
};

/** The schema the result sanitizer keeps a `{"@link": …}` object under. */
const OPAQUE_LINK_SCHEMA = {
  type: "object",
  properties: { "@link": { type: "string" } },
  required: ["@link"],
  additionalProperties: false,
} as const satisfies JSONSchema;

/**
 * Every path within a receipt's stored value at which it holds a link rather
 * than a value: the positions where the verb returned a reference to another
 * cell, a piece it created or was handed among them.
 */
const storedLinkPaths = (
  raw: unknown,
  path: readonly (string | number)[] = [],
): (string | number)[][] => {
  if (isLink(raw)) return [[...path]];
  if (Array.isArray(raw)) {
    return raw.flatMap((element, index) =>
      storedLinkPaths(element, [...path, index])
    );
  }
  if (isObjectNotArray(raw)) {
    return Object.entries(raw).flatMap(([key, child]) =>
      storedLinkPaths(child, [...path, key])
    );
  }
  return [];
};

/** `value` with `replacement` at `path`, or `value` itself where the path
 * does not reach. Copies only the containers along the path. */
const replacedAt = (
  value: unknown,
  path: readonly (string | number)[],
  replacement: unknown,
): unknown => {
  if (path.length === 0) return replacement;
  const [head, ...rest] = path;
  if (Array.isArray(value) && typeof head === "number" && head < value.length) {
    const copy = [...value];
    copy[head] = replacedAt(value[head], rest, replacement);
    return copy;
  }
  if (isObjectNotArray(value) && Object.hasOwn(value, String(head))) {
    return {
      ...value,
      [head]: replacedAt(value[String(head)], rest, replacement),
    };
  }
  return value;
};

/**
 * `schema` declaring an opaque link at `path`, so the result sanitizer keeps
 * the `{"@link": …}` object a reference is handed back as instead of judging
 * it against the shape of what it points at. An array's elements share one
 * schema, so an element position admits the link beside what it already
 * admitted. `root` is the document local references resolve against.
 */
const withOpaqueLinkAt = (
  schema: JSONSchema,
  root: JSONSchema,
  path: readonly (string | number)[],
): JSONSchema => {
  if (path.length === 0) return OPAQUE_LINK_SCHEMA;
  const node = localRefTarget(schema, root);
  if (!isObjectNotArray(node)) return schema;
  const [head, ...rest] = path;
  if (typeof head === "number") {
    const items = node.items as JSONSchema | undefined;
    if (items === undefined) return schema;
    const element = withOpaqueLinkAt(items, root, rest);
    return {
      ...node,
      items: rest.length === 0 ? { anyOf: [items, element] } : element,
    } as JSONSchema;
  }
  const properties = isObjectNotArray(node.properties)
    ? node.properties as Record<string, JSONSchema>
    : {};
  const child = properties[head] ??
    (isObjectNotArray(node.additionalProperties)
      ? node.additionalProperties as JSONSchema
      : {});
  return {
    ...node,
    properties: {
      ...properties,
      [head]: withOpaqueLinkAt(child, root, rest),
    },
  } as JSONSchema;
};

export const callVerbTool: HarnessToolDefinition<
  CallVerbToolInput,
  CallVerbToolOutput
> = {
  descriptor: callVerbToolDescriptor,
  async invoke(context, input) {
    const outputId = context.nextOutputId("call_verb");
    const fail = (message: string): CallVerbToolErrorOutput => ({
      outputId,
      status: "error",
      message: scrubBareFabricIdentifiers(message),
    });
    const ref = typeof input.token === "string" ? input.token.trim() : "";
    if (ref.length === 0) {
      return fail("call_verb requires a token naming a piece");
    }
    const name = typeof input.verb === "string" ? input.verb.trim() : "";
    if (name.length === 0) {
      return fail("call_verb requires the name of a verb");
    }
    const session = await sessionPieces("call_verb", context);
    if (!session.ok) return fail(session.message);
    const { pieces } = session;
    const piece = await resolvePiece("call_verb", pieces, ref);
    if (!piece.ok) return fail(piece.message);

    // A token the run holds reached this tool as the address it stands for,
    // so one still written as a token is one the run does not hold.
    const unheld = firstTokenIn(input.event);
    if (unheld !== undefined) {
      return fail(
        `the event for "${name}" was refused before it was sent: ${unheld} is not a handle this run holds`,
      );
    }

    const { runtime } = pieces;
    let called: VerbCall | undefined;
    const calling = callVerb(
      runtime,
      piece.cell.getAsNormalizedFullLink(),
      name,
      input.event,
    ).then((value) => {
      called = value;
    });
    if (await raceWithAbort(calling, context.signal) === "aborted") {
      return fail("call_verb was cancelled before the verb's handling settled");
    }
    // SHORTCUT (2026-10-12): a failing handler's message, its thrown text
    // included, reaches the model as written. A handler over data the model
    // cannot read may carry that data in what it throws, and a pattern's
    // author can write instructions there. To harden, measure the failure
    // against the release ceiling as the result below is, and withhold it
    // where the ceiling refuses it.
    if (called!.status !== "settled") return fail(called!.message);

    const receipt = called!.receipt;
    if (receipt === undefined) return { outputId, status: "ok", verb: name };
    const space = pieces.getSpace();
    const resultRef = createLLMFriendlyLink(receipt, space);

    // The receipt is read through a transaction of its own, so what it read
    // is exactly what the ceiling is measured against, and the transaction is
    // abandoned once it has been measured.
    const releaseTx = runtime.edit();
    let raw: unknown;
    let value: unknown;
    let withheld: boolean;
    try {
      const measured = runtime.getCellFromLink(receipt).withTx(releaseTx);
      await measured.pull();
      raw = measured.getRaw();
      value = asSerializableValue(measured.get());
      const releaseGateRejects = runtime.cfcEnforcementMode !== "disabled" &&
        runtime.cfcEnforcementMode !== "observe";
      withheld = releaseGateRejects &&
        describeSinkReleaseRefusal(
            releaseTx,
            releaseTx,
            CALL_VERB_ANSWER_SINK,
            [],
          ) !== undefined;
    } finally {
      releaseTx.abort("call_verb release measurement");
    }
    if (value === undefined || called!.result === undefined) {
      return { outputId, status: "ok", verb: name, resultRef };
    }
    if (withheld) {
      return {
        outputId,
        status: "ok",
        verb: name,
        resultRef,
        message:
          "the verb's result was withheld: what it carries is above the run's release ceiling",
      };
    }
    try {
      // The declared result reduced to structure decides what releases as
      // itself, so a string comes back as a reference however the author
      // constrained it. A position the receipt stores as a link is a
      // reference the verb returned, and goes back as the address of what it
      // points at — the piece a verb created comes back as that piece's
      // handle, not as a copy of its fields.
      const declared = schemaShapeOnly(called!.outputSchema ?? {});
      let shaped = declared;
      for (const path of storedLinkPaths(raw)) {
        const target = runtime.getCellFromLink({
          ...receipt,
          path: [...receipt.path, ...path.map(String)],
        }).resolveAsCell().getAsNormalizedFullLink();
        value = replacedAt(value, path, {
          "@link": createLLMFriendlyLink(target, space),
        });
        shaped = withOpaqueLinkAt(shaped, declared, path);
      }
      if (isObjectNotArray(declared) && declared.$defs !== undefined) {
        shaped = { ...(shaped as object), $defs: declared.$defs } as JSONSchema;
      }
      const sanitized = validateAndSanitizeStructuredResult({
        schema: shaped,
        value,
        opaqueHandleId: outputId,
      });
      return {
        outputId,
        status: "ok",
        verb: name,
        result: addressSealedPositions(
          sanitized.value,
          sanitized.sealedPaths,
          (path) => sealedPositionLink(receipt, path, space),
        ),
        resultRef,
      };
    } catch (error) {
      return {
        outputId,
        status: "ok",
        verb: name,
        resultRef,
        message: scrubBareFabricIdentifiers(
          `the verb's result does not match its declared result: ${
            errorMessage(error)
          }`,
        ),
      };
    }
  },
};
