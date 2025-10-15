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
} as const satisfies __ctHelpers.JSONSchema, (state) => {
    return {
        [UI]: (<div>
        {/* Method chain: filter then map, both with captures */}
        {__ctHelpers.derive(state.items, _v1 => _v1.filter((item) => item.active)).mapWithPattern(__ctHelpers.recipe({
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
                element: {
                    $ref: "#/$defs/Item",
                    asOpaque: true
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
        } as const satisfies __ctHelpers.JSONSchema, ({ element, params: { taxRate } }) => (<div>
              Total: ${element.price * (1 + taxRate)}
            </div>)), { taxRate: state.taxRate })}
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
