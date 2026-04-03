function __ctHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __ctHelpers as __cfHelpers } from "commonfabric";
/**
 * TRANSFORM REPRO: helper-owned JSX IIFE decomposes through local aliases
 *
 * We want the decomposed branch shape, not main's blanket outer-IIFE wrapping.
 * The important invariant is that local aliases like `const p = path.get() || []`
 * must not hide the explicit `path -> visible` dependency when later helper-owned
 * derives are created.
 */
import { action, Default, pattern, UI, VNode, Writable, } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __ctAmdHooks = undefined;
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
__ctHardenFn(visibleEntries);
export default pattern((__ct_pattern_input) => {
    const entries = __ct_pattern_input.key("entries");
    const path = Writable.of<string[]>([], {
        type: "array",
        items: {
            type: "string"
        }
    } as const satisfies __cfHelpers.JSONSchema);
    const pushPath = __cfHelpers.handler({
        type: "object",
        properties: {
            name: {
                type: "string"
            }
        },
        required: ["name"]
    } as const satisfies __cfHelpers.JSONSchema, {
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
    } as const satisfies __cfHelpers.JSONSchema, ({ name }, { path }) => {
        path.push(name);
    })({
        path: path
    });
    return {
        [UI]: (<div>
        {(() => {
                const p = __cfHelpers.unless({
                    type: "array",
                    items: {
                        type: "string"
                    }
                } as const satisfies __cfHelpers.JSONSchema, {
                    type: "array",
                    items: false
                } as const satisfies __cfHelpers.JSONSchema, {
                    type: "array",
                    items: {
                        type: "string"
                    }
                } as const satisfies __cfHelpers.JSONSchema, __cfHelpers.derive({
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
                } as const satisfies __cfHelpers.JSONSchema, {
                    type: "array",
                    items: {
                        type: "string"
                    }
                } as const satisfies __cfHelpers.JSONSchema, { path: path }, ({ path }) => path.get()), []);
                if (p.length === 0)
                    return null;
                return <div>{__cfHelpers.derive({
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
                } as const satisfies __cfHelpers.JSONSchema, {
                    type: ["string", "undefined"]
                } as const satisfies __cfHelpers.JSONSchema, { p: p }, ({ p }) => p[p.length - 1])}</div>;
            })()}
        {(() => {
                const p = __cfHelpers.unless({
                    type: "array",
                    items: {
                        type: "string"
                    }
                } as const satisfies __cfHelpers.JSONSchema, {
                    type: "array",
                    items: false
                } as const satisfies __cfHelpers.JSONSchema, {
                    type: "array",
                    items: {
                        type: "string"
                    }
                } as const satisfies __cfHelpers.JSONSchema, __cfHelpers.derive({
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
                } as const satisfies __cfHelpers.JSONSchema, {
                    type: "array",
                    items: {
                        type: "string"
                    }
                } as const satisfies __cfHelpers.JSONSchema, { path: path }, ({ path }) => path.get()), []);
                const visible = __cfHelpers.derive({
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
                } as const satisfies __cfHelpers.JSONSchema, {
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
                } as const satisfies __cfHelpers.JSONSchema, {
                    entries: entries,
                    p: p
                }, ({ entries, p }) => visibleEntries(entries, p[0] || ""));
                return visible.map((entry) => (<button type="button" onClick={__cfHelpers.handler(false as const satisfies __cfHelpers.JSONSchema, {
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
                } as const satisfies __cfHelpers.JSONSchema, (_, { pushPath, entry }) => pushPath.send({ name: entry.name }))({
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
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        $UI: {
            $ref: "https://commonfabric.org/schemas/vnode.json"
        }
    },
    required: ["$UI"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__ctHardenFn(h);
