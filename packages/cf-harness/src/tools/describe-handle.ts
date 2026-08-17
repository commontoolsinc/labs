import type { JSONSchema } from "@commonfabric/api";
import type { Cell } from "@commonfabric/runner";
import { parseLLMFriendlyLink } from "@commonfabric/runner/shared";
import type { HarnessToolDescriptor } from "../contracts/tool-descriptor.ts";
import type { HarnessFabricSession } from "../fabric-session.ts";
import { resolveHandleToken } from "../handle-table.ts";
import { schemaShapeOnly } from "../schema-shape.ts";
import type { HarnessToolDefinition } from "./types.ts";

export interface DescribeHandleToolInput {
  token: string;
}

export interface DescribeHandleToolOutput {
  outputId: string;
  /** The token as asked about, echoed so a reply stands on its own. */
  token: string;
  /** Whether this run's handle table holds the token. */
  known: boolean;
  /** Whether the entry carries a harness-derived schema to report. */
  hasSchema: boolean;
  /** The recorded schema, when the entry carries a harness-derived one. */
  schema?: JSONSchema;
  /**
   * Path segments of the referent within its piece — which field of which
   * piece the token names. Read off the entry's already-parsed reference, so
   * it costs nothing and reveals no value.
   */
  path?: string[];
}

/**
 * Describes the SHAPE of a handle's referent and nothing else: property
 * names, types, nesting, and required-ness. No value is ever read and none is
 * ever reported, so an answer here says what a reference is, never what it
 * holds. This is what lets an agent write code over a reference it was handed
 * — you cannot compute over data whose shape you do not know — and what lets
 * an orchestrator verify a chain of transformations without reading the data
 * flowing through it.
 *
 * Posture, stated plainly. Disclosing shape is a POLICY-GOVERNED read, and
 * the current default is permissive: any run that holds the token gets an
 * answer. That is defensible on the same ground declassification stands on
 * elsewhere, and it is the contract patterns already work under internally:
 * you cannot see the data, you can only describe the data flow.
 *
 * Two shapes can answer, in this order:
 *
 * 1. The schema the mint recorded out of the harness's OWN work — the result
 *    schema of a pattern this harness compiled and ran, marked
 *    `schemaSource: "harness"` on the entry.
 * 2. The schema the referent DECLARES in the fabric, read through the run's
 *    session when it has one. A piece's document schema is the result schema
 *    of the pattern behind it, which is the shape an agent holding a handle to
 *    that piece would be wiring into a pattern of its own. The read is of the
 *    document's declared schema and of nothing else; the referent's value is
 *    not read, and a reference outside the session's own space is not followed.
 *
 * Either way what leaves this tool is STRUCTURE. A JSON Schema is a place a
 * value can hide — `const`, `enum`, `default` and `examples` carry values
 * outright, and `title`, `description` and `pattern` carry free text whoever
 * authored the schema chose — and a fabric-declared schema was authored by
 * someone other than this run, quite possibly a person. So every disclosed
 * schema is rebuilt by {@link schemaShapeOnly} from an allowlist of structural
 * keywords, at every depth, before it is reported. Property names cross that
 * line because nothing can be written over data without them; prose and values
 * do not cross it at all.
 *
 * A run with no fabric session still answers from its own table, so shape
 * stays inspectable in every run that has handles at all.
 */
export const describeHandleToolDescriptor: HarnessToolDescriptor = {
  toolId: "describe_handle",
  title: "Describe Handle",
  description:
    "Report the shape of the referent behind a handle token: its recorded schema and path, never its value. Use it to check that a reference is the kind of thing a step expects before passing it on.",
  effectClass: "read",
  inputSchema: {
    type: "object",
    properties: {
      token: {
        type: "string",
        description: "A handle token of the form cfh:a:<suffix>.",
      },
    },
    required: ["token"],
    additionalProperties: false,
  } satisfies JSONSchema,
  outputSchema: {
    type: "object",
    properties: {
      outputId: { type: "string" },
      token: { type: "string" },
      known: { type: "boolean" },
      hasSchema: { type: "boolean" },
      schema: {},
      path: { type: "array", items: { type: "string" } },
    },
    required: ["outputId", "token", "known", "hasSchema"],
    additionalProperties: false,
  } satisfies JSONSchema,
  tags: ["handle", "shape"],
};

/**
 * Path segments of `ref`, or `undefined` when the reference names a piece
 * root or does not parse. Parsing is the only work done here — no lookup, no
 * read.
 */
const pathSegmentsOf = (ref: string): string[] | undefined => {
  try {
    const parsed = parseLLMFriendlyLink(
      ref.startsWith("/") ? ref : `/${ref}`,
    );
    return parsed.path.length > 0 ? parsed.path.map(String) : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The schema `ref` DECLARES in the session's fabric, or `undefined` when the
 * session cannot state one. A document's declared schema lives in its
 * metadata — for a piece it is the result schema of the pattern behind it —
 * and a reference into the document narrows that schema by its path, which is
 * a walk over the schema rather than a read of the data.
 *
 * A reference outside the session's own space is not followed: the session's
 * authority ends at its space, the same boundary `run_pattern` draws over its
 * inputs. Anything that goes wrong — an unparseable reference, a document
 * that does not exist, a path the schema does not describe — answers
 * `undefined`, since a shape the session cannot state is reported as absent
 * rather than as a failed call.
 */
const declaredSchemaOf = async (
  session: HarnessFabricSession,
  ref: string,
): Promise<JSONSchema | undefined> => {
  const { pieces } = session;
  const space = pieces.getSpace();
  let link;
  try {
    link = parseLLMFriendlyLink(ref.startsWith("/") ? ref : `/${ref}`, space);
  } catch {
    return undefined;
  }
  if (link.space !== space) {
    return undefined;
  }
  try {
    const root = pieces.runtime.getCellFromLink({
      ...link,
      path: [],
      schema: undefined,
    });
    await root.sync();
    const documentSchema = root.getMetaRaw("schema") as JSONSchema | undefined;
    if (link.path.length === 0) {
      return documentSchema ?? root.schema;
    }
    const described = documentSchema === undefined
      ? root
      : (root.asSchema(documentSchema) as Cell<unknown>);
    const referent = described.key(...link.path) as Cell<unknown>;
    await referent.sync();
    return referent.schema;
  } catch {
    return undefined;
  }
};

export const describeHandleTool: HarnessToolDefinition<
  DescribeHandleToolInput,
  DescribeHandleToolOutput
> = {
  descriptor: describeHandleToolDescriptor,
  async invoke(context, input) {
    const outputId = context.nextOutputId("describe_handle");
    const token = typeof input.token === "string" ? input.token.trim() : "";
    const entry = context.handleTable === undefined
      ? undefined
      : resolveHandleToken(context.handleTable, token);
    if (entry === undefined) {
      // An unknown token is an ordinary answer, not a failure: a token from
      // another run, or one the model invented, simply names nothing here.
      return {
        outputId,
        token,
        known: false,
        hasSchema: false,
      };
    }
    const path = pathSegmentsOf(entry.ref);
    // What the referent DECLARES answers first, because the question asked is
    // what is at this address and the document at it is the authority on
    // that. A recorded schema is second-best — it is what whichever step
    // minted the handle happened to know — and it answers when the run has no
    // session, or when the session can state no shape for the address.
    let schema: JSONSchema | undefined;
    if (context.getFabricSession !== undefined) {
      try {
        schema = await declaredSchemaOf(
          await context.getFabricSession(),
          entry.ref,
        );
      } catch {
        // A session that cannot be established leaves the record to answer,
        // which is what a run without one does anyway.
      }
    }
    if (schema === undefined && entry.schemaSource === "harness") {
      schema = entry.schema;
    }
    // Structure only: whatever the source, the reported schema is rebuilt
    // from structural keywords, so no value and no prose rides out on it.
    const disclosed = schema === undefined
      ? undefined
      : schemaShapeOnly(schema);
    return {
      outputId,
      token: entry.token,
      known: true,
      hasSchema: disclosed !== undefined,
      ...(disclosed !== undefined ? { schema: disclosed } : {}),
      ...(path !== undefined ? { path } : {}),
    };
  },
};
