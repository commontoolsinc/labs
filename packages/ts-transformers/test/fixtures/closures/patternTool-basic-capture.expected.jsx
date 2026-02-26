import * as __ctHelpers from "commontools";
import { cell, derive, pattern, patternTool, type PatternToolResult } from "commontools";
const content = cell("Hello world\nGoodbye world", {
    type: "string"
} as const satisfies __ctHelpers.JSONSchema);
type Output = {
    grepTool: PatternToolResult<{
        content: string;
    }>;
};
export default pattern(() => {
    const grepTool = patternTool(({ query, content }: {
        query: string;
        content: string;
    }) => {
        return __ctHelpers.derive({
            type: "object",
            properties: {
                input: {
                    type: "object",
                    properties: {
                        query: {
                            type: "string"
                        }
                    },
                    required: ["query"]
                },
                content: {
                    type: "string"
                }
            },
            required: ["input", "content"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "array",
            items: {
                type: "string"
            }
        } as const satisfies __ctHelpers.JSONSchema, {
            input: { query },
            content: content
        }, ({ input: { query }, content }) => {
            return content.split("\n").filter((c: string) => c.includes(query));
        });
    }, { content });
    return { grepTool };
}, {
    type: "object",
    properties: {},
    additionalProperties: false
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        grepTool: {
            type: "object",
            properties: {
                pattern: {
                    $ref: "#/$defs/Pattern"
                },
                extraParams: {
                    type: "object",
                    properties: {
                        content: {
                            type: "string"
                        }
                    },
                    required: ["content"]
                }
            },
            required: ["pattern", "extraParams"]
        }
    },
    required: ["grepTool"],
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
