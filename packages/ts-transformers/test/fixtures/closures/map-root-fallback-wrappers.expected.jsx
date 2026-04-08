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
interface Item {
    id: string;
}
// FIXTURE: map-root-fallback-wrappers
// Verifies: top-level fallback receiver roots keep structural array-method lowering across wrapper forms
//   (items ?? []).map(fn)                             -> derive(...).mapWithPattern(...)
//   ((items as Item[] | undefined) ?? []).map(fn)     -> cast-wrapped fallback still lowers
//   ((items satisfies Item[] | undefined) ?? []).map  -> satisfies-wrapped fallback still lowers
// Context: All three forms are direct JSX roots rather than nested property fallback receivers
export default pattern((__cf_pattern_input) => {
    const items = __cf_pattern_input.key("items");
    return {
        [UI]: (<div>
        {(__cfHelpers.derive({
            type: "object",
            properties: {
                items: {
                    type: "array",
                    items: {
                        $ref: "#/$defs/Item"
                    }
                }
            },
            $defs: {
                Item: {
                    type: "object",
                    properties: {
                        id: {
                            type: "string"
                        }
                    },
                    required: ["id"]
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
                        id: {
                            type: "string"
                        }
                    },
                    required: ["id"]
                }
            }
        } as const satisfies __cfHelpers.JSONSchema, { items: items }, ({ items }) => items ?? [])).mapWithPattern(__cfHelpers.pattern(__cf_pattern_input => {
            const item = __cf_pattern_input.key("element");
            return <span data-inline-id={item.key("id")}>{item.key("id")}</span>;
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
                        id: {
                            type: "string"
                        }
                    },
                    required: ["id"]
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
        {(__cfHelpers.derive({
            type: "object",
            properties: {
                items: {
                    type: "array",
                    items: {
                        $ref: "#/$defs/Item"
                    }
                }
            },
            $defs: {
                Item: {
                    type: "object",
                    properties: {
                        id: {
                            type: "string"
                        }
                    },
                    required: ["id"]
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
                        id: {
                            type: "string"
                        }
                    },
                    required: ["id"]
                }
            }
        } as const satisfies __cfHelpers.JSONSchema, { items: items }, ({ items }) => (items as Item[] | undefined) ?? [])).mapWithPattern(__cfHelpers.pattern(__cf_pattern_input => {
            const item = __cf_pattern_input.key("element");
            return (<span data-cast-id={item.key("id")}>{item.key("id")}</span>);
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
                        id: {
                            type: "string"
                        }
                    },
                    required: ["id"]
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
        {(__cfHelpers.derive({
            type: "object",
            properties: {
                items: {
                    type: "array",
                    items: {
                        $ref: "#/$defs/Item"
                    }
                }
            },
            $defs: {
                Item: {
                    type: "object",
                    properties: {
                        id: {
                            type: "string"
                        }
                    },
                    required: ["id"]
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
                        id: {
                            type: "string"
                        }
                    },
                    required: ["id"]
                }
            }
        } as const satisfies __cfHelpers.JSONSchema, { items: items }, ({ items }) => (items satisfies Item[] | undefined) ?? [])).mapWithPattern(__cfHelpers.pattern(__cf_pattern_input => {
            const item = __cf_pattern_input.key("element");
            return (<span data-satisfies-id={item.key("id")}>{item.key("id")}</span>);
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
                        id: {
                            type: "string"
                        }
                    },
                    required: ["id"]
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
    $defs: {
        Item: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                }
            },
            required: ["id"]
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
