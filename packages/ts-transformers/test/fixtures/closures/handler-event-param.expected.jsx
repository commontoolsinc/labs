import * as __ctHelpers from "commontools";
import { Cell, pattern, UI } from "commontools";
interface State {
    selectedValue: Cell<string>;
    changeCount: Cell<number>;
}
// Test typed event handler: ct-select has onct-change?: EventHandler<{ items: ...; value: ... }>
// The handler receives { detail: { items: [...], value: ... } }
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
                        value: true
                    },
                    required: ["value"]
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
                        changeCount: {
                            type: "number",
                            asCell: true
                        }
                    },
                    required: ["selectedValue", "changeCount"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, (event, { state }) => {
            state.selectedValue.set(event.detail.value);
            state.changeCount.set(state.changeCount.get() + 1);
        })({
            state: {
                selectedValue: state.key("selectedValue"),
                changeCount: state.key("changeCount")
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
        changeCount: {
            type: "number",
            asCell: true
        }
    },
    required: ["selectedValue", "changeCount"]
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
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
