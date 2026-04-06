function __ctHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __ctHelpers as __cfHelpers } from "commonfabric";
import { computed, pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __ctAmdHooks = undefined;
interface Item {
    done: boolean;
}
interface State {
    items: Item[];
}
// FIXTURE: computed-map-local-array-conditional
// Verifies: nested ternary inside a callback-local array initializer within a
//   computed-array .map() callback is lowered at the array element site.
//   const view = [row.done ? "Done" : "Pending"]
//   → const view = [ifElse(row.done, "Done", "Pending")]
export default pattern((state) => {
    const rows = __cfHelpers.derive({
        type: "object",
        properties: {
            state: {
                type: "object",
                properties: {
                    items: {
                        type: "array",
                        items: {
                            $ref: "#/$defs/Item"
                        }
                    }
                },
                required: ["items"]
            }
        },
        required: ["state"],
        $defs: {
            Item: {
                type: "object",
                properties: {
                    done: {
                        type: "boolean"
                    }
                },
                required: ["done"]
            }
        }
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "array",
        items: {
            $ref: "#/$defs/Item"
        },
        $defs: {
            Item: {
                type: "object",
                properties: {
                    done: {
                        type: "boolean"
                    }
                },
                required: ["done"]
            }
        }
    } as const satisfies __cfHelpers.JSONSchema, { state: {
            items: state.key("items")
        } }, ({ state }) => state.items);
    return {
        [UI]: (<div>
        {rows.mapWithPattern(__cfHelpers.pattern(__ct_pattern_input => {
                const row = __ct_pattern_input.key("element");
                const view = [__cfHelpers.ifElse({
                        type: "boolean"
                    } as const satisfies __cfHelpers.JSONSchema, {
                        type: "string"
                    } as const satisfies __cfHelpers.JSONSchema, {
                        type: "string"
                    } as const satisfies __cfHelpers.JSONSchema, {
                        "enum": ["Done", "Pending"]
                    } as const satisfies __cfHelpers.JSONSchema, row.key("done"), "Done", "Pending")];
                return <span>{__cfHelpers.derive({
                    type: "object",
                    properties: {
                        view: {
                            type: "array",
                            items: {
                                type: "string"
                            }
                        }
                    },
                    required: ["view"]
                } as const satisfies __cfHelpers.JSONSchema, {
                    type: ["string", "undefined"]
                } as const satisfies __cfHelpers.JSONSchema, { view: view }, ({ view }) => view[0])}</span>;
            }, {
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
                            done: {
                                type: "boolean"
                            }
                        },
                        required: ["done"]
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
                done: {
                    type: "boolean"
                }
            },
            required: ["done"]
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
__ctHardenFn(h);
