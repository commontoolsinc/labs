function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __ctHelpers as __cfHelpers } from "commonfabric";
/**
 * Regression: .map() on a destructured property from a computed result
 * inside another computed() should NOT be transformed to .mapWithPattern().
 *
 * Inside a derive callback, OpaqueRef values are unwrapped to plain JS,
 * so destructured `tasks` is a plain array.
 */
import { computed, pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __ctAmdHooks = undefined;
interface Item {
    name: string;
    done: boolean;
}
// FIXTURE: computed-destructured-map
// Verifies: .map() on a destructured property of a computed result inside another computed() is NOT transformed to .mapWithPattern()
//   computed(() => { const { tasks } = result; return tasks.map(fn) }) → derive(..., ({ result }) => { const { tasks } = result; return tasks.map(fn) })
// Context: Inside a derive callback, OpaqueRef values are unwrapped to plain JS,
//   so destructured `tasks` is a plain array. The .map() must remain untransformed.
//   This is a negative test for reactive .map() detection on derived values.
export default pattern((__cf_pattern_input) => {
    const items = __cf_pattern_input.key("items");
    const result = __cfHelpers.derive({
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
                    name: {
                        type: "string"
                    },
                    done: {
                        type: "boolean"
                    }
                },
                required: ["name", "done"]
            }
        }
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "object",
        properties: {
            tasks: {
                type: "array",
                items: {
                    $ref: "#/$defs/Item"
                }
            },
            view: {
                type: "string"
            }
        },
        required: ["tasks", "view"],
        $defs: {
            Item: {
                type: "object",
                properties: {
                    name: {
                        type: "string"
                    },
                    done: {
                        type: "boolean"
                    }
                },
                required: ["name", "done"]
            }
        }
    } as const satisfies __cfHelpers.JSONSchema, { items: items }, ({ items }) => ({
        tasks: items.filter((i) => !i.done),
        view: "inbox",
    }));
    return {
        [UI]: (<div>
        {__cfHelpers.derive({
                type: "object",
                properties: {
                    result: {
                        type: "object",
                        properties: {
                            tasks: {
                                type: "array",
                                items: {
                                    $ref: "#/$defs/Item"
                                }
                            },
                            view: {
                                type: "string"
                            }
                        },
                        required: ["tasks", "view"]
                    }
                },
                required: ["result"],
                $defs: {
                    Item: {
                        type: "object",
                        properties: {
                            name: {
                                type: "string"
                            },
                            done: {
                                type: "boolean"
                            }
                        },
                        required: ["name", "done"]
                    }
                }
            } as const satisfies __cfHelpers.JSONSchema, {
                type: "array",
                items: {
                    $ref: "#/$defs/JSXElement"
                },
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
            } as const satisfies __cfHelpers.JSONSchema, { result: result }, ({ result }) => {
                const { tasks } = result;
                return tasks.map((task) => <li>{task.name}</li>);
            })}
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
                name: {
                    type: "string"
                },
                done: {
                    type: "boolean"
                }
            },
            required: ["name", "done"]
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
