import * as __ctHelpers from "commontools";
import { pattern } from "commontools";
interface TodoItem {
    title: string;
    done: boolean;
}
export default pattern({
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
} as const satisfies __ctHelpers.JSONSchema, ({ items }) => {
    // Map on opaque ref arrays should be transformed to mapWithPattern
    const mapped = items.mapWithPattern(__ctHelpers.pattern({
        type: "object",
        properties: {
            element: {
                $ref: "#/$defs/TodoItem"
            },
            params: {
                type: "object",
                properties: {}
            }
        },
        required: ["element", "params"],
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
    } as const satisfies __ctHelpers.JSONSchema, ({ element: item, params: {} }) => item.title), {});
    // This should also be transformed
    const filtered = items.mapWithPattern(__ctHelpers.pattern({
        type: "object",
        properties: {
            element: {
                $ref: "#/$defs/TodoItem"
            },
            index: {
                type: "number"
            },
            params: {
                type: "object",
                properties: {}
            }
        },
        required: ["element", "params"],
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
    } as const satisfies __ctHelpers.JSONSchema, ({ element: item, index, params: {} }) => ({
        title: item.title,
        done: item.done,
        position: index,
    })), {});
    return { mapped, filtered };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
