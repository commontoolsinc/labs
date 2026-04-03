import * as __ctHelpers from "commontools";
import { pattern, UI } from "commontools";
interface Item {
    id: string;
}
// FIXTURE: map-root-fallback-wrappers
// Verifies: top-level fallback receiver roots keep structural array-method lowering across wrapper forms
//   (items ?? []).map(fn)                             -> derive(...).mapWithPattern(...)
//   ((items as Item[] | undefined) ?? []).map(fn)     -> cast-wrapped fallback still lowers
//   ((items satisfies Item[] | undefined) ?? []).map  -> satisfies-wrapped fallback still lowers
// Context: All three forms are direct JSX roots rather than nested property fallback receivers
export default pattern((__ct_pattern_input) => {
    const items = __ct_pattern_input.key("items");
    return {
        [UI]: (<div>
        {(__ctHelpers.derive({
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
        } as const satisfies __ctHelpers.JSONSchema, {
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
        } as const satisfies __ctHelpers.JSONSchema, { items: items }, ({ items }) => items ?? [])).mapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
            const item = __ct_pattern_input.key("element");
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
        } as const satisfies __ctHelpers.JSONSchema, {
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
        } as const satisfies __ctHelpers.JSONSchema), {})}
        {(__ctHelpers.derive({
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
        } as const satisfies __ctHelpers.JSONSchema, {
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
        } as const satisfies __ctHelpers.JSONSchema, { items: items }, ({ items }) => (items as Item[] | undefined) ?? [])).mapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
            const item = __ct_pattern_input.key("element");
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
        } as const satisfies __ctHelpers.JSONSchema, {
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
        } as const satisfies __ctHelpers.JSONSchema), {})}
        {(__ctHelpers.derive({
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
        } as const satisfies __ctHelpers.JSONSchema, {
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
        } as const satisfies __ctHelpers.JSONSchema, { items: items }, ({ items }) => (items satisfies Item[] | undefined) ?? [])).mapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
            const item = __ct_pattern_input.key("element");
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
        } as const satisfies __ctHelpers.JSONSchema, {
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
        } as const satisfies __ctHelpers.JSONSchema), {})}
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
