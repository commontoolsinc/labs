import * as __ctHelpers from "commontools";
/**
 * TRANSFORM REPRO: helper-owned JSX IIFE final map callback captures reactive state
 *
 * The decomposed helper-owned IIFE path currently leaves the final `visible.map(...)`
 * as a plain map call. That is only safe when the callback depends only on the mapped
 * element. If it captures outer reactive state, it must lower through mapWithPattern.
 */
import { Default, pattern, UI, VNode, Writable, } from "commontools";
interface Entry {
    name: string;
}
interface Input {
    entries: Writable<Default<Entry[], [
    ]>>;
}
interface Output {
    [UI]: VNode;
}
function visibleEntries(entries: Writable<Default<Entry[], [
]>>, prefix: string): Entry[] {
    const list = entries.get();
    return list.filter((entry) => prefix.length === 0 || entry.name.startsWith(prefix));
}
export default pattern((__ct_pattern_input) => {
    const entries = __ct_pattern_input.key("entries");
    const path = Writable.of<string[]>([], {
        type: "array",
        items: {
            type: "string"
        }
    } as const satisfies __ctHelpers.JSONSchema);
    const labelPrefix = Writable.of("prefix:", {
        type: "string"
    } as const satisfies __ctHelpers.JSONSchema);
    return {
        [UI]: (<div>
        {(() => {
                const p = __ctHelpers.unless({
                    type: "array",
                    items: {
                        type: "string"
                    }
                } as const satisfies __ctHelpers.JSONSchema, {
                    type: "array",
                    items: false
                } as const satisfies __ctHelpers.JSONSchema, {
                    type: "array",
                    items: {
                        type: "string"
                    }
                } as const satisfies __ctHelpers.JSONSchema, __ctHelpers.derive({
                    type: "object",
                    properties: {
                        path: {
                            type: "array",
                            items: {
                                type: "string"
                            },
                            asCell: true
                        }
                    },
                    required: ["path"]
                } as const satisfies __ctHelpers.JSONSchema, {
                    type: "array",
                    items: {
                        type: "string"
                    }
                } as const satisfies __ctHelpers.JSONSchema, { path: path }, ({ path }) => path.get()), []);
                const visible = __ctHelpers.derive({
                    type: "object",
                    properties: {
                        entries: {
                            type: "array",
                            items: {
                                $ref: "#/$defs/Entry"
                            },
                            asCell: true
                        },
                        p: {
                            type: "array",
                            items: {
                                type: "string"
                            }
                        }
                    },
                    required: ["entries", "p"],
                    $defs: {
                        Entry: {
                            type: "object",
                            properties: {
                                name: {
                                    type: "string"
                                }
                            },
                            required: ["name"]
                        }
                    }
                } as const satisfies __ctHelpers.JSONSchema, {
                    type: "array",
                    items: {
                        $ref: "#/$defs/Entry"
                    },
                    $defs: {
                        Entry: {
                            type: "object",
                            properties: {
                                name: {
                                    type: "string"
                                }
                            },
                            required: ["name"]
                        }
                    }
                } as const satisfies __ctHelpers.JSONSchema, {
                    entries: entries,
                    p: p
                }, ({ entries, p }) => visibleEntries(entries, p[0] || ""));
                return visible.mapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
                    const entry = __ct_pattern_input.key("element");
                    const labelPrefix = __ct_pattern_input.key("params", "labelPrefix");
                    return (<button type="button">
              {labelPrefix}:{entry.key("name")}
            </button>);
                }, {
                    type: "object",
                    properties: {
                        element: {
                            $ref: "#/$defs/Entry"
                        },
                        params: {
                            type: "object",
                            properties: {
                                labelPrefix: {
                                    type: "string",
                                    asCell: true
                                }
                            },
                            required: ["labelPrefix"]
                        }
                    },
                    required: ["element", "params"],
                    $defs: {
                        Entry: {
                            type: "object",
                            properties: {
                                name: {
                                    type: "string"
                                }
                            },
                            required: ["name"]
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
                } as const satisfies __ctHelpers.JSONSchema), {
                    labelPrefix: labelPrefix
                });
            })()}
      </div>),
    };
}, {
    type: "object",
    properties: {
        entries: {
            type: "array",
            items: {
                $ref: "#/$defs/Entry"
            },
            "default": [],
            asCell: true
        }
    },
    required: ["entries"],
    $defs: {
        Entry: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            },
            required: ["name"]
        }
    }
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        $UI: {
            $ref: "https://commonfabric.org/schemas/vnode.json"
        }
    },
    required: ["$UI"]
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
