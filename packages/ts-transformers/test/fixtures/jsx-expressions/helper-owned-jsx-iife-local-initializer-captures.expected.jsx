import * as __ctHelpers from "commontools";
/**
 * TRANSFORM REPRO: helper-owned JSX IIFE must account for local initializer dependencies
 *
 * The wrapper around this authored IIFE should capture the reactive roots that
 * feed local aliases declared inside the IIFE body. Capturing the inner locals
 * themselves (`tree`, `p`, `unsorted`, `items`) is wrong because they are not
 * in scope at the synthetic derive call site.
 */
import { action, Default, pattern, UI, VNode, Writable, } from "commontools";
interface Entry {
    id: string;
    name: string;
    type: "file" | "folder";
    children?: Entry[];
}
function findChildren(tree: Writable<Entry[]>, path: readonly string[]): readonly Entry[] {
    let current = tree.get();
    for (const name of path) {
        const folder = current.find((entry: Entry) => entry.name === name && entry.type === "folder");
        if (!folder || !folder.children)
            return [];
        current = folder.children;
    }
    return current;
}
interface Input {
    entries: Writable<Default<Entry[], [
    ]>>;
}
interface Output {
    [UI]: VNode;
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
                const tree = entries;
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
                const unsorted = __ctHelpers.derive({
                    type: "object",
                    properties: {
                        tree: {
                            $ref: "#/$defs/AnonymousType_1",
                            asCell: true
                        },
                        p: {
                            type: "array",
                            items: {
                                type: "string"
                            }
                        }
                    },
                    required: ["tree", "p"],
                    $defs: {
                        AnonymousType_1: {
                            type: "array",
                            items: {
                                $ref: "#/$defs/Entry"
                            }
                        },
                        Entry: {
                            type: "object",
                            properties: {
                                id: {
                                    type: "string"
                                },
                                name: {
                                    type: "string"
                                },
                                type: {
                                    "enum": ["file", "folder"]
                                },
                                children: {
                                    $ref: "#/$defs/AnonymousType_1"
                                }
                            },
                            required: ["id", "name", "type"]
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
                                id: {
                                    type: "string"
                                },
                                name: {
                                    type: "string"
                                },
                                type: {
                                    "enum": ["file", "folder"]
                                },
                                children: {
                                    $ref: "#/$defs/AnonymousType_1"
                                }
                            },
                            required: ["id", "name", "type"]
                        },
                        AnonymousType_1: {
                            type: "array",
                            items: {
                                $ref: "#/$defs/Entry"
                            }
                        }
                    }
                } as const satisfies __ctHelpers.JSONSchema, {
                    tree: tree,
                    p: p
                }, ({ tree, p }) => findChildren(tree, p));
                const items = __ctHelpers.derive({
                    type: "object",
                    properties: {
                        unsorted: {
                            type: "array",
                            items: {
                                $ref: "#/$defs/Entry"
                            }
                        }
                    },
                    required: ["unsorted"],
                    $defs: {
                        Entry: {
                            type: "object",
                            properties: {
                                id: {
                                    type: "string"
                                },
                                name: {
                                    type: "string"
                                },
                                type: {
                                    "enum": ["file", "folder"]
                                },
                                children: {
                                    $ref: "#/$defs/AnonymousType_1"
                                }
                            },
                            required: ["id", "name", "type"]
                        },
                        AnonymousType_1: {
                            type: "array",
                            items: {
                                $ref: "#/$defs/Entry"
                            }
                        }
                    }
                } as const satisfies __ctHelpers.JSONSchema, {
                    $ref: "#/$defs/AnonymousType_1",
                    $defs: {
                        AnonymousType_1: {
                            type: "array",
                            items: {
                                $ref: "#/$defs/Entry"
                            }
                        },
                        Entry: {
                            type: "object",
                            properties: {
                                id: {
                                    type: "string"
                                },
                                name: {
                                    type: "string"
                                },
                                type: {
                                    "enum": ["file", "folder"]
                                },
                                children: {
                                    $ref: "#/$defs/AnonymousType_1"
                                }
                            },
                            required: ["id", "name", "type"]
                        }
                    }
                } as const satisfies __ctHelpers.JSONSchema, { unsorted: unsorted }, ({ unsorted }) => [...unsorted].sort((a: Entry, b: Entry) => a.name.localeCompare(b.name)));
                return items.map((item: Entry) => {
                    return (<button type="button" onClick={__ctHelpers.handler(false as const satisfies __ctHelpers.JSONSchema, {
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
                            item: {
                                type: "object",
                                properties: {
                                    name: {
                                        type: "string"
                                    }
                                },
                                required: ["name"]
                            }
                        },
                        required: ["pushPath", "item"]
                    } as const satisfies __ctHelpers.JSONSchema, (_, { pushPath, item }) => pushPath.send({ name: item.name }))({
                        pushPath: pushPath,
                        item: {
                            name: item.name
                        }
                    })}>
                {item.name}
              </button>);
                });
            })()}
      </div>),
    };
}, {
    type: "object",
    properties: {
        entries: {
            $ref: "#/$defs/AnonymousType_1",
            "default": [],
            asCell: true
        }
    },
    required: ["entries"],
    $defs: {
        AnonymousType_1: {
            type: "array",
            items: {
                $ref: "#/$defs/Entry"
            }
        },
        Entry: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                },
                name: {
                    type: "string"
                },
                type: {
                    "enum": ["file", "folder"]
                },
                children: {
                    $ref: "#/$defs/AnonymousType_1"
                }
            },
            required: ["id", "name", "type"]
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
