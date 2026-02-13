import * as __ctHelpers from "commontools";
/**
 * Regression test: action() referenced inside explicit computed() in JSX
 *
 * Variation where the pattern author uses computed() explicitly inside JSX
 * (not encouraged, but should still work). The action is referenced INSIDE
 * the computed expression, so it must be captured in the derive wrapper.
 */
import { action, Cell, computed, pattern, UI } from "commontools";
interface Card {
    title: string;
    description: string;
}
interface Input {
    card: Card;
}
export default pattern({
    type: "object",
    properties: {
        card: {
            $ref: "#/$defs/Card"
        }
    },
    required: ["card"],
    $defs: {
        Card: {
            type: "object",
            properties: {
                title: {
                    type: "string"
                },
                description: {
                    type: "string"
                }
            },
            required: ["title", "description"]
        }
    }
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        $UI: {
            $ref: "#/$defs/JSXElement"
        },
        card: {
            $ref: "#/$defs/Card",
            asOpaque: true
        }
    },
    required: ["$UI", "card"],
    $defs: {
        Card: {
            type: "object",
            properties: {
                title: {
                    type: "string"
                },
                description: {
                    type: "string"
                }
            },
            required: ["title", "description"]
        },
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
} as const satisfies __ctHelpers.JSONSchema, ({ card }) => {
    const isEditing = Cell.of(false, {
        type: "boolean"
    } as const satisfies __ctHelpers.JSONSchema);
    const startEditing = __ctHelpers.handler(false as const satisfies __ctHelpers.JSONSchema, {
        type: "object",
        properties: {
            isEditing: {
                type: "boolean",
                asCell: true
            }
        },
        required: ["isEditing"]
    } as const satisfies __ctHelpers.JSONSchema, (_, { isEditing }) => {
        isEditing.set(true);
    })({
        isEditing: isEditing
    });
    return {
        [UI]: (<ct-card>
        {__ctHelpers.ifElse({
            type: "boolean",
            asCell: true
        } as const satisfies __ctHelpers.JSONSchema, {
            anyOf: [{}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __ctHelpers.JSONSchema, {
            anyOf: [{}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __ctHelpers.JSONSchema, {
            anyOf: [{}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __ctHelpers.JSONSchema, isEditing, <div>Editing</div>, <div>
            <span>{card.title}</span>
            {/* Explicit computed() wrapping JSX that references the action */}
            {/* The action must be captured in the derive created for this computed */}
            {__ctHelpers.derive({
                type: "object",
                properties: {
                    card: {
                        type: "object",
                        properties: {
                            description: {
                                type: "string",
                                asOpaque: true
                            }
                        },
                        required: ["description"]
                    },
                    startEditing: {
                        asStream: true
                    }
                },
                required: ["card", "startEditing"]
            } as const satisfies __ctHelpers.JSONSchema, {
                anyOf: [{
                        $ref: "https://commonfabric.org/schemas/vnode.json"
                    }, {
                        type: "object",
                        properties: {}
                    }, {
                        $ref: "#/$defs/UIRenderable",
                        asOpaque: true
                    }],
                $defs: {
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
            } as const satisfies __ctHelpers.JSONSchema, {
                card: {
                    description: card.description
                },
                startEditing: startEditing
            }, ({ card, startEditing }) => (<div>
                <span>{card.description}</span>
                <ct-button onClick={startEditing}>Edit</ct-button>
              </div>))}
          </div>)}
      </ct-card>),
        card,
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
