import * as __ctHelpers from "commontools";
import { derive, recipe, UI } from "commontools";
interface Item {
    id: string;
    category: string;
    done: boolean;
}
interface State {
    items: Item[];
}
export default recipe({
    $schema: "https://json-schema.org/draft/2020-12/schema",
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
                id: {
                    type: "string"
                },
                category: {
                    type: "string"
                },
                done: {
                    type: "boolean"
                }
            },
            required: ["id", "category", "done"]
        }
    }
} as const satisfies __ctHelpers.JSONSchema, (state) => {
    // Group items by category
    const groupedByCategory = derive({
        type: "array",
        items: true
    } as const satisfies __ctHelpers.JSONSchema, {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {},
        additionalProperties: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            }
        },
        $defs: {
            Item: {
                type: "object",
                properties: {
                    id: {
                        type: "string"
                    },
                    category: {
                        type: "string"
                    },
                    done: {
                        type: "boolean"
                    }
                },
                required: ["id", "category", "done"]
            }
        }
    } as const satisfies __ctHelpers.JSONSchema, state.items, (items) => {
        const groups: Record<string, Item[]> = {};
        for (const item of items) {
            if (!groups[item.category])
                groups[item.category] = [];
            groups[item.category].push(item);
        }
        return groups;
    });
    // Get sorted category names
    const categoryNames = derive({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {},
        additionalProperties: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            }
        },
        $defs: {
            Item: {
                type: "object",
                properties: {
                    id: {
                        type: "string"
                    },
                    category: {
                        type: "string"
                    },
                    done: {
                        type: "boolean"
                    }
                },
                required: ["id", "category", "done"]
            }
        }
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "array",
        items: true
    } as const satisfies __ctHelpers.JSONSchema, groupedByCategory, (groups) => Object.keys(groups).sort());
    return {
        [UI]: (<div>
        {categoryNames.mapWithPattern(__ctHelpers.recipe({
                $schema: "https://json-schema.org/draft/2020-12/schema",
                type: "object",
                properties: {
                    element: {
                        type: "string"
                    },
                    index: {
                        type: "number"
                    },
                    params: {
                        type: "object",
                        properties: {}
                    }
                },
                required: ["element", "params"]
            } as const satisfies __ctHelpers.JSONSchema, ({ element: categoryName, index: idx, params: {} }) => (<div key={idx}>
            <h3>{categoryName}</h3>
            {/* Access grouped object with derived key - this should work with frame ancestry checking */}
            {(__ctHelpers.derive({
                groupedByCategory: groupedByCategory,
                categoryName: categoryName
            }, ({ groupedByCategory, categoryName }) => groupedByCategory[categoryName] ?? [])).mapWithPattern(__ctHelpers.recipe({
                $schema: "https://json-schema.org/draft/2020-12/schema",
                type: "object",
                properties: {
                    element: {
                        $ref: "#/$defs/Item"
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
                    Item: {
                        type: "object",
                        properties: {
                            id: {
                                type: "string"
                            },
                            category: {
                                type: "string"
                            },
                            done: {
                                type: "boolean"
                            }
                        },
                        required: ["id", "category", "done"]
                    }
                }
            } as const satisfies __ctHelpers.JSONSchema, ({ element: item, index: itemIdx, params: {} }) => (<div key={itemIdx}>
                {__ctHelpers.ifElse(item.done, "✓", "○")} {item.id}
              </div>)), {})}
          </div>)), {})}
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
