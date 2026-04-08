function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { computed, generateText, pattern, patternTool, type PatternToolResult, Writable } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const __cfModuleCallback_1 = __cfHardenFn(({ language, content }: {
    language: string;
    content: string;
}) => {
    const genResult = generateText({
        system: __cfHelpers.derive({
            type: "object",
            properties: {
                language: {
                    type: "string"
                }
            },
            required: ["language"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, { language: language }, ({ language }) => `Translate to ${language}.`),
        prompt: __cfHelpers.derive({
            type: "object",
            properties: {
                content: {
                    type: "string"
                }
            },
            required: ["content"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, { content: content }, ({ content }) => content),
    });
    return __cfHelpers.derive({
        type: "object",
        properties: {
            genResult: {
                type: "object",
                properties: {
                    pending: {
                        type: "boolean"
                    },
                    result: {
                        type: "string"
                    }
                },
                required: ["pending"]
            }
        },
        required: ["genResult"]
    } as const satisfies __cfHelpers.JSONSchema, {
        type: ["string", "undefined"]
    } as const satisfies __cfHelpers.JSONSchema, { genResult: {
            pending: genResult.pending,
            result: genResult.result
        } }, ({ genResult }) => {
        if (genResult.pending)
            return undefined;
        return genResult.result;
    });
});
const content = __cfHelpers.__cf_data(Writable.of("Hello world", {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema));
type Output = {
    tool: PatternToolResult<{
        content: string;
    }>;
};
// Regression test: local variables (genResult) must NOT be captured as
// extraParams, even when they have a reactive type. Only module-scoped
// reactive variables (content) should be captured.
// FIXTURE: patternTool-local-var
// Verifies: patternTool captures module-scoped reactive var but NOT local variables
//   patternTool(fn, { content }) → extraParams includes only module-scoped `content`
//   genResult (local) is NOT added to extraParams despite having a reactive type
// Context: Regression test — local variables like `genResult` (from generateText)
//   must not be hoisted into extraParams. Only module-scoped reactive bindings
//   (here, `content` from Writable.of) should be captured.
export default pattern(() => {
    const tool = patternTool(__cfModuleCallback_1, { content });
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
__cfHardenFn(h);
