import type { JSONSchema } from "@commonfabric/api";
import { parseLLMFriendlyLink } from "@commonfabric/runner/shared";
import type { HarnessToolDescriptor } from "../contracts/tool-descriptor.ts";
import { resolveHandleToken } from "../handle-table.ts";
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
  /** Whether the entry carries a recorded schema. */
  hasSchema: boolean;
  /** The recorded schema, when the entry carries one. */
  schema?: JSONSchema;
  /**
   * Path segments of the referent within its piece — which field of which
   * piece the token names. Read off the entry's already-parsed reference, so
   * it costs nothing and reveals no value.
   */
  path?: string[];
}

/**
 * Describes the SHAPE of a handle's referent and nothing else: the recorded
 * schema when the mint captured one, otherwise whatever structure the entry
 * already carries. The cell is never dereferenced and no value is ever read,
 * so an answer here says what a reference is, never what it holds. This is
 * what lets an orchestrator verify a chain of transformations without reading
 * the data flowing through it: a reference plus its shape is checkable, a
 * bare token is not.
 *
 * Privacy posture, stated plainly: a schema is itself information — property
 * names can be as telling as values, and `path` names a field. This is a read
 * of shape rather than of content, currently unrestricted for any run that
 * holds the token, and a candidate for policy gating alongside the other
 * observation boundaries.
 *
 * A schema the table does not hold is reported as absent rather than fetched.
 * Resolving one from the session's fabric — reading the referent's declared
 * schema without reading its value — is a possible future extension; it would
 * need the fabric-session gate `run_pattern` carries, which this tool
 * deliberately does not, so that shape stays inspectable in every run that has
 * handles at all.
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

export const describeHandleTool: HarnessToolDefinition<
  DescribeHandleToolInput,
  DescribeHandleToolOutput
> = {
  descriptor: describeHandleToolDescriptor,
  invoke(context, input) {
    const outputId = context.nextOutputId("describe_handle");
    const token = typeof input.token === "string" ? input.token.trim() : "";
    const entry = context.handleTable === undefined
      ? undefined
      : resolveHandleToken(context.handleTable, token);
    if (entry === undefined) {
      // An unknown token is an ordinary answer, not a failure: a token from
      // another run, or one the model invented, simply names nothing here.
      return Promise.resolve({
        outputId,
        token,
        known: false,
        hasSchema: false,
      });
    }
    const path = pathSegmentsOf(entry.ref);
    return Promise.resolve({
      outputId,
      token: entry.token,
      known: true,
      hasSchema: entry.schema !== undefined,
      ...(entry.schema !== undefined ? { schema: entry.schema } : {}),
      ...(path !== undefined ? { path } : {}),
    });
  },
};
