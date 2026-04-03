import * as __ctHelpers from "commontools";
/**
 * TRANSFORM REPRO: helper-owned JSX IIFE decomposes through local aliases
 *
 * We want the decomposed branch shape, not main's blanket outer-IIFE wrapping.
 * The important invariant is that local aliases like `const p = path.get() || []`
 * must not hide the explicit `path -> visible` dependency when later helper-owned
 * derives are created.
 */
import { action, Default, pattern, UI, VNode, Writable, } from "commontools";
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
    const pushPath = __ctHelpers.handler({
        type: "object",
        properties: {
            name: {
                type: "string"
            }
        },
        required: ["name"]
    } as const satisfies __ctHelpers.JSONSchema, {
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
    } as const satisfies __ctHelpers.JSONSchema, ({ name }, { path }) => {
        path.push(name);
    })({
        path: path
    });
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
                if (p.length === 0)
                    return null;
                return <div>{__ctHelpers.derive({
                    type: "object",
                    properties: {
                        p: {
                            type: "array",
                            items: {
                                type: "string"
                            }
                        }
                    },
                    required: ["p"]
                } as const satisfies __ctHelpers.JSONSchema, {
                    type: ["string", "undefined"]
                } as const satisfies __ctHelpers.JSONSchema, { p: p }, ({ p }) => p[p.length - 1])}</div>;
            })()}
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
                return visible.map((entry) => (<button type="button" onClick={__ctHelpers.handler(false as const satisfies __ctHelpers.JSONSchema, {
                    type: "object",
                    properties: {
                        pushPath: {
                            type: "object",
                            properties: {
                                name: {
                                    type: "string"
                                }
                            },
                            required: ["name"],
                            asStream: true
                        },
                        entry: {
                            type: "object",
                            properties: {
                                name: {
                                    type: "string"
                                }
                            },
                            required: ["name"]
                        }
                    },
                    required: ["pushPath", "entry"]
                } as const satisfies __ctHelpers.JSONSchema, (_, { pushPath, entry }) => pushPath.send({ name: entry.name }))({
                    pushPath: pushPath,
                    entry: {
                        name: entry.name
                    }
                })}>
              {entry.name}
            </button>));
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
