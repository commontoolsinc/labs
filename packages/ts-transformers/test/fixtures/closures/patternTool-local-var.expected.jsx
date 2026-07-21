function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { computed, generateTextStream, isPending, pattern, patternTool, type PatternToolResult, resultOf, Writable } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const content = __cfHelpers.__cf_data(new Writable("Hello world", {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema).for("content", true));
type Output = {
    tool: PatternToolResult<{
        content: string;
    }>;
};
const __cfLift_1 = __cfHelpers.lift<{
    language: string;
}, string>(({ language }) => `Translate to ${language}.`, {
    type: "object",
    properties: {
        language: {
            type: "string"
        }
    },
    required: ["language"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_2 = __cfHelpers.lift<{
    content: string;
}, string>(({ content }) => content, {
    type: "object",
    properties: {
        content: {
            type: "string"
        }
    },
    required: ["content"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
const __cfLift_3 = __cfHelpers.lift<{
    genResult: (string & PartialResultSource<string, string>) | (DataUnavailable & { readonly reason: "error"; readonly error: Error; } & PartialResultSource<string, string>) | (DataUnavailable & { readonly reason: "syncing"; readonly syncing: true; } & PartialResultSource<string, string>) | (DataUnavailable & { readonly reason: "schema-mismatch"; readonly schemaMismatch: true; } & PartialResultSource<string, string>);
}, string | undefined>(({ genResult }) => {
    if (isPending(genResult))
        return undefined;
    return resultOf(genResult);
}, {
    type: "object",
    properties: {
        genResult: {
            anyOf: [{
                    type: "string"
                }, {
                    type: "object",
                    properties: {
                        reason: {
                            type: "string",
                            "enum": ["error"]
                        },
                        error: {
                            $ref: "#/$defs/Error"
                        }
                    },
                    required: ["reason", "error"]
                }, {
                    type: "object",
                    properties: {
                        reason: {
                            type: "string",
                            "enum": ["syncing"]
                        },
                        syncing: {
                            type: "boolean",
                            "enum": [true]
                        }
                    },
                    required: ["reason", "syncing"]
                }, {
                    type: "object",
                    properties: {
                        reason: {
                            type: "string",
                            "enum": ["schema-mismatch"]
                        },
                        schemaMismatch: {
                            type: "boolean",
                            "enum": [true]
                        }
                    },
                    required: ["reason", "schemaMismatch"]
                }]
        }
    },
    required: ["genResult"],
    $defs: {
        Error: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                },
                message: {
                    type: "string"
                },
                stack: {
                    type: "string"
                },
                cause: {
                    type: "unknown"
                }
            },
            required: ["name", "message"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: ["string", "undefined"]
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true, unavailableInputPolicy: [{ path: ["genResult"], reasons: ["pending"] }] });
const __cfPattern_1 = pattern((__cf_pattern_input: {
    language: string;
    content: string;
}) => {
    const language = __cf_pattern_input.key("language");
    const content = __cf_pattern_input.key("content");
    const genResult = generateTextStream({
        system: __cfLift_1({ language: language }).for(["genResult", "system"], true),
        prompt: __cfLift_2({ content: content }).for(["genResult", "prompt"], true)
    }).for("genResult", true);
    return __cfLift_3({ genResult: genResult }).for("__patternResult", true);
}, {
    type: "object",
    properties: {
        language: {
            type: "string"
        },
        content: {
            type: "string"
        }
    },
    required: ["language", "content"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: ["string", "undefined"]
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: patternTool-local-var
// Verifies: patternTool's first arg is a pattern() (CT-1655); `content` is a
//   genuine pattern input supplied via extraParams, while the pattern-local
//   `genResult` (from generateTextStream) stays a local binding (not pulled into
//   extraParams).
//   patternTool(pattern(({ language, content }) => …genResult…), { content })
export default pattern(() => {
    const tool = patternTool(__cfPattern_1, { content: content.for(["tool", 1, "content"], true) });
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
                },
                useResultSchemaForObservation: {
                    type: "boolean"
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
                resultSchema: true,
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
__cfReg({
    __cfLift_1,
    __cfLift_2,
    __cfLift_3,
    __cfPattern_1
});
