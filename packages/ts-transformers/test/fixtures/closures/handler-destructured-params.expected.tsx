import * as __ctHelpers from "commontools";
import { Cell, recipe, UI } from "commontools";
const __handler_0 = __ctHelpers.handler({
    type: "object",
    properties: {
        detail: {
            type: "object",
            properties: {
                items: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            label: {
                                type: "string"
                            },
                            value: true
                        },
                        required: ["label", "value"]
                    }
                },
                value: true
            },
            required: ["items", "value"]
        }
    },
    required: ["detail"]
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                selectedValue: {
                    type: "string",
                    asCell: true
                },
                lastItems: {
                    type: "string",
                    asCell: true
                }
            },
            required: ["selectedValue", "lastItems"]
        }
    },
    required: ["state"]
} as const satisfies __ctHelpers.JSONSchema, ({ detail: { value, items } }, { state }) => {
    state.selectedValue.set(value);
    state.lastItems.set(items.map(i => i.label).join(", "));
});
interface State {
    selectedValue: Cell<string>;
    lastItems: Cell<string>;
}
// Test destructured event handler params with typed ct-select onct-change
export default recipe({
    type: "object",
    properties: {
        selectedValue: {
            type: "string",
            asCell: true
        },
        lastItems: {
            type: "string",
            asCell: true
        }
    },
    required: ["selectedValue", "lastItems"]
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        $UI: {
            $ref: "#/$defs/JSXElement"
        }
    },
    required: ["$UI"],
    $defs: {
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
} as const satisfies __ctHelpers.JSONSchema, (state) => {
    return {
        [UI]: (<ct-select $value={state.selectedValue} items={[
                { label: "Option A", value: "a" },
                { label: "Option B", value: "b" },
            ]} onct-change={__handler_0({
            state: {
                selectedValue: state.selectedValue,
                lastItems: state.lastItems
            }
        })}/>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
