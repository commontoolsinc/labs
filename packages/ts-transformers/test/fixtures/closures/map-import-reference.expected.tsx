import * as __ctHelpers from "commontools";
import { recipe, UI } from "commontools";
// Module-level constant - should NOT be captured
const TAX_RATE = 0.08;
// Module-level function - should NOT be captured
function formatPrice(price: number): string {
    return `$${price.toFixed(2)}`;
}
interface Item {
    id: number;
    price: number;
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
        {/* Should NOT capture module-level constant or function */}
        {state.items.mapWithPattern(__ctHelpers.recipe({
                $schema: "https://json-schema.org/draft/2020-12/schema",
                type: "object",
                properties: {
                    element: {
                        $ref: "#/$defs/Item"
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
                                type: "number"
                            },
                            price: {
                                type: "number"
                            }
                        },
                        required: ["id", "price"]
                    }
                }
            } as const satisfies __ctHelpers.JSONSchema, ({ element: item, params: {} }) => (<div>
            Item: {__ctHelpers.derive({ item: {
                    price: item.price
                } }, ({ item }) => formatPrice(item.price * (1 + TAX_RATE)))}
          </div>)), {})}
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
