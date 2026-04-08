function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __ctHelpers as __cfHelpers } from "commonfabric";
import { pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __ctAmdHooks = undefined;
const __cfModuleCallback_1 = __cfHardenFn(({ element, params: {} }) => {
    const __cf_val_key = dynamicKey();
    const { foo } = element;
    const val = __cfHelpers.derive({
        type: "object",
        properties: {
            element: true,
            __cf_val_key: true
        },
        required: ["element", "__cf_val_key"]
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema, {
        element: element,
        __cf_val_key: __cf_val_key
    }, ({ element, __cf_val_key }) => element[__cf_val_key]);
    return (<span>{__cfHelpers.derive({
        type: "object",
        properties: {
            foo: {
                type: "number"
            },
            val: {
                type: "number"
            }
        },
        required: ["foo", "val"]
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema, {
        foo: foo,
        val: val
    }, ({ foo, val }) => foo + val)}</span>);
});
function dynamicKey(): "value" {
    return "value";
}
__cfHardenFn(dynamicKey);
interface Item {
    foo: number;
    value: number;
}
interface State {
    items: Item[];
}
// FIXTURE: map-computed-alias-with-plain-binding
// Verifies: computed property key mixed with a static destructured binding in the same pattern
//   { foo, [dynamicKey()]: val } → key binding for foo, derive() for val
//   foo + val expression → derive() combining both bindings
// Context: Mixes static destructuring ({foo}) with dynamic computed key ([dynamicKey()]: val)
export default pattern((state) => {
    return {
        [UI]: (<div>
        {state.key("items").mapWithPattern(__cfHelpers.pattern(__cfModuleCallback_1, {
                type: "object",
                properties: {
                    element: {
                        $ref: "#/$defs/Item"
                    }
                },
                required: ["element"],
                $defs: {
                    Item: {
                        type: "object",
                        properties: {
                            foo: {
                                type: "number"
                            },
                            value: {
                                type: "number"
                            }
                        },
                        required: ["foo", "value"]
                    }
                }
            } as const satisfies __cfHelpers.JSONSchema, {
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
            } as const satisfies __cfHelpers.JSONSchema), {})}
      </div>),
    };
}, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            }
        }
    },
    required: ["items"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                foo: {
                    type: "number"
                },
                value: {
                    type: "number"
                }
            },
            required: ["foo", "value"]
        }
    }
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
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
