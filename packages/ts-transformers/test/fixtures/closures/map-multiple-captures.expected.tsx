import * as __ctHelpers from "commontools";
import { recipe, UI } from "commontools";
interface Item {
    price: number;
    quantity: number;
}
interface State {
    items: Item[];
    discount: number;
    taxRate: number;
}
const shippingCost = 5.99;
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
        taxRate: {
            type: "number"
        }
    },
    required: ["items", "discount", "taxRate"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                price: {
                    type: "number"
                },
                quantity: {
                    type: "number"
                }
            },
            required: ["price", "quantity"]
        }
    }
} as const satisfies __ctHelpers.JSONSchema, (state) => {
    const multiplier = 2;
    return {
        [UI]: (<div>
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
                            discount: {
                                type: "number",
                                asOpaque: true
                            },
                            taxRate: {
                                type: "number",
                                asOpaque: true
                            },
                            multiplier: {
                                type: "number",
                                enum: [2]
                            }
                        },
                        required: ["discount", "taxRate", "multiplier"]
                    }
                },
                required: ["element", "params"],
                $defs: {
                    Item: {
                        type: "object",
                        properties: {
                            price: {
                                type: "number"
                            },
                            quantity: {
                                type: "number"
                            }
                        },
                        required: ["price", "quantity"]
                    }
                }
            } as const satisfies __ctHelpers.JSONSchema, ({ element, params: { discount, taxRate, multiplier } }) => (<span>
            Total: {__ctHelpers.derive({ element_price: element.price, element_quantity: element.quantity, discount, taxRate, multiplier }, ({ element_price: _v1, element_quantity: _v2, discount: discount, taxRate: taxRate, multiplier: multiplier }) => _v1 * _v2 * discount * taxRate * multiplier + shippingCost)}
          </span>)), { discount: state.discount, taxRate: state.taxRate, multiplier: multiplier })}
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
