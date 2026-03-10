import * as __ctHelpers from "commontools";
import { Cell, pattern, UI } from "commontools";
interface State {
    selectedValue: Cell<string>;
    lastItems: Cell<string>;
}
// Test destructured event handler params with typed ct-select onct-change
export default pattern((state) => {
    return {
        [UI]: (<ct-select $value={state.key("selectedValue")} items={[
                { label: "Option A", value: "a" },
                { label: "Option B", value: "b" },
            ]} onct-change={__ctHelpers.handler({
            type: "object",
            properties: {
                detail: {
                    type: "object",
                    properties: {
                        value: true,
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
                        }
                    },
                    required: ["value", "items"]
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
        })({
            state: {
                selectedValue: state.key("selectedValue"),
                lastItems: state.key("lastItems")
            }
        })}/>),
    };
}, {
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
