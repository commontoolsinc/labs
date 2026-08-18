function __cfBindVerifiedBinding(value: any, metadata: any) {
    if (value && (typeof value === "object" || typeof value === "function") && Object.isExtensible(value)) {
        Object.defineProperty(value, "__cfVerifiedBindingIdentity", {
            value: metadata,
            configurable: true
        });
    }
    if (value && (typeof value === "object" || typeof value === "function") && typeof value.implementation === "function") {
        var implementation = value.implementation;
        if (implementation && (typeof implementation === "object" || typeof implementation === "function") && Object.isExtensible(implementation)) {
            Object.defineProperty(implementation, "__cfVerifiedBindingIdentity", {
                value: metadata,
                configurable: true
            });
        }
    }
    return value;
}
function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { computed, handler, ifElse, pattern, UI, Writable } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const openNoteEditor = handler({
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema, {
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
} as const satisfies __cfHelpers.JSONSchema, (_event, state) => state);
__cfBindVerifiedBinding(openNoteEditor, {
    sourceFile: "/test.tsx",
    position: { line: 9, col: 3 },
    bindingName: "openNoteEditor"
});
const openSettings = handler({
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema, {
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
} as const satisfies __cfHelpers.JSONSchema, (_event, state) => state);
__cfBindVerifiedBinding(openSettings, {
    sourceFile: "/test.tsx",
    position: { line: 13, col: 3 },
    bindingName: "openSettings"
});
const toggleExpanded = handler({
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema, {
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
} as const satisfies __cfHelpers.JSONSchema, (_event, state) => state);
__cfBindVerifiedBinding(toggleExpanded, {
    sourceFile: "/test.tsx",
    position: { line: 17, col: 3 },
    bindingName: "toggleExpanded"
});
const trashSubPiece = handler({
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema, {
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
} as const satisfies __cfHelpers.JSONSchema, (_event, state) => state);
__cfBindVerifiedBinding(trashSubPiece, {
    sourceFile: "/test.tsx",
    position: { line: 24, col: 3 },
    bindingName: "trashSubPiece"
});
interface Item {
    note?: string;
    collapsed?: boolean;
    pinned?: boolean;
    allowMultiple: boolean;
}
const __cfLift_1 = __cfHelpers.lift<{
    items: Item[];
}, { entry: Item; index: number; isExpanded: boolean; isPinned: boolean; allowMultiple: boolean; }[]>(({ items }) => items.map((entry, index) => ({
    entry,
    index,
    isExpanded: index === 0,
    isPinned: entry.pinned || false,
    allowMultiple: entry.allowMultiple,
})), {
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
} as const satisfies __cfHelpers.JSONSchema, {
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
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
__cfBindVerifiedBinding(__cfLift_1, {
    sourceFile: "/test.tsx",
    position: { line: 52, col: 30 },
    bindingName: "allEntries"
});
const __cfLift_2 = __cfHelpers.lift<{
    entry: {
        collapsed?: boolean | undefined;
    };
}, boolean>(({ entry }) => !entry.collapsed, {
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
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
__cfBindVerifiedBinding(__cfLift_2, {
    sourceFile: "/test.tsx",
    position: { line: 67, col: 21 }
});
const __cfLift_3 = __cfHelpers.lift<{
    entry: {
        note?: string | undefined;
    };
}, { fontWeight: string; }>(({ entry }) => ({
    fontWeight: entry?.note ? "700" : "400",
}), {
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
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        fontWeight: {
            type: "string"
        }
    },
    required: ["fontWeight"]
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
__cfBindVerifiedBinding(__cfLift_3, {
    sourceFile: "/test.tsx",
    position: { line: 79, col: 34 }
});
const __cfLift_4 = __cfHelpers.lift<{
    entry: {
        note?: string | undefined;
    };
}, string>(({ entry }) => entry?.note || "Add note...", {
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
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
__cfBindVerifiedBinding(__cfLift_4, {
    sourceFile: "/test.tsx",
    position: { line: 82, col: 34 }
});
const __cfLift_5 = __cfHelpers.lift<{
    isExpanded: boolean;
}, boolean>(({ isExpanded }) => !isExpanded, {
    type: "object",
    properties: {
        isExpanded: {
            type: "boolean"
        }
    },
    required: ["isExpanded"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
__cfBindVerifiedBinding(__cfLift_5, {
    sourceFile: "/test.tsx",
    position: { line: 88, col: 15 }
});
const __cfLift_6 = __cfHelpers.lift<{
    isExpanded: boolean;
}, boolean>(({ isExpanded }) => !isExpanded, {
    type: "object",
    properties: {
        isExpanded: {
            type: "boolean"
        }
    },
    required: ["isExpanded"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
__cfBindVerifiedBinding(__cfLift_6, {
    sourceFile: "/test.tsx",
    position: { line: 105, col: 15 }
});
const __cfPattern_1 = __cfHelpers.pattern(__cf_pattern_input => {
    const entry = __cf_pattern_input.key("element", "entry");
    const index = __cf_pattern_input.key("element", "index");
    const isExpanded = __cf_pattern_input.key("element", "isExpanded");
    const isPinned = __cf_pattern_input.key("element", "isPinned");
    const allowMultiple = __cf_pattern_input.key("element", "allowMultiple");
    const subPieces = __cf_pattern_input.key("params", "subPieces");
    const editingNoteIndex = __cf_pattern_input.key("params", "editingNoteIndex");
    const editingNoteText = __cf_pattern_input.key("params", "editingNoteText");
    const settingsModuleIndex = __cf_pattern_input.key("params", "settingsModuleIndex");
    const expandedIndex = __cf_pattern_input.key("params", "expandedIndex");
    const trashedSubPieces = __cf_pattern_input.key("params", "trashedSubPieces");
    return ifElse({
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema, {
        anyOf: [{}, {
                type: "object",
                properties: {}
            }]
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "null"
    } as const satisfies __cfHelpers.JSONSchema, {
        anyOf: [{
                type: "null"
            }, {}]
    } as const satisfies __cfHelpers.JSONSchema, __cfLift_2({ entry: {
            collapsed: entry.key("collapsed")
        } }), <div>
              {ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            anyOf: [{}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "null"
        } as const satisfies __cfHelpers.JSONSchema, {
            anyOf: [{
                    type: "null"
                }, {}]
        } as const satisfies __cfHelpers.JSONSchema, allowMultiple, <button type="button" onClick={openNoteEditor({
                subPieces,
                editingNoteIndex,
                editingNoteText,
                index,
            })} style={__cfLift_3({ entry: entry })} title={__cfLift_4({ entry: entry })}>
                  note
                </button>, null)}
              {__cfHelpers.when({
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema, {
        anyOf: [{
                type: "null"
            }, {}]
    } as const satisfies __cfHelpers.JSONSchema, {
        anyOf: [{
                type: ["boolean", "null"]
            }, {}]
    } as const satisfies __cfHelpers.JSONSchema, __cfLift_5({ isExpanded: isExpanded }), ifElse({
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema, {
        anyOf: [{}, {
                type: "object",
                properties: {}
            }]
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "null"
    } as const satisfies __cfHelpers.JSONSchema, {
        anyOf: [{
                type: "null"
            }, {}]
    } as const satisfies __cfHelpers.JSONSchema, true, <button type="button" onClick={openSettings({ settingsModuleIndex, index })}>
                  settings
                </button>, null))}
              <button type="button" onClick={toggleExpanded({ expandedIndex, index })} style={{ background: __cfHelpers.ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            "enum": ["a", "b"]
        } as const satisfies __cfHelpers.JSONSchema, isPinned, "a", "b") }}>
                expand
              </button>
              {__cfHelpers.when({
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema, {
        anyOf: [{}, {
                type: "object",
                properties: {}
            }]
    } as const satisfies __cfHelpers.JSONSchema, {
        anyOf: [{
                type: "boolean"
            }, {}, {
                type: "object",
                properties: {}
            }]
    } as const satisfies __cfHelpers.JSONSchema, __cfLift_6({ isExpanded: isExpanded }), <button type="button" onClick={trashSubPiece({
            subPieces,
            trashedSubPieces,
            expandedIndex,
            settingsModuleIndex,
            index,
        })}>
                  trash
                </button>)}
            </div>, null).for("__patternResult", true);
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
                    anyOf: [{
                            type: "number"
                        }, {
                            type: "undefined"
                        }],
                    asCell: ["readonly"]
                },
                editingNoteText: {
                    type: "string",
                    asCell: ["readonly"]
                },
                settingsModuleIndex: {
                    anyOf: [{
                            type: "number"
                        }, {
                            type: "undefined"
                        }],
                    asCell: ["readonly"]
                },
                expandedIndex: {
                    anyOf: [{
                            type: "number"
                        }, {
                            type: "undefined"
                        }],
                    asCell: ["readonly"]
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
} as const satisfies __cfHelpers.JSONSchema, {
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
} as const satisfies __cfHelpers.JSONSchema);
__cfBindVerifiedBinding(__cfPattern_1, {
    sourceFile: "/test.tsx",
    position: { line: 65, col: 24 }
});
// FIXTURE: branch-lowered-capture-preservation
// Verifies: branch-lowered UI chunks inside a computed-array map preserve captured
// params needed by nested ifElse branches, inline computed() attributes, and handlers
//   allEntries.map(...)                     -> mapWithPattern(...)
//   ifElse(computed(() => !entry.collapsed), ...) -> branch lowering keeps entry/index ownership
//   openNoteEditor/openSettings/toggleExpanded/trashSubPiece handlers
//     -> params captures survive inside lowered branches
//   computed(() => entry?.note ? "700" : "400") / title computed(...)
//     -> authored compute wrappers still coexist with the preserved captures
export default __cfBindVerifiedBinding(pattern((__cf_pattern_input) => {
    const items = __cf_pattern_input.key("items");
    const subPieces = __cf_pattern_input.key("subPieces");
    const trashedSubPieces = __cf_pattern_input.key("trashedSubPieces");
    const editingNoteIndex = new Writable<number | undefined>(undefined, {
        type: ["number", "undefined"]
    } as const satisfies __cfHelpers.JSONSchema).for("editingNoteIndex", true);
    const editingNoteText = new Writable("", {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema).for("editingNoteText", true);
    const expandedIndex = new Writable<number | undefined>(undefined, {
        type: ["number", "undefined"]
    } as const satisfies __cfHelpers.JSONSchema).for("expandedIndex", true);
    const settingsModuleIndex = new Writable<number | undefined>(undefined, {
        type: ["number", "undefined"]
    } as const satisfies __cfHelpers.JSONSchema).for("settingsModuleIndex", true);
    const allEntries = __cfLift_1({ items: items }).for("allEntries", true);
    return {
        [UI]: (<div>
        {allEntries.mapWithPattern(__cfPattern_1, {
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
} as const satisfies __cfHelpers.JSONSchema), {
    sourceFile: "/test.tsx",
    position: { line: 46, col: 3 }
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    openNoteEditor,
    openSettings,
    toggleExpanded,
    trashSubPiece,
    __cfLift_1,
    __cfLift_2,
    __cfLift_3,
    __cfLift_4,
    __cfLift_5,
    __cfLift_6,
    __cfPattern_1
});
