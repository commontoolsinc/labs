import * as __ctHelpers from "commontools";
/**
 * Regression test: inline arrow function inside explicit computed() in JSX
 *
 * Variation where an inline arrow function handler is wrapped inside an
 * explicit computed() in JSX. The transformer will convert the arrow function
 * to a handler, and the Cell reference (state.isEditing) must be properly
 * captured in the derive wrapper created for the computed.
 */
import { Cell, computed, pattern, UI } from "commontools";
interface Card {
    title: string;
    description: string;
}
interface State {
    card: Card;
    isEditing: Cell<boolean>;
}
export default pattern((state) => {
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
        } as const satisfies __ctHelpers.JSONSchema, state.key("isEditing"), <div>Editing</div>, __ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        card: {
                            type: "object",
                            properties: {
                                title: {
                                    type: "string"
                                }
                            },
                            required: ["title"]
                        },
                        isEditing: {
                            type: "boolean",
                            asCell: true
                        }
                    },
                    required: ["card", "isEditing"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            anyOf: [{
                    $ref: "https://commonfabric.org/schemas/vnode.json"
                }, {
                    $ref: "#/$defs/UIRenderable"
                }, {
                    type: "object",
                    properties: {}
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
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                card: {
                    title: state.key("card").title
                },
                isEditing: state.key("isEditing")
            } }, ({ state }) => (<div>
            <span>{__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        card: {
                            type: "object",
                            properties: {
                                title: {
                                    type: "string"
                                }
                            },
                            required: ["title"]
                        }
                    },
                    required: ["card"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                card: {
                    title: state.card.title
                }
            } }, ({ state }) => state.card.title)}</span>
            {/* Explicit computed() wrapping a button with inline handler */}
            {/* The Cell ref in the handler must be captured in the derive */}
            {__ctHelpers.derive({
                type: "object",
                properties: {
                    state: {
                        type: "object",
                        properties: {
                            isEditing: {
                                type: "boolean",
                                asCell: true
                            }
                        },
                        required: ["isEditing"]
                    }
                },
                required: ["state"]
            } as const satisfies __ctHelpers.JSONSchema, {
                anyOf: [{
                        $ref: "https://commonfabric.org/schemas/vnode.json"
                    }, {
                        $ref: "#/$defs/UIRenderable"
                    }, {
                        type: "object",
                        properties: {}
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
            } as const satisfies __ctHelpers.JSONSchema, { state: {
                    isEditing: state.isEditing
                } }, ({ state }) => (<ct-button onClick={__ctHelpers.handler(false as const satisfies __ctHelpers.JSONSchema, {
                type: "object",
                properties: {
                    state: {
                        type: "object",
                        properties: {
                            isEditing: {
                                type: "boolean",
                                asCell: true
                            }
                        },
                        required: ["isEditing"]
                    }
                },
                required: ["state"]
            } as const satisfies __ctHelpers.JSONSchema, (__ct_handler_event, { state }) => state.isEditing.set(true))({
                state: {
                    isEditing: state.isEditing
                }
            })}>Edit</ct-button>))}
          </div>)))}
      </ct-card>),
        card: state.key("card"),
    };
}, {
    type: "object",
    properties: {
        card: {
            $ref: "#/$defs/Card"
        },
        isEditing: {
            type: "boolean",
            asCell: true
        }
    },
    required: ["card", "isEditing"],
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
            $ref: "#/$defs/Card"
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
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
