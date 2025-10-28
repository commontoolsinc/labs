import * as __ctHelpers from "commontools";
import { recipe, UI } from "commontools";
interface State {
    items: Array<{
        price: number;
    }>;
    checkout: {
        discount: number;
    };
    upsell: {
        discount: number;
    };
}
export default recipe({
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    price: {
                        type: "number"
                    }
                },
                required: ["price"]
            }
        },
        checkout: {
            type: "object",
            properties: {
                discount: {
                    type: "number"
                }
            },
            required: ["discount"]
        },
        upsell: {
            type: "object",
            properties: {
                discount: {
                    type: "number"
                }
            },
            required: ["discount"]
        }
    },
    required: ["items", "checkout", "upsell"]
} as const satisfies __ctHelpers.JSONSchema, (state) => {
    return {
        [UI]: (<div>
        {state.items.mapWithPattern(__ctHelpers.recipe({
                $schema: "https://json-schema.org/draft/2020-12/schema",
                type: "object",
                properties: {
                    element: {
                        type: "object",
                        properties: {
                            price: {
                                type: "number"
                            }
                        },
                        required: ["price"]
                    },
                    params: {
                        type: "object",
                        properties: {
                            discount: {
                                type: "number",
                                asOpaque: true
                            },
                            discount_2: {
                                type: "number",
                                asOpaque: true
                            }
                        },
                        required: ["discount", "discount_2"]
                    }
                },
                required: ["element", "params"]
            } as const satisfies __ctHelpers.JSONSchema, ({ element, params: { discount, discount_2 } }) => (<span>
            {__ctHelpers.derive({ element_price: element.price, discount, discount_2 }, ({ element_price: _v1, discount: discount, discount_2: discount_2 }) => _v1 * discount * discount_2)}
          </span>)), { discount: state.checkout.discount, discount_2: state.upsell.discount })}
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
