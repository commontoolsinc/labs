import * as __cfHelpers from "commonfabric";
import { cell, derive, pattern, patternTool, type PatternToolResult } from "commonfabric";
const content = cell("Hello world\nGoodbye world", {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
type Output = {
    grepTool: PatternToolResult<{
        content: string;
    }>;
};
// FIXTURE: patternTool-basic-capture
// Verifies: patternTool captures a module-scoped cell as an extraParam
//   patternTool(fn, { content }) → patternTool(fn, { content }) (content passed through)
//   derive({ query }, ...) inside tool → derive({ input: { query }, content }, ...) with content captured
// Context: Module-scoped `content` cell is referenced inside the patternTool
//   callback. The transformer threads it through the existing extraParams object.
export default pattern(() => {
    const grepTool = patternTool(({ query, content }: {
        query: string;
        content: string;
    }) => {
        return __cfHelpers.derive({
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
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "array",
            items: {
                type: "string"
            }
        } as const satisfies __cfHelpers.JSONSchema, {
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
} as const satisfies __cfHelpers.JSONSchema, {
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
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __cfHelpers.h.fragment;
