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
const __handler_0 = __ctHelpers.handler(false as const satisfies __ctHelpers.JSONSchema, {
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
} as const satisfies __ctHelpers.JSONSchema, (__ct_handler_event, { state }) => __ctHelpers.derive({
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
    type: "boolean",
    asCell: true
} as const satisfies __ctHelpers.JSONSchema, { state: {
        isEditing: state.isEditing
    } }, ({ state }) => state.isEditing.set(true)));
const __lift_0 = __ctHelpers.lift({
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
            $ref: "#/$defs/VNode"
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
                    $ref: "#/$defs/VNode"
                }
            },
            required: ["$UI"]
        },
        VNode: {
            type: "object",
            properties: {
                type: {
                    type: "string",
                    "enum": ["vnode"]
                },
                name: {
                    type: "string"
                },
                props: {
                    $ref: "#/$defs/Props"
                },
                children: {
                    $ref: "#/$defs/RenderNode"
                },
                $UI: {
                    $ref: "#/$defs/VNode"
                }
            },
            required: ["type", "name", "props"]
        },
        RenderNode: {
            anyOf: [{
                    type: "string"
                }, {
                    type: "number"
                }, {
                    type: "boolean",
                    "enum": [false]
                }, {
                    type: "boolean",
                    "enum": [true]
                }, {
                    $ref: "#/$defs/VNode"
                }, {
                    type: "object",
                    properties: {}
                }, {
                    $ref: "#/$defs/UIRenderable",
                    asOpaque: true
                }, {
                    type: "object",
                    properties: {}
                }, {
                    type: "array",
                    items: {
                        $ref: "#/$defs/RenderNode"
                    }
                }, {
                    type: "null"
                }]
        },
        Props: {
            type: "object",
            properties: {},
            additionalProperties: {
                anyOf: [{
                        type: "string"
                    }, {
                        type: "number"
                    }, {
                        type: "boolean",
                        "enum": [false]
                    }, {
                        type: "boolean",
                        "enum": [true]
                    }, {
                        type: "object",
                        additionalProperties: true
                    }, {
                        type: "array",
                        items: true
                    }, {
                        asCell: true
                    }, {
                        asStream: true
                    }, {
                        type: "null"
                    }]
            }
        }
    }
} as const satisfies __ctHelpers.JSONSchema, ({ state }) => (<ct-button onClick={__handler_0({
    state: {
        isEditing: state.isEditing
    }
})}>Edit</ct-button>));
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
        } as const satisfies __ctHelpers.JSONSchema, state.isEditing, <div>Editing</div>, <div>
            <span>{state.card.title}</span>
            {/* Explicit computed() wrapping a button with inline handler */}
            {/* The Cell ref in the handler must be captured in the derive */}
            {__lift_0({ state: {
                    isEditing: state.isEditing
                } })}
          </div>)}
      </ct-card>),
        card: state.card,
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
                    $ref: "#/$defs/VNode"
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
                    $ref: "#/$defs/VNode"
                }
            },
            required: ["$UI"]
        },
        VNode: {
            type: "object",
            properties: {
                type: {
                    type: "string",
                    "enum": ["vnode"]
                },
                name: {
                    type: "string"
                },
                props: {
                    $ref: "#/$defs/Props"
                },
                children: {
                    $ref: "#/$defs/RenderNode"
                },
                $UI: {
                    $ref: "#/$defs/VNode"
                }
            },
            required: ["type", "name", "props"]
        },
        RenderNode: {
            anyOf: [{
                    type: "string"
                }, {
                    type: "number"
                }, {
                    type: "boolean",
                    "enum": [false]
                }, {
                    type: "boolean",
                    "enum": [true]
                }, {
                    $ref: "#/$defs/VNode"
                }, {
                    type: "object",
                    properties: {}
                }, {
                    $ref: "#/$defs/UIRenderable",
                    asOpaque: true
                }, {
                    type: "object",
                    properties: {}
                }, {
                    type: "array",
                    items: {
                        $ref: "#/$defs/RenderNode"
                    }
                }, {
                    type: "null"
                }]
        },
        Props: {
            type: "object",
            properties: {},
            additionalProperties: {
                anyOf: [{
                        type: "string"
                    }, {
                        type: "number"
                    }, {
                        type: "boolean",
                        "enum": [false]
                    }, {
                        type: "boolean",
                        "enum": [true]
                    }, {
                        type: "object",
                        additionalProperties: true
                    }, {
                        type: "array",
                        items: true
                    }, {
                        asCell: true
                    }, {
                        asStream: true
                    }, {
                        type: "null"
                    }]
            }
        }
    }
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
