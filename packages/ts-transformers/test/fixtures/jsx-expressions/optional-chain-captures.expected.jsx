function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const __cfModuleCallback_1 = __cfHardenFn(({ element: item, params: {} }) => (<span>{__cfHelpers.derive({
    type: "object",
    properties: {
        item: {
            type: "object",
            properties: {
                maybe: {
                    type: "object",
                    properties: {
                        value: {
                            type: "number"
                        }
                    },
                    required: ["value"]
                }
            }
        }
    },
    required: ["item"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema, { item: {
        maybe: item.maybe
    } }, ({ item }) => item.maybe?.value ?? 0)}</span>));
interface Item {
    maybe?: {
        value: number;
    };
}
interface State {
    maybe?: {
        value: number;
    };
    items: Item[];
}
// FIXTURE: optional-chain-captures
// Verifies: optional chaining (?.) in JSX is resolved to .key() or wrapped in derive()
//   state.maybe?.value         → state.key("maybe", "value")
//   item.maybe?.value ?? 0     → derive({item}, ({item}) => item.maybe?.value ?? 0)
// Context: Optional chaining with nullish coalescing inside a map body
export default pattern((state) => {
    return {
        [UI]: (<div>
        <span>{state.key("maybe", "value")}</span>
        {state.key("items").mapWithPattern(__cfHelpers.pattern(__cfModuleCallback_1, {
                type: "object",
                properties: {
                    element: {
                        type: "object",
                        properties: {
                            maybe: {
                                type: "object",
                                properties: {
                                    value: {
                                        type: "number"
                                    }
                                },
                                required: ["value"]
                            }
                        }
                    }
                },
                required: ["element"]
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
        maybe: {
            type: "object",
            properties: {
                value: {
                    type: "number"
                }
            },
            required: ["value"]
        },
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
                maybe: {
                    type: "object",
                    properties: {
                        value: {
                            type: "number"
                        }
                    },
                    required: ["value"]
                }
            }
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
