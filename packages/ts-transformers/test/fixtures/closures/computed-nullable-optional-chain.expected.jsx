import * as __ctHelpers from "commontools";
import { computed, pattern, UI, NAME } from "commontools";
// Represents a question that may or may not exist
type Question = {
    question: string;
    category: string;
    priority: number;
};
export default pattern(false as const satisfies __ctHelpers.JSONSchema, {
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
                    type: "object",
                    properties: {}
                }, {
                    $ref: "#/$defs/UIRenderable",
                    asOpaque: true
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
} as const satisfies __ctHelpers.JSONSchema, (_) => {
    // This computed can return null - simulates finding a question from a list
    const topQuestion = __ctHelpers.derive({
        type: "object",
        properties: {}
    } as const satisfies __ctHelpers.JSONSchema, {
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
    } as const satisfies __ctHelpers.JSONSchema, {}, (): Question | null => {
        // In real code this would filter and return first match, or null
        return null;
    });
    return {
        [NAME]: "Computed Nullable Optional Chain",
        [UI]: (<div>
        {/* BUG CASE: Optional chaining loses nullability in schema inference */}
        {/* The input schema should have topQuestion as anyOf [Question, null] */}
        {/* but instead infers topQuestion as object with required "question" */}
        <p>Optional chaining: {__ctHelpers.derive({
            type: "object",
            properties: {
                topQuestion: {
                    anyOf: [{
                            $ref: "#/$defs/Question"
                        }, {
                            type: "null"
                        }],
                    asOpaque: true
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
        } as const satisfies __ctHelpers.JSONSchema, {
            anyOf: [{
                    type: "string",
                    asOpaque: true
                }, {
                    type: "string",
                    "enum": [""]
                }]
        } as const satisfies __ctHelpers.JSONSchema, { topQuestion: topQuestion }, ({ topQuestion }) => topQuestion?.question || "")}</p>

        {/* WORKAROUND: Explicit null check preserves nullability */}
        {/* This correctly generates anyOf [Question, null] in the schema */}
        <p>Explicit check: {__ctHelpers.derive({
            type: "object",
            properties: {
                topQuestion: {
                    anyOf: [{
                            $ref: "#/$defs/Question"
                        }, {
                            type: "null"
                        }],
                    asOpaque: true
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
        } as const satisfies __ctHelpers.JSONSchema, {
            anyOf: [{
                    type: "string",
                    asOpaque: true
                }, {
                    type: "string",
                    "enum": [""]
                }]
        } as const satisfies __ctHelpers.JSONSchema, { topQuestion: topQuestion }, ({ topQuestion }) => topQuestion === null ? "" : topQuestion.question)}</p>

        {/* Same issue with category field */}
        <span>Category (buggy): {__ctHelpers.derive({
            type: "object",
            properties: {
                topQuestion: {
                    anyOf: [{
                            $ref: "#/$defs/Question"
                        }, {
                            type: "null"
                        }],
                    asOpaque: true
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
        } as const satisfies __ctHelpers.JSONSchema, {
            anyOf: [{
                    type: "string",
                    asOpaque: true
                }, {
                    type: "string",
                    "enum": [""]
                }]
        } as const satisfies __ctHelpers.JSONSchema, { topQuestion: topQuestion }, ({ topQuestion }) => topQuestion?.category || "")}</span>
        <span>Category (works): {__ctHelpers.derive({
            type: "object",
            properties: {
                topQuestion: {
                    anyOf: [{
                            $ref: "#/$defs/Question"
                        }, {
                            type: "null"
                        }],
                    asOpaque: true
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
        } as const satisfies __ctHelpers.JSONSchema, {
            anyOf: [{
                    type: "string",
                    asOpaque: true
                }, {
                    type: "string",
                    "enum": [""]
                }]
        } as const satisfies __ctHelpers.JSONSchema, { topQuestion: topQuestion }, ({ topQuestion }) => topQuestion === null ? "" : topQuestion.category)}</span>
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
