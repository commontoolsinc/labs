import type { JSONSchema } from "@commonfabric/api";
import { schemaToTypeString } from "@commonfabric/runner";
import type { HarnessToolDescriptor } from "../contracts/tool-descriptor.ts";
import type {
  PatternIndexClient,
  PatternIndexSignals,
} from "../pattern-index/client.ts";
import type { HarnessToolDefinition } from "./types.ts";

export interface SearchPatternsToolInput {
  tags?: readonly string[];
  text?: string;
}

/** Hits reported to the model. Beyond this the model narrows its query. */
export const SEARCH_PATTERNS_MAX_RESULTS = 10;

/**
 * Hits whose declared shapes are fetched. Each costs one `getPattern` round
 * trip, and the shapes are what the model needs to decide between the leading
 * candidates rather than to skim the tail.
 */
export const SEARCH_PATTERNS_MAX_DETAILED_RESULTS = 5;

export interface SearchPatternsToolResult {
  patternId: string;
  description: string;
  hashtags: readonly string[];
  signals?: PatternIndexSignals;

  /**
   * The import specifier this pattern is composed through, written out so it
   * can be copied into pattern source as it stands.
   */
  importHint: string;

  /** The pattern's argument shape, as a TypeScript type. */
  argumentType?: string;

  /** The pattern's result shape, as a TypeScript type. */
  resultType?: string;
}

export interface SearchPatternsToolSuccessOutput {
  outputId: string;
  status: "ok";
  results: readonly SearchPatternsToolResult[];
}

export interface SearchPatternsToolErrorOutput {
  outputId: string;
  status: "error";
  message: string;
}

export type SearchPatternsToolOutput =
  | SearchPatternsToolSuccessOutput
  | SearchPatternsToolErrorOutput;

export const searchPatternsToolDescriptor: HarnessToolDescriptor = {
  toolId: "search_patterns",
  title: "Search Patterns",
  description:
    "Search the pattern index for published Common Fabric patterns by hashtag or free text. Answers with each pattern's id, description, declared argument and result shapes, and the import specifier that composes it — never its source. Run one with run_pattern's patternId argument.",
  effectClass: "read",
  inputSchema: {
    type: "object",
    properties: {
      tags: {
        type: "array",
        items: { type: "string" },
        description:
          "Hashtags a pattern must carry. Omit to search on text alone.",
      },
      text: {
        type: "string",
        description:
          "Free text matched against pattern descriptions. Omit to search on tags alone.",
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
        results: {
          type: "array",
          items: {
            type: "object",
            properties: {
              patternId: { type: "string" },
              description: { type: "string" },
              hashtags: { type: "array", items: { type: "string" } },
              signals: {
                type: "object",
                properties: {
                  uses: { type: "number" },
                  score: { type: "number" },
                },
                required: ["uses", "score"],
                additionalProperties: false,
              },
              importHint: { type: "string" },
              argumentType: { type: "string" },
              resultType: { type: "string" },
            },
            required: ["patternId", "description", "hashtags", "importHint"],
            additionalProperties: false,
          },
        },
      },
      required: ["outputId", "status", "results"],
      additionalProperties: false,
    }, {
      type: "object",
      properties: {
        outputId: { type: "string" },
        status: { type: "string", enum: ["error"] },
        message: { type: "string" },
      },
      required: ["outputId", "status", "message"],
      additionalProperties: false,
    }],
  } satisfies JSONSchema,
  tags: ["fabric", "pattern", "search"],
};

/**
 * The specifier that composes a published pattern into pattern source. The
 * `cf:pattern:` scheme addresses the index entry, so a composing pattern
 * names what it depends on rather than copying it.
 */
export const patternIndexImportHint = (patternId: string): string =>
  `import X from "cf:pattern:${patternId}"`;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Renders a declared schema as a TypeScript type, or `undefined` when the
 * pattern declares none. A schema that cannot be rendered is reported as
 * absent: the search answers with what is known, and a shape it cannot write
 * down is not known.
 */
const declaredType = (schema: JSONSchema | undefined): string | undefined => {
  if (schema === undefined) {
    return undefined;
  }
  try {
    return schemaToTypeString(schema);
  } catch {
    return undefined;
  }
};

export const searchPatternsTool: HarnessToolDefinition<
  SearchPatternsToolInput,
  SearchPatternsToolOutput
> = {
  descriptor: searchPatternsToolDescriptor,
  async invoke(context, input) {
    const outputId = context.nextOutputId("search_patterns");
    const errorOutput = (message: string): SearchPatternsToolErrorOutput => ({
      outputId,
      status: "error",
      message,
    });
    if (context.getPatternIndexClient === undefined) {
      return errorOutput(
        "search_patterns requires a pattern index; configure --pattern-index-url",
      );
    }
    if (input.tags === undefined && input.text === undefined) {
      return errorOutput("search_patterns requires tags, text, or both");
    }
    let client: PatternIndexClient;
    try {
      client = await context.getPatternIndexClient();
    } catch (error) {
      return errorOutput(`pattern index unavailable: ${errorMessage(error)}`);
    }
    let response;
    try {
      response = await client.searchPatterns({
        ...(input.tags !== undefined ? { tags: input.tags } : {}),
        ...(input.text !== undefined ? { text: input.text } : {}),
        limit: SEARCH_PATTERNS_MAX_RESULTS,
      });
    } catch (error) {
      return errorOutput(errorMessage(error));
    }
    const hits = response.results.slice(0, SEARCH_PATTERNS_MAX_RESULTS);
    // The declared shapes ride on the pattern record rather than on a search
    // hit, so the leading candidates are read back individually. Source is
    // deliberately not requested: what a pattern is FOR and what it takes and
    // returns is what a composing model needs, and its source is neither.
    const detailed = await Promise.all(
      hits.slice(0, SEARCH_PATTERNS_MAX_DETAILED_RESULTS).map(async (hit) => {
        try {
          return await client.getPattern({
            patternId: hit.patternId,
            includeSource: false,
          });
        } catch {
          // A shape that could not be read leaves the hit reported without
          // one; the search itself succeeded.
          return undefined;
        }
      }),
    );
    const results = hits.map((hit, index): SearchPatternsToolResult => {
      const pattern = detailed[index];
      const argumentType = declaredType(pattern?.argumentSchema);
      const resultType = declaredType(pattern?.resultSchema);
      return {
        patternId: hit.patternId,
        description: hit.description,
        hashtags: hit.hashtags,
        ...(hit.signals !== undefined ? { signals: hit.signals } : {}),
        importHint: patternIndexImportHint(hit.patternId),
        ...(argumentType !== undefined ? { argumentType } : {}),
        ...(resultType !== undefined ? { resultType } : {}),
      };
    });
    return { outputId, status: "ok", results };
  },
};
