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
 * TRANSFORM REPRO: helper-owned JSX IIFE with defaulted array input, local
 * initializer chain, and final map callback captures.
 *
 * The final callback array method should lower to mapWithPattern, but the
 * IIFE itself should stay decomposed rather than being blanket-wrapped.
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
    contentType?: string;
}
function findChildren(tree: readonly Entry[], path: readonly string[]): readonly Entry[] {
    let current: readonly Entry[] = tree;
    for (const name of path) {
        const folder = current.find((entry: Entry) => entry.name === name && entry.type === "folder");
        if (!folder || !folder.children)
            return [];
        current = folder.children;
    }
    return current;
}
__cfHardenFn(findChildren);
interface Input {
    entries: Default<Entry[], [
    ]>;
}
interface Output {
    [UI]: VNode;
}
export default pattern((__cf_pattern_input) => {
    const entries = __cf_pattern_input.key("entries");
    const path = Writable.of<string[]>([], {
        type: "array",
        items: {
            type: "string"
        }
    } as const satisfies __cfHelpers.JSONSchema);
    const handleNavigateInto = __cfHelpers.handler({
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
    const handleOpenFile = __cfHelpers.handler({
        type: "object",
        properties: {
            item: {
                $ref: "#/$defs/Entry"
            }
        },
        required: ["item"],
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
                        type: "array",
                        items: {
                            $ref: "#/$defs/Entry"
                        }
                    },
                    contentType: {
                        type: "string"
                    }
                },
                required: ["id", "name", "type"]
            }
        }
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "object",
        properties: {}
    } as const satisfies __cfHelpers.JSONSchema, ({ item }, __cf_action_params) => {
        void item;
    })({});
    return {
        [UI]: (<div>
        {(() => {
                const tree = (__cfHelpers.unless({
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
                                },
                                contentType: {
                                    type: "string"
                                }
                            },
                            required: ["id", "name", "type"]
                        }
                    }
                } as const satisfies __cfHelpers.JSONSchema, {
                    type: "array",
                    items: false
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
                                },
                                contentType: {
                                    type: "string"
                                }
                            },
                            required: ["id", "name", "type"]
                        }
                    }
                } as const satisfies __cfHelpers.JSONSchema, entries, [])) as Entry[];
                const p = (__cfHelpers.unless({
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
                } as const satisfies __cfHelpers.JSONSchema, { path: path }, ({ path }) => path.get()), [])) as string[];
                const unsorted = findChildren(tree, p) as Entry[];
                const items = __cfHelpers.derive({
                    type: "object",
                    properties: {
                        unsorted: {
                            $ref: "#/$defs/AnonymousType_1"
                        }
                    },
                    required: ["unsorted"],
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
                                },
                                contentType: {
                                    type: "string"
                                }
                            },
                            required: ["id", "name", "type"]
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
                                },
                                contentType: {
                                    type: "string"
                                }
                            },
                            required: ["id", "name", "type"]
                        }
                    }
                } as const satisfies __cfHelpers.JSONSchema, { unsorted: unsorted }, ({ unsorted }) => [...unsorted].sort((a: Entry, b: Entry) => {
                    if (a.type === b.type)
                        return 0;
                    return a.type === "file" ? -1 : 1;
                }));
                return items.mapWithPattern(__cfHelpers.pattern(__cf_pattern_input => {
                    const item = __cf_pattern_input.key("element");
                    const handleNavigateInto = __cf_pattern_input.key("params", "handleNavigateInto");
                    const handleOpenFile = __cf_pattern_input.key("params", "handleOpenFile");
                    const isFolder = item.key("type") === "folder";
                    const isOpenable = __cfHelpers.when({
                        type: "boolean"
                    } as const satisfies __cfHelpers.JSONSchema, {
                        type: "boolean"
                    } as const satisfies __cfHelpers.JSONSchema, {
                        type: "boolean"
                    } as const satisfies __cfHelpers.JSONSchema, !isFolder &&
                        !!item.key("contentType"), item.key("contentType") !== "binary");
                    return (<button type="button" onClick={isFolder
                            ? __cfHelpers.handler(false as const satisfies __cfHelpers.JSONSchema, {
                                type: "object",
                                properties: {
                                    handleNavigateInto: {
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
                                required: ["handleNavigateInto", "item"]
                            } as const satisfies __cfHelpers.JSONSchema, (_, { handleNavigateInto, item }) => handleNavigateInto.send({
                                name: item.name,
                            }))({
                                handleNavigateInto: handleNavigateInto,
                                item: {
                                    name: item.key("name")
                                }
                            }) : isOpenable
                            ? __cfHelpers.handler(false as const satisfies __cfHelpers.JSONSchema, {
                                type: "object",
                                properties: {
                                    handleOpenFile: {
                                        type: "object",
                                        properties: {
                                            item: {
                                                $ref: "#/$defs/Entry"
                                            }
                                        },
                                        required: ["item"],
                                        asStream: true
                                    },
                                    item: {
                                        $ref: "#/$defs/Entry"
                                    }
                                },
                                required: ["handleOpenFile", "item"],
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
                                            },
                                            contentType: {
                                                type: "string"
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
                            } as const satisfies __cfHelpers.JSONSchema, (_, { handleOpenFile, item }) => handleOpenFile.send({ item }))({
                                handleOpenFile: handleOpenFile,
                                item: item
                            }) : undefined}>
                {item.key("name")}
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
                                handleNavigateInto: {
                                    type: "object",
                                    properties: {
                                        name: {
                                            type: "string"
                                        }
                                    },
                                    required: ["name"],
                                    asStream: true
                                },
                                handleOpenFile: {
                                    type: "object",
                                    properties: {
                                        item: {
                                            $ref: "#/$defs/Entry"
                                        }
                                    },
                                    required: ["item"],
                                    asStream: true
                                }
                            },
                            required: ["handleNavigateInto", "handleOpenFile"]
                        }
                    },
                    required: ["element", "params"],
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
                                },
                                contentType: {
                                    type: "string"
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
                } as const satisfies __cfHelpers.JSONSchema), {
                    handleNavigateInto: handleNavigateInto,
                    handleOpenFile: handleOpenFile
                });
            })()}
      </div>),
    };
}, {
    type: "object",
    properties: {
        entries: {
            $ref: "#/$defs/AnonymousType_1",
            "default": []
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
                },
                contentType: {
                    type: "string"
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
__cfHardenFn(h);
