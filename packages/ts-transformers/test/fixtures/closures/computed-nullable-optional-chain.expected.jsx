function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __ctHelpers as __cfHelpers } from "commonfabric";
import { computed, pattern, UI, NAME } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __ctAmdHooks = undefined;
// Represents a question that may or may not exist
type Question = {
    question: string;
    category: string;
    priority: number;
};
// FIXTURE: computed-nullable-optional-chain
// Verifies: computed() capturing a nullable computed result preserves anyOf [type, null] in schema
//   computed(() => topQuestion?.question || "") → derive(..., { topQuestion }, ({ topQuestion }) => topQuestion?.question || "")
//   computed(() => topQuestion === null ? "" : topQuestion.question) → derive(..., { topQuestion }, ({ topQuestion }) => ...)
// Context: Tests both optional chaining (?.) and explicit null-check patterns on
//   a nullable OpaqueRef. The capture schema correctly uses anyOf [Question, null]
//   with asOpaque: true for the topQuestion capture.
export default pattern((_) => {
    // This computed can return null - simulates finding a question from a list
    const topQuestion = __cfHelpers.derive({
        type: "object",
        properties: {}
    } as const satisfies __cfHelpers.JSONSchema, {
        anyOf: [{
                $ref: "#/$defs/Question"
            }, {
                type: "null"
            }],
        $defs: {
            Question: {
                type: "object",
                properties: {
                    question: {
                        type: "string"
                    },
                    category: {
                        type: "string"
                    },
                    priority: {
                        type: "number"
                    }
                },
                required: ["question", "category", "priority"]
            }
        }
    } as const satisfies __cfHelpers.JSONSchema, {}, (): Question | null => {
        // In real code this would filter and return first match, or null
        return null;
    });
    return {
        [NAME]: "Computed Nullable Optional Chain",
        [UI]: (<div>
        {/* BUG CASE: Optional chaining loses nullability in schema inference */}
        {/* The input schema should have topQuestion as anyOf [Question, null] */}
        {/* but instead infers topQuestion as object with required "question" */}
        <p>Optional chaining: {__cfHelpers.derive({
            type: "object",
            properties: {
                topQuestion: {
                    anyOf: [{
                            type: "object",
                            properties: {
                                question: {
                                    type: "string"
                                }
                            },
                            required: ["question"]
                        }, {
                            type: "null"
                        }]
                }
            },
            required: ["topQuestion"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, { topQuestion: topQuestion }, ({ topQuestion }) => topQuestion?.question || "")}</p>

        {/* WORKAROUND: Explicit null check preserves nullability */}
        {/* This correctly generates anyOf [Question, null] in the schema */}
        <p>Explicit check: {__cfHelpers.derive({
            type: "object",
            properties: {
                topQuestion: {
                    anyOf: [{
                            $ref: "#/$defs/Question"
                        }, {
                            type: "null"
                        }]
                }
            },
            required: ["topQuestion"],
            $defs: {
                Question: {
                    type: "object",
                    properties: {
                        question: {
                            type: "string"
                        },
                        category: {
                            type: "string"
                        },
                        priority: {
                            type: "number"
                        }
                    },
                    required: ["question", "category", "priority"]
                }
            }
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, { topQuestion: topQuestion }, ({ topQuestion }) => topQuestion === null ? "" : topQuestion.question)}</p>

        {/* Same issue with category field */}
        <span>Category (buggy): {__cfHelpers.derive({
            type: "object",
            properties: {
                topQuestion: {
                    anyOf: [{
                            type: "object",
                            properties: {
                                category: {
                                    type: "string"
                                }
                            },
                            required: ["category"]
                        }, {
                            type: "null"
                        }]
                }
            },
            required: ["topQuestion"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, { topQuestion: topQuestion }, ({ topQuestion }) => topQuestion?.category || "")}</span>
        <span>Category (works): {__cfHelpers.derive({
            type: "object",
            properties: {
                topQuestion: {
                    anyOf: [{
                            $ref: "#/$defs/Question"
                        }, {
                            type: "null"
                        }]
                }
            },
            required: ["topQuestion"],
            $defs: {
                Question: {
                    type: "object",
                    properties: {
                        question: {
                            type: "string"
                        },
                        category: {
                            type: "string"
                        },
                        priority: {
                            type: "number"
                        }
                    },
                    required: ["question", "category", "priority"]
                }
            }
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, { topQuestion: topQuestion }, ({ topQuestion }) => topQuestion === null ? "" : topQuestion.category)}</span>
      </div>),
    };
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        $NAME: {
            type: "string"
        },
        $UI: {
            $ref: "#/$defs/JSXElement"
        }
    },
    required: ["$NAME", "$UI"],
    $defs: {
        JSXElement: {
            anyOf: [{
                    $ref: "https://commonfabric.org/schemas/vnode.json"
                }, {
                    $ref: "#/$defs/UIRenderable"
                }, {
                    type: "object",
                    properties: {}
                }]
        },
        UIRenderable: {
            type: "object",
            properties: {
                $UI: {
                    $ref: "https://commonfabric.org/schemas/vnode.json"
                }
            },
            required: ["$UI"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
