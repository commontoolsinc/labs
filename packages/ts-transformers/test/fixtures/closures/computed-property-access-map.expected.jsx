import * as __ctHelpers from "commontools";
/**
 * Regression: .map() on a property access of a computed result inside
 * another computed() should NOT be transformed to .mapWithPattern().
 *
 * Inside a derive callback, OpaqueRef values are unwrapped to plain JS,
 * so `result.tasks` is a plain array.
 */
import { computed, pattern, UI } from "commontools";
interface Item {
    name: string;
    done: boolean;
}
export default pattern({
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
} as const satisfies __ctHelpers.JSONSchema, ({ items }) => {
    const result = __ctHelpers.derive({
        type: "object",
        properties: {
            items: {
                type: "array",
                items: {
                    $ref: "#/$defs/Item"
                },
                asOpaque: true
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
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "object",
        properties: {
            tasks: {
                type: "array",
                items: {
                    $ref: "#/$defs/Item",
                    asOpaque: true
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
    } as const satisfies __ctHelpers.JSONSchema, { items: items }, ({ items }) => ({
        tasks: items.filter((i) => !i.done),
        view: "inbox",
    }));
    return {
        [UI]: (<div>
        {__ctHelpers.derive({
                type: "object",
                properties: {
                    result: {
                        type: "object",
                        properties: {
                            tasks: {
                                type: "array",
                                items: {
                                    $ref: "#/$defs/Item",
                                    asOpaque: true
                                },
                                asOpaque: true
                            }
                        },
                        required: ["tasks"]
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
            } as const satisfies __ctHelpers.JSONSchema, {
                type: "array",
                items: {
                    $ref: "#/$defs/UIRenderable"
                },
                asOpaque: true,
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
            } as const satisfies __ctHelpers.JSONSchema, { result: {
                    tasks: result.tasks
                } }, ({ result }) => {
                return result.tasks.map((task) => <li>{task.name}</li>);
            })}
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
