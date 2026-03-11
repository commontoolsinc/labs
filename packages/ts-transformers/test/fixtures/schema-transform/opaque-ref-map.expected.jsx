import * as __ctHelpers from "commontools";
import { pattern } from "commontools";
interface TodoItem {
    title: string;
    done: boolean;
}
// FIXTURE: opaque-ref-map
// Verifies: .map() on typed arrays is transformed to .mapWithPattern() with generated schemas
//   items.map((item) => item.title) → items.mapWithPattern(pattern(...), {})
//   items.map((item, index) => ({...})) → items.mapWithPattern(pattern(...), {}) with index param
// Context: two .map() calls -- one returning a scalar, one returning an object with index
export default pattern((__ct_pattern_input) => {
    const items = __ct_pattern_input.key("items");
    // Map on opaque ref arrays should be transformed to mapWithPattern
    const mapped = items.mapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
        const item = __ct_pattern_input.key("element");
        return item.key("title");
    }, {
        type: "object",
        properties: {
            element: {
                $ref: "#/$defs/TodoItem"
            }
        },
        required: ["element"],
        $defs: {
            TodoItem: {
                type: "object",
                properties: {
                    title: {
                        type: "string"
                    },
                    done: {
                        type: "boolean"
                    }
                },
                required: ["title", "done"]
            }
        }
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "string",
        asOpaque: true
    } as const satisfies __ctHelpers.JSONSchema), {});
    // This should also be transformed
    const filtered = items.mapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
        const item = __ct_pattern_input.key("element");
        const index = __ct_pattern_input.key("index");
        return ({
            title: item.key("title"),
            done: item.key("done"),
            position: index,
        });
    }, {
        type: "object",
        properties: {
            element: {
                $ref: "#/$defs/TodoItem"
            },
            index: {
                type: "number"
            }
        },
        required: ["element"],
        $defs: {
            TodoItem: {
                type: "object",
                properties: {
                    title: {
                        type: "string"
                    },
                    done: {
                        type: "boolean"
                    }
                },
                required: ["title", "done"]
            }
        }
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "object",
        properties: {
            title: {
                type: "string",
                asOpaque: true
            },
            done: {
                type: "boolean",
                asOpaque: true
            },
            position: {
                type: "number",
                asOpaque: true
            }
        },
        required: ["title", "done", "position"]
    } as const satisfies __ctHelpers.JSONSchema), {});
    return { mapped, filtered };
}, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/TodoItem"
            }
        }
    },
    required: ["items"],
    $defs: {
        TodoItem: {
            type: "object",
            properties: {
                title: {
                    type: "string"
                },
                done: {
                    type: "boolean"
                }
            },
            required: ["title", "done"]
        }
    }
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        mapped: {
            type: "array",
            items: {
                type: "string"
            },
            asOpaque: true
        },
        filtered: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    title: {
                        type: "string",
                        asOpaque: true
                    },
                    done: {
                        type: "boolean",
                        asOpaque: true
                    },
                    position: {
                        type: "number",
                        asOpaque: true
                    }
                },
                required: ["title", "done", "position"]
            },
            asOpaque: true
        }
    },
    required: ["mapped", "filtered"]
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
