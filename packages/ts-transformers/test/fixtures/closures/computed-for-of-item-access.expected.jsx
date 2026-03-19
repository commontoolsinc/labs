import * as __ctHelpers from "commontools";
import { computed, NAME, pattern, UI } from "commontools";
interface NotebookPiece {
    [NAME]?: string;
    title?: string;
    notes?: NotePiece[];
    isNotebook?: boolean;
}
interface NotePiece {
    [NAME]?: string;
    title?: string;
    content?: string;
}
// FIXTURE: computed-for-of-item-access
// Verifies: computed() with for...of loop over an array captures item-level
//   property access, NOT wildcard.  The capability analysis correctly tracks
//   paths like ["notebooks", "notes", "title"] through nested for-of loops.
// Context: for-of iteration aliases the loop variable to the iterable.
//   Nested for-of with ?? fallback (nb?.notes ?? []) is also resolved.
export default pattern((__ct_pattern_input) => {
    const notebooks = __ct_pattern_input.key("notebooks");
    const query = __ct_pattern_input.key("query");
    // Computed that iterates notebooks and only accesses .notes on each
    const matchingNotes = __ctHelpers.derive({
        type: "object",
        properties: {
            notebooks: {
                type: "array",
                items: {
                    $ref: "#/$defs/NotebookPiece"
                }
            },
            query: {
                type: "string"
            }
        },
        required: ["notebooks", "query"],
        $defs: {
            NotebookPiece: {
                type: "object",
                properties: {
                    title: {
                        type: "string"
                    },
                    notes: {
                        type: "array",
                        items: {
                            $ref: "#/$defs/NotePiece"
                        }
                    },
                    isNotebook: {
                        type: "boolean"
                    },
                    $NAME: {
                        type: "string"
                    }
                }
            },
            NotePiece: {
                type: "object",
                properties: {
                    title: {
                        type: "string"
                    },
                    content: {
                        type: "string"
                    },
                    $NAME: {
                        type: "string"
                    }
                }
            }
        }
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "array",
        items: {
            $ref: "#/$defs/NotePiece"
        },
        $defs: {
            NotePiece: {
                type: "object",
                properties: {
                    title: {
                        type: "string"
                    },
                    content: {
                        type: "string"
                    },
                    $NAME: {
                        type: "string"
                    }
                }
            }
        }
    } as const satisfies __ctHelpers.JSONSchema, {
        notebooks: notebooks,
        query: query
    }, ({ notebooks, query }) => {
        const result: NotePiece[] = [];
        for (const nb of notebooks) {
            for (const note of nb?.notes ?? []) {
                if (note?.title?.includes(query)) {
                    result.push(note);
                }
            }
        }
        return result;
    });
    return {
        [NAME]: "Search",
        [UI]: <div>{__ctHelpers.derive({
            type: "object",
            properties: {
                matchingNotes: {
                    type: "object",
                    properties: {
                        length: {
                            type: "number"
                        }
                    },
                    required: ["length"]
                }
            },
            required: ["matchingNotes"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __ctHelpers.JSONSchema, { matchingNotes: {
                length: matchingNotes.key("length")
            } }, ({ matchingNotes }) => matchingNotes.length)}</div>,
    };
}, {
    type: "object",
    properties: {
        notebooks: {
            type: "array",
            items: {
                $ref: "#/$defs/NotebookPiece"
            }
        },
        query: {
            type: "string"
        }
    },
    required: ["notebooks", "query"],
    $defs: {
        NotebookPiece: {
            type: "object",
            properties: {
                title: {
                    type: "string"
                },
                notes: {
                    type: "array",
                    items: {
                        $ref: "#/$defs/NotePiece"
                    }
                },
                isNotebook: {
                    type: "boolean"
                },
                $NAME: {
                    type: "string"
                }
            }
        },
        NotePiece: {
            type: "object",
            properties: {
                title: {
                    type: "string"
                },
                content: {
                    type: "string"
                },
                $NAME: {
                    type: "string"
                }
            }
        }
    }
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        $NAME: {
            type: "string"
        },
        $UI: {
            $ref: "#/$defs/JSXElement"
        }
    },
    required: ["$NAME", "$UI"],
    $defs: {
        JSXElement: {
            anyOf: [{
                    $ref: "https://commonfabric.org/schemas/vnode.json"
                }, {
                    type: "object",
                    properties: {}
                }, {
                    $ref: "#/$defs/UIRenderable"
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
