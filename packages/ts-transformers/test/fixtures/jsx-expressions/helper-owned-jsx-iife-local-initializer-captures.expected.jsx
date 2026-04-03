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
 * TRANSFORM REPRO: helper-owned JSX IIFE must account for local initializer dependencies
 *
 * The wrapper around this authored IIFE should capture the reactive roots that
 * feed local aliases declared inside the IIFE body. Capturing the inner locals
 * themselves (`tree`, `p`, `unsorted`, `items`) is wrong because they are not
 * in scope at the synthetic derive call site.
 */
import { action, Default, pattern, UI, VNode, Writable, } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __ctAmdHooks = undefined;
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
__ctHardenFn(findChildren);
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
                const tree = entries;
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
                const unsorted = __cfHelpers.derive({
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
                } as const satisfies __cfHelpers.JSONSchema, {
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
                } as const satisfies __cfHelpers.JSONSchema, {
                    tree: tree,
                    p: p
                }, ({ tree, p }) => findChildren(tree, p));
                const items = __cfHelpers.derive({
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
                } as const satisfies __cfHelpers.JSONSchema, {
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
                } as const satisfies __cfHelpers.JSONSchema, { unsorted: unsorted }, ({ unsorted }) => [...unsorted].sort((a: Entry, b: Entry) => a.name.localeCompare(b.name)));
                return items.map((item: Entry) => {
                    return (<button type="button" onClick={__cfHelpers.handler(false as const satisfies __cfHelpers.JSONSchema, {
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
                    } as const satisfies __cfHelpers.JSONSchema, (_, { pushPath, item }) => pushPath.send({ name: item.name }))({
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
