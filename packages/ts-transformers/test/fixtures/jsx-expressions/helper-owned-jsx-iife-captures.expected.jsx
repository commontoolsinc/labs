// transformed: /index.ts
export * from "/ba4jcbhp5xdmodklp4svhxwe4byht62haa5wwnm7xjiotgakxz737ui6o/.codex-tmp/files-capture-repros/helper-owned-jsx-iife-captures.tsx";
export { default } from "/ba4jcbhp5xdmodklp4svhxwe4byht62haa5wwnm7xjiotgakxz737ui6o/.codex-tmp/files-capture-repros/helper-owned-jsx-iife-captures.tsx";

// transformed: /ba4jcbhp5xdmodklp4svhxwe4byht62haa5wwnm7xjiotgakxz737ui6o/.codex-tmp/files-capture-repros/helper-owned-jsx-iife-captures.tsx
import * as __ctHelpers from "commontools";
import { action, Default, pattern, Stream, UI, VNode, Writable, } from "commontools";
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
                const p = path.get() || [];
                if (p.length === 0)
                    return null;
                return <div>{p[p.length - 1]}</div>;
            })()}
        {__ctHelpers.derive({
            type: "object",
            properties: {
                path: {
                    type: "array",
                    items: {
                        type: "unknown"
                    },
                    asCell: true
                },
                entries: {
                    type: "array",
                    items: {
                        $ref: "#/$defs/Entry"
                    },
                    asCell: true
                },
                pushPath: {
                    type: "object",
                    properties: {
                        name: {
                            type: "string"
                        }
                    },
                    required: ["name"],
                    asStream: true
                }
            },
            required: ["path", "entries", "pushPath"],
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
        } as const satisfies __ctHelpers.JSONSchema, {
            path: path,
            entries: entries,
            pushPath: pushPath
        }, ({ path, entries, pushPath }) => (() => {
            const p = path.get() || [];
            const visible = visibleEntries(entries, p[0] || "");
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
        })())}
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

