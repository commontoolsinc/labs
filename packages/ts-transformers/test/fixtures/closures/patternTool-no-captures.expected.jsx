import * as __cfHelpers from "commonfabric";
import { derive, pattern, patternTool, type PatternToolResult } from "commonfabric";
type Output = {
    tool: PatternToolResult<Record<string, never>>;
};
// No external captures - should not be transformed by PatternToolStrategy
// FIXTURE: patternTool-no-captures
// Verifies: patternTool with no external captures leaves extraParams empty
//   patternTool(fn) → patternTool(fn) with no extraParams modifications
// Context: Negative test — when the patternTool callback only references its own
//   parameters (query, content) and no module-scoped reactive variables, the
//   transformer should not inject any extraParams.
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
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "array",
            items: {
                type: "string"
            }
        } as const satisfies __cfHelpers.JSONSchema, { query, content }, ({ query, content }) => {
            return content.split("\n").filter((c: string) => c.includes(query));
        });
    });
    return { tool };
}, {
    type: "object",
    properties: {},
    additionalProperties: false
} as const satisfies __cfHelpers.JSONSchema, {
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
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __cfHelpers.h.fragment;
