/// <cts-enable />
import { h, recipe, UI, derive, JSONSchema } from "commontools";
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
} as const satisfies JSONSchema, (state) => {
    return {
        [UI]: (<div>
        {/* Method chain: filter then map, both with captures */}
        {derive(state.items, _v1 => _v1.filter((item) => item.active)).mapWithPattern(recipe({
            type: "object",
            properties: {
                element: {
                    $schema: "https://json-schema.org/draft/2020-12/schema",
                    $ref: "#/$defs/Item",
                    asOpaque: true,
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
            required: ["element", "params"]
        } as const satisfies JSONSchema, ({ element, params: { taxRate } }) => (<div>
              Total: ${element.price * (1 + taxRate)}
            </div>)), { taxRate: state.taxRate })}
      </div>),
    };
});
