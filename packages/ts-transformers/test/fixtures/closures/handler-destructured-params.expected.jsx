function __cfBindVerifiedBinding(value: any, metadata: any) {
    if (value && (typeof value === "object" || typeof value === "function") && Object.isExtensible(value)) {
        Object.defineProperty(value, "__cfVerifiedBindingIdentity", {
            value: metadata,
            configurable: true
        });
    }
    if (value && (typeof value === "object" || typeof value === "function") && typeof value.implementation === "function") {
        var implementation = value.implementation;
        if (implementation && (typeof implementation === "object" || typeof implementation === "function") && Object.isExtensible(implementation)) {
            Object.defineProperty(implementation, "__cfVerifiedBindingIdentity", {
                value: metadata,
                configurable: true
            });
        }
    }
    return value;
}
function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { Cell, pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface State {
    selectedValue: Cell<string>;
    lastItems: Cell<string>;
}
const __cfHandler_1 = __cfHelpers.handler({
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
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                selectedValue: {
                    type: "string",
                    asCell: ["writeonly"]
                },
                lastItems: {
                    type: "string",
                    asCell: ["writeonly"]
                }
            },
            required: ["selectedValue", "lastItems"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, ({ detail: { value, items } }, { state }) => {
    state.selectedValue.set(value);
    state.lastItems.set(items.map(i => i.label).join(", "));
});
__cfBindVerifiedBinding(__cfHandler_1, {
    sourceFile: "/test.tsx",
    position: { line: 22, col: 21 }
});
// FIXTURE: handler-destructured-params
// Verifies: destructured event parameter in inline handler is preserved and schema-typed
//   onct-change={({ detail: { value, items } }) => ...} → handler(event schema with detail.value + detail.items, capture schema, ({ detail: { value, items } }, { state }) => ...)({ state })
// Context: Destructured event params retain structure; event schema reflects the destructured shape
export default __cfBindVerifiedBinding(pattern((state) => {
    return {
        [UI]: (<cf-select $value={state.key("selectedValue")} items={[
                { label: "Option A", value: "a" },
                { label: "Option B", value: "b" },
            ]} oncf-change={__cfHandler_1({
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
            asCell: ["cell"]
        },
        lastItems: {
            type: "string",
            asCell: ["cell"]
        }
    },
    required: ["selectedValue", "lastItems"]
} as const satisfies __cfHelpers.JSONSchema, {
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
} as const satisfies __cfHelpers.JSONSchema), {
    sourceFile: "/test.tsx",
    position: { line: 13, col: 30 }
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfHandler_1
});
