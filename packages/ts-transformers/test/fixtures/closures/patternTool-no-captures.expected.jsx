import * as __ctHelpers from "commontools";
import { derive, pattern, patternTool, type PatternToolResult } from "commontools";
type Output = {
    tool: PatternToolResult<Record<string, never>>;
};
// No external captures - should not be transformed by PatternToolStrategy
export default pattern(() => {
    const tool = patternTool(({ query, content }: {
        query: string;
        content: string;
    }) => {
        return derive({
            type: "object",
            properties: {
                query: {
                    type: "string"
                },
                content: {
                    type: "string"
                }
            },
            required: ["query", "content"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "array",
            items: {
                type: "string"
            }
        } as const satisfies __ctHelpers.JSONSchema, { query, content }, ({ query, content }) => {
            return content.split("\n").filter((c: string) => c.includes(query));
        });
    });
    return { tool };
}, {
    type: "object",
    properties: {},
    additionalProperties: false
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        tool: {
            type: "object",
            properties: {
                pattern: {
                    $ref: "#/$defs/Pattern"
                },
                extraParams: {
                    type: "object",
                    properties: {},
                    additionalProperties: false
                }
            },
            required: ["pattern", "extraParams"]
        }
    },
    required: ["tool"],
    $defs: {
        Pattern: {
            type: "object",
            properties: {
                argumentSchema: true,
                resultSchema: true
            },
            required: ["argumentSchema", "resultSchema"]
        }
    }
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
