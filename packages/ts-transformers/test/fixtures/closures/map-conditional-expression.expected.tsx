import * as __ctHelpers from "commontools";
import { h, recipe, UI } from "commontools";
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
            } as const satisfies __ctHelpers.JSONSchema, ({ element, params: { threshold, discount } }) => (<div>
            Price: ${element.price > threshold
                    ? element.price * (1 - discount)
                    : element.price}
          </div>)), { threshold: state.threshold, discount: state.discount })}
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
