/// <cts-enable />
import { h, recipe, UI, JSONSchema } from "commontools";
interface Item {
    price: number;
    quantity: number;
}
interface State {
    items: Item[];
    taxRate: number;
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
        taxRate: {
            type: "number"
        }
    },
    required: ["items", "taxRate"],
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
} as const satisfies JSONSchema, (state) => {
    return {
        [UI]: (<div>
        {state.items.mapWithPattern(recipe({
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
                        properties: {
                            taxRate: {
                                type: "number",
                                asOpaque: true
                            }
                        },
                        required: ["taxRate"]
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
            } as const satisfies JSONSchema, ({ element, index, params: { taxRate } }) => {
                // Local variable declared inside callback
                const subtotal = element.price * element.quantity;
                const localTax = subtotal * 0.1;
                // Should only capture state.taxRate, not subtotal or localTax
                return (<div key={index}>
              Subtotal: {subtotal}, Tax: {localTax + taxRate}
            </div>);
            }), { taxRate: state.taxRate })}
      </div>),
    };
});
