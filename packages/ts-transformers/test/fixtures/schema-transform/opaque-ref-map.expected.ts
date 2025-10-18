import * as __ctHelpers from "commontools";
import { recipe } from "commontools";
interface TodoItem {
    title: string;
    done: boolean;
}
export default recipe({
    $schema: "https://json-schema.org/draft/2020-12/schema",
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
} as const satisfies __ctHelpers.JSONSchema, ({ items }) => {
    // Map on opaque ref arrays should be transformed to mapWithPattern
    const mapped = items.mapWithPattern(__ctHelpers.recipe({
        $schema: "https://json-schema.org/draft/2020-12/schema",
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
    } as const satisfies __ctHelpers.JSONSchema, ({ element, params: {} }) => element.title), {});
    // This should also be transformed
    const filtered = items.mapWithPattern(__ctHelpers.recipe({
        $schema: "https://json-schema.org/draft/2020-12/schema",
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
    } as const satisfies __ctHelpers.JSONSchema, ({ element, index, params: {} }) => ({
        title: element.title,
        done: element.done,
        position: index,
    })), {});
    return { mapped, filtered };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
