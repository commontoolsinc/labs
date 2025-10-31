import * as __ctHelpers from "commontools";
import { recipe, UI } from "commontools";
interface Item {
    id: number;
    price: number;
}
interface State {
    items: Item[];
    discount: number;
    threshold: number;
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
        },
        discount: {
            type: "number"
        },
        threshold: {
            type: "number"
        }
    },
    required: ["items", "discount", "threshold"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                id: {
                    type: "number"
                },
                price: {
                    type: "number"
                }
            },
            required: ["id", "price"]
        }
    }
} as const satisfies __ctHelpers.JSONSchema, (state) => {
    return {
        [UI]: (<div>
        {/* Ternary with captures in map callback */}
        {state.items.mapWithPattern(__ctHelpers.recipe({
                $schema: "https://json-schema.org/draft/2020-12/schema",
                type: "object",
                properties: {
                    element: {
                        $ref: "#/$defs/Item"
                    },
                    params: {
                        type: "object",
                        properties: {
                            state: {
                                type: "object",
                                properties: {
                                    threshold: {
                                        type: "number",
                                        asOpaque: true
                                    },
                                    discount: {
                                        type: "number",
                                        asOpaque: true
                                    }
                                },
                                required: ["threshold", "discount"]
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
                                type: "number"
                            },
                            price: {
                                type: "number"
                            }
                        },
                        required: ["id", "price"]
                    }
                }
            } as const satisfies __ctHelpers.JSONSchema, ({ element: item, params: { state } }) => (<div>
            Price: ${__ctHelpers.ifElse(__ctHelpers.derive({
                item: {
                    price: item.price
                },
                state: {
                    threshold: state.threshold
                }
            }, ({ item, state }) => item.price > state.threshold), __ctHelpers.derive({
                item: {
                    price: item.price
                },
                state: {
                    discount: state.discount
                }
            }, ({ item, state }) => item.price * (1 - state.discount)), item.price)}
          </div>)), {
                state: {
                    threshold: state.threshold,
                    discount: state.discount
                }
            })}
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
