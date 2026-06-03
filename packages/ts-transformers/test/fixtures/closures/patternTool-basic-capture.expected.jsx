function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { cell, computed, pattern, patternTool, type PatternToolResult } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const __cfLift_1 = __cfHelpers.lift<{
    query: string;
    content: string;
}, string[]>({
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
} as const satisfies __cfHelpers.JSONSchema, ({ content, query }) => {
    return content.split("\n").filter((c: string) => c.includes(query));
});
const content = __cfHelpers.__cf_data(cell("Hello world\nGoodbye world", {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema).for("content", true));
type Output = {
    grepTool: PatternToolResult<{
        content: string;
    }>;
};
// FIXTURE: patternTool-basic-capture
// Verifies: patternTool captures a module-scoped cell as an extraParam
//   patternTool(fn, { content }) → patternTool(fn, { content }) (content passed through)
// Context: Module-scoped `content` cell is referenced inside the patternTool
//   callback. The transformer threads it through the existing extraParams object.
export default pattern(() => {
    const grepTool = patternTool(({ query, content }: {
        query: string;
        content: string;
    }) => {
        return __cfLift_1({
            content: content,
            query: query
        });
    }, { content: content.for(["grepTool", 1, "content"], true) });
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
                },
                useResultSchemaForObservation: {
                    type: "boolean"
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
                resultSchema: true,
                internalSchema: true,
                defaultScope: {
                    $ref: "#/$defs/CellScope"
                }
            },
            required: ["argumentSchema", "resultSchema"]
        },
        CellScope: {
            "enum": ["space", "user", "session"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
