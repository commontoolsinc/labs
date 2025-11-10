import * as __ctHelpers from "commontools";
import { Cell, handler, ifElse, recipe, UI } from "commontools";
interface Item {
    id: string;
}
interface State {
    items: Cell<Array<Cell<Item>>>;
}
const removeItem = handler(true as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    id: {
                        type: "string"
                    }
                },
                required: ["id"],
                asCell: true
            },
            asCell: true
        },
        item: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                }
            },
            required: ["id"],
            asCell: true
        }
    },
    required: ["items", "item"]
} as const satisfies __ctHelpers.JSONSchema, (_event, { items, item }) => {
    const currentItems = items.get();
    const index = currentItems.findIndex((el) => item.equals(el));
    if (index >= 0) {
        items.set(currentItems.toSpliced(index, 1));
    }
});
export default recipe({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Item",
                asCell: true
            },
            asCell: true
        }
    },
    required: ["items"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                }
            },
            required: ["id"]
        }
    }
} as const satisfies __ctHelpers.JSONSchema, (state) => {
    const hasItems = state.items.mapWithPattern(__ctHelpers.recipe({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
            element: {
                type: "array",
                items: {
                    $ref: "#/$defs/Item",
                    asCell: true
                },
                asCell: true
            }
        },
        required: ["element"],
        $defs: {
            Item: {
                type: "object",
                properties: {
                    id: {
                        type: "string"
                    }
                },
                required: ["id"]
            }
        }
    } as const satisfies __ctHelpers.JSONSchema, ({ element: items }) => items.length > 0), {});
    return {
        [UI]: ifElse(hasItems, <div>
        {state.items.mapWithPattern(__ctHelpers.recipe({
                $schema: "https://json-schema.org/draft/2020-12/schema",
                type: "object",
                properties: {
                    element: {
                        $ref: "#/$defs/Item",
                        asCell: true
                    },
                    params: {
                        type: "object",
                        properties: {
                            state: {
                                type: "object",
                                properties: {
                                    items: {
                                        type: "array",
                                        items: {
                                            $ref: "#/$defs/Item",
                                            asCell: true
                                        },
                                        asCell: true
                                    }
                                },
                                required: ["items"]
                            }
                        },
                        required: ["state"]
                    }
                },
                required: ["element", "params"],
                $defs: {
                    Item: {
                        type: "object",
                        properties: {
                            id: {
                                type: "string"
                            }
                        },
                        required: ["id"]
                    }
                }
            } as const satisfies __ctHelpers.JSONSchema, ({ element: item, params: { state } }) => (<button onClick={removeItem({ items: state.items, item })}>
            Remove
          </button>)), {
                state: {
                    items: state.items
                }
            })}
      </div>, <div>No items</div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
