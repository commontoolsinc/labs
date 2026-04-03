import * as __ctHelpers from "commontools";
import { computed, handler, ifElse, pattern, UI, Writable } from "commontools";
const openNoteEditor = handler({
    type: "unknown"
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        subPieces: {
            type: "array",
            items: {
                type: "string"
            }
        },
        editingNoteIndex: {
            type: ["number", "undefined"]
        },
        editingNoteText: {
            type: "string"
        },
        index: {
            type: "number"
        }
    },
    required: ["subPieces", "editingNoteIndex", "editingNoteText", "index"]
} as const satisfies __ctHelpers.JSONSchema, (_event, state) => state);
const openSettings = handler({
    type: "unknown"
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        settingsModuleIndex: {
            type: ["number", "undefined"]
        },
        index: {
            type: "number"
        }
    },
    required: ["settingsModuleIndex", "index"]
} as const satisfies __ctHelpers.JSONSchema, (_event, state) => state);
const toggleExpanded = handler({
    type: "unknown"
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        expandedIndex: {
            type: ["number", "undefined"]
        },
        index: {
            type: "number"
        }
    },
    required: ["expandedIndex", "index"]
} as const satisfies __ctHelpers.JSONSchema, (_event, state) => state);
const trashSubPiece = handler({
    type: "unknown"
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        subPieces: {
            type: "array",
            items: {
                type: "string"
            }
        },
        trashedSubPieces: {
            type: "array",
            items: {
                type: "string"
            }
        },
        expandedIndex: {
            type: ["number", "undefined"]
        },
        settingsModuleIndex: {
            type: ["number", "undefined"]
        },
        index: {
            type: "number"
        }
    },
    required: ["subPieces", "trashedSubPieces", "expandedIndex", "settingsModuleIndex", "index"]
} as const satisfies __ctHelpers.JSONSchema, (_event, state) => state);
interface Item {
    note?: string;
    collapsed?: boolean;
    pinned?: boolean;
    allowMultiple: boolean;
}
// FIXTURE: branch-lowered-capture-preservation
// Verifies: branch-lowered UI chunks inside a computed-array map preserve captured
// params needed by nested ifElse branches, inline computed() attributes, and handlers
//   allEntries.map(...)                     -> mapWithPattern(...)
//   ifElse(computed(() => !entry.collapsed), ...) -> branch lowering keeps entry/index ownership
//   openNoteEditor/openSettings/toggleExpanded/trashSubPiece handlers
//     -> params captures survive inside lowered branches
//   computed(() => entry?.note ? "700" : "400") / title computed(...)
//     -> authored compute wrappers still coexist with the preserved captures
export default pattern((__ct_pattern_input) => {
    const items = __ct_pattern_input.key("items");
    const subPieces = __ct_pattern_input.key("subPieces");
    const trashedSubPieces = __ct_pattern_input.key("trashedSubPieces");
    const editingNoteIndex = Writable.of<number | undefined>(undefined, {
        type: ["number", "undefined"]
    } as const satisfies __ctHelpers.JSONSchema);
    const editingNoteText = Writable.of("", {
        type: "string"
    } as const satisfies __ctHelpers.JSONSchema);
    const expandedIndex = Writable.of<number | undefined>(undefined, {
        type: ["number", "undefined"]
    } as const satisfies __ctHelpers.JSONSchema);
    const settingsModuleIndex = Writable.of<number | undefined>(undefined, {
        type: ["number", "undefined"]
    } as const satisfies __ctHelpers.JSONSchema);
    const allEntries = __ctHelpers.derive({
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
                    note: {
                        type: "string"
                    },
                    collapsed: {
                        type: "boolean"
                    },
                    pinned: {
                        type: "boolean"
                    },
                    allowMultiple: {
                        type: "boolean"
                    }
                },
                required: ["allowMultiple"]
            }
        }
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "array",
        items: {
            type: "object",
            properties: {
                entry: {
                    $ref: "#/$defs/Item"
                },
                index: {
                    type: "number"
                },
                isExpanded: {
                    type: "boolean"
                },
                isPinned: {
                    type: "boolean"
                },
                allowMultiple: {
                    type: "boolean"
                }
            },
            required: ["entry", "index", "isExpanded", "isPinned", "allowMultiple"]
        },
        $defs: {
            Item: {
                type: "object",
                properties: {
                    note: {
                        type: "string"
                    },
                    collapsed: {
                        type: "boolean"
                    },
                    pinned: {
                        type: "boolean"
                    },
                    allowMultiple: {
                        type: "boolean"
                    }
                },
                required: ["allowMultiple"]
            }
        }
    } as const satisfies __ctHelpers.JSONSchema, { items: items }, ({ items }) => items.map((entry, index) => ({
        entry,
        index,
        isExpanded: index === 0,
        isPinned: entry.pinned || false,
        allowMultiple: entry.allowMultiple,
    })));
    return {
        [UI]: (<div>
        {allEntries.mapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
                const entry = __ct_pattern_input.key("element", "entry");
                const index = __ct_pattern_input.key("element", "index");
                const isExpanded = __ct_pattern_input.key("element", "isExpanded");
                const isPinned = __ct_pattern_input.key("element", "isPinned");
                const allowMultiple = __ct_pattern_input.key("element", "allowMultiple");
                const subPieces = __ct_pattern_input.key("params", "subPieces");
                const editingNoteIndex = __ct_pattern_input.key("params", "editingNoteIndex");
                const editingNoteText = __ct_pattern_input.key("params", "editingNoteText");
                const settingsModuleIndex = __ct_pattern_input.key("params", "settingsModuleIndex");
                const expandedIndex = __ct_pattern_input.key("params", "expandedIndex");
                const trashedSubPieces = __ct_pattern_input.key("params", "trashedSubPieces");
                return ifElse({
                    type: "boolean"
                } as const satisfies __ctHelpers.JSONSchema, {
                    anyOf: [{}, {
                            type: "object",
                            properties: {}
                        }]
                } as const satisfies __ctHelpers.JSONSchema, {
                    type: "null"
                } as const satisfies __ctHelpers.JSONSchema, {
                    anyOf: [{
                            type: "null"
                        }, {}]
                } as const satisfies __ctHelpers.JSONSchema, __ctHelpers.derive({
                    type: "object",
                    properties: {
                        entry: {
                            type: "object",
                            properties: {
                                collapsed: {
                                    anyOf: [{
                                            type: "undefined"
                                        }, {
                                            type: "boolean"
                                        }]
                                }
                            }
                        }
                    },
                    required: ["entry"]
                } as const satisfies __ctHelpers.JSONSchema, {
                    type: "boolean"
                } as const satisfies __ctHelpers.JSONSchema, { entry: {
                        collapsed: entry.key("collapsed")
                    } }, ({ entry }) => !entry.collapsed), <div>
              {ifElse({
                        type: "boolean"
                    } as const satisfies __ctHelpers.JSONSchema, {
                        anyOf: [{}, {
                                type: "object",
                                properties: {}
                            }]
                    } as const satisfies __ctHelpers.JSONSchema, {
                        type: "null"
                    } as const satisfies __ctHelpers.JSONSchema, {
                        anyOf: [{
                                type: "null"
                            }, {}]
                    } as const satisfies __ctHelpers.JSONSchema, allowMultiple, <button type="button" onClick={openNoteEditor({
                            subPieces,
                            editingNoteIndex,
                            editingNoteText,
                            index,
                        })} style={__ctHelpers.derive({
                            type: "object",
                            properties: {
                                entry: {
                                    type: "object",
                                    properties: {
                                        note: {
                                            type: "string"
                                        }
                                    }
                                }
                            },
                            required: ["entry"]
                        } as const satisfies __ctHelpers.JSONSchema, {
                            type: "object",
                            properties: {
                                fontWeight: {
                                    type: "string"
                                }
                            },
                            required: ["fontWeight"]
                        } as const satisfies __ctHelpers.JSONSchema, { entry: entry }, ({ entry }) => ({
                            fontWeight: entry?.note ? "700" : "400",
                        }))} title={__ctHelpers.derive({
                        type: "object",
                        properties: {
                            entry: {
                                type: "object",
                                properties: {
                                    note: {
                                        type: "string"
                                    }
                                }
                            }
                        },
                        required: ["entry"]
                    } as const satisfies __ctHelpers.JSONSchema, {
                        type: "string"
                    } as const satisfies __ctHelpers.JSONSchema, { entry: entry }, ({ entry }) => entry?.note || "Add note...")}>
                  note
                </button>, null)}
              {__ctHelpers.when({
                    type: "boolean"
                } as const satisfies __ctHelpers.JSONSchema, {
                    anyOf: [{
                            type: "null"
                        }, {}]
                } as const satisfies __ctHelpers.JSONSchema, {
                    anyOf: [{
                            type: ["boolean", "null"]
                        }, {}]
                } as const satisfies __ctHelpers.JSONSchema, __ctHelpers.derive({
                    type: "object",
                    properties: {
                        isExpanded: {
                            type: "boolean"
                        }
                    },
                    required: ["isExpanded"]
                } as const satisfies __ctHelpers.JSONSchema, {
                    type: "boolean"
                } as const satisfies __ctHelpers.JSONSchema, { isExpanded: isExpanded }, ({ isExpanded }) => !isExpanded), ifElse({
                    type: "boolean"
                } as const satisfies __ctHelpers.JSONSchema, {
                    anyOf: [{}, {
                            type: "object",
                            properties: {}
                        }]
                } as const satisfies __ctHelpers.JSONSchema, {
                    type: "null"
                } as const satisfies __ctHelpers.JSONSchema, {
                    anyOf: [{
                            type: "null"
                        }, {}]
                } as const satisfies __ctHelpers.JSONSchema, true, <button type="button" onClick={openSettings({ settingsModuleIndex, index })}>
                  settings
                </button>, null))}
              <button type="button" onClick={toggleExpanded({ expandedIndex, index })} style={{ background: __ctHelpers.ifElse({
                        type: "boolean"
                    } as const satisfies __ctHelpers.JSONSchema, {
                        type: "string"
                    } as const satisfies __ctHelpers.JSONSchema, {
                        type: "string"
                    } as const satisfies __ctHelpers.JSONSchema, {
                        "enum": ["a", "b"]
                    } as const satisfies __ctHelpers.JSONSchema, isPinned, "a", "b") }}>
                expand
              </button>
              {__ctHelpers.when({
                    type: "boolean"
                } as const satisfies __ctHelpers.JSONSchema, {
                    anyOf: [{}, {
                            type: "object",
                            properties: {}
                        }]
                } as const satisfies __ctHelpers.JSONSchema, {
                    anyOf: [{
                            type: "boolean"
                        }, {}, {
                            type: "object",
                            properties: {}
                        }]
                } as const satisfies __ctHelpers.JSONSchema, __ctHelpers.derive({
                    type: "object",
                    properties: {
                        isExpanded: {
                            type: "boolean"
                        }
                    },
                    required: ["isExpanded"]
                } as const satisfies __ctHelpers.JSONSchema, {
                    type: "boolean"
                } as const satisfies __ctHelpers.JSONSchema, { isExpanded: isExpanded }, ({ isExpanded }) => !isExpanded), <button type="button" onClick={trashSubPiece({
                        subPieces,
                        trashedSubPieces,
                        expandedIndex,
                        settingsModuleIndex,
                        index,
                    })}>
                  trash
                </button>)}
            </div>, null);
            }, {
                type: "object",
                properties: {
                    element: {
                        type: "object",
                        properties: {
                            entry: {
                                $ref: "#/$defs/Item"
                            },
                            index: {
                                type: "number"
                            },
                            isExpanded: {
                                type: "boolean"
                            },
                            isPinned: {
                                type: "boolean"
                            },
                            allowMultiple: {
                                type: "boolean"
                            }
                        },
                        required: ["entry", "index", "isExpanded", "isPinned", "allowMultiple"]
                    },
                    params: {
                        type: "object",
                        properties: {
                            subPieces: {
                                type: "array",
                                items: {
                                    type: "string"
                                }
                            },
                            editingNoteIndex: {
                                type: ["number", "undefined"],
                                asCell: true
                            },
                            editingNoteText: {
                                type: "string",
                                asCell: true
                            },
                            settingsModuleIndex: {
                                type: ["number", "undefined"],
                                asCell: true
                            },
                            expandedIndex: {
                                type: ["number", "undefined"],
                                asCell: true
                            },
                            trashedSubPieces: {
                                type: "array",
                                items: {
                                    type: "string"
                                }
                            }
                        },
                        required: ["subPieces", "editingNoteIndex", "editingNoteText", "settingsModuleIndex", "expandedIndex", "trashedSubPieces"]
                    }
                },
                required: ["element", "params"],
                $defs: {
                    Item: {
                        type: "object",
                        properties: {
                            note: {
                                type: "string"
                            },
                            collapsed: {
                                type: "boolean"
                            },
                            pinned: {
                                type: "boolean"
                            },
                            allowMultiple: {
                                type: "boolean"
                            }
                        },
                        required: ["allowMultiple"]
                    }
                }
            } as const satisfies __ctHelpers.JSONSchema, {
                anyOf: [{
                        type: "null"
                    }, {
                        $ref: "https://commonfabric.org/schemas/vnode.json"
                    }, {
                        $ref: "#/$defs/UIRenderable"
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
                subPieces: subPieces,
                editingNoteIndex: editingNoteIndex,
                editingNoteText: editingNoteText,
                settingsModuleIndex: settingsModuleIndex,
                expandedIndex: expandedIndex,
                trashedSubPieces: trashedSubPieces
            })}
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
        },
        subPieces: {
            type: "array",
            items: {
                type: "string"
            }
        },
        trashedSubPieces: {
            type: "array",
            items: {
                type: "string"
            }
        }
    },
    required: ["items", "subPieces", "trashedSubPieces"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                note: {
                    type: "string"
                },
                collapsed: {
                    type: "boolean"
                },
                pinned: {
                    type: "boolean"
                },
                allowMultiple: {
                    type: "boolean"
                }
            },
            required: ["allowMultiple"]
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
