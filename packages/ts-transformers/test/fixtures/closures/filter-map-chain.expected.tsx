import * as __ctHelpers from "commontools";
import { recipe, UI } from "commontools";
interface Item {
    id: number;
    price: number;
    active: boolean;
}
interface State {
    items: Item[];
    taxRate: number;
}
export default recipe({
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            }
        },
        taxRate: {
            type: "number"
        }
    },
    required: ["items", "taxRate"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                id: {
                    type: "number"
                },
                price: {
                    type: "number"
                },
                active: {
                    type: "boolean"
                }
            },
            required: ["id", "price", "active"]
        }
    }
} as const satisfies __ctHelpers.JSONSchema, (state) => {
    return {
        [UI]: (<div>
        {/* Method chain: filter then map, both with captures */}
        {__ctHelpers.derive({ state: {
                items: state.items
            } }, ({ state }) => state.items
            .filter((item) => item.active)).mapWithPattern(__ctHelpers.recipe({
            type: "object",
            properties: {
                element: {
                    $ref: "#/$defs/Item",
                    asOpaque: true
                },
                params: {
                    type: "object",
                    properties: {
                        state: {
                            type: "object",
                            properties: {
                                taxRate: {
                                    type: "number",
                                    asOpaque: true
                                }
                            },
                            required: ["taxRate"]
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
                        },
                        active: {
                            type: "boolean"
                        }
                    },
                    required: ["id", "price", "active"]
                }
            }
        } as const satisfies __ctHelpers.JSONSchema, ({ element: item, params: { state } }) => (<div>
              Total: {__ctHelpers.derive({
            item: {
                price: item.price
            },
            state: {
                taxRate: state.taxRate
            }
        }, ({ item, state }) => item.price * (1 + state.taxRate))}
            </div>)), {
            state: {
                taxRate: state.taxRate
            }
        })}
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
