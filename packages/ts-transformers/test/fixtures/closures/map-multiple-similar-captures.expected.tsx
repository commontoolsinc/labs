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
                            state: {
                                type: "object",
                                properties: {
                                    checkout: {
                                        type: "object",
                                        properties: {
                                            discount: {
                                                type: "number",
                                                asOpaque: true
                                            }
                                        },
                                        required: ["discount"]
                                    },
                                    upsell: {
                                        type: "object",
                                        properties: {
                                            discount: {
                                                type: "number",
                                                asOpaque: true
                                            }
                                        },
                                        required: ["discount"]
                                    }
                                },
                                required: ["checkout", "upsell"]
                            }
                        },
                        required: ["state"]
                    }
                },
                required: ["element", "params"]
            } as const satisfies __ctHelpers.JSONSchema, ({ element: item, params: { state } }) => (<span>
            {__ctHelpers.derive({
                item: {
                    price: item.price
                },
                state: {
                    checkout: {
                        discount: state.checkout.discount
                    },
                    upsell: {
                        discount: state.upsell.discount
                    }
                }
            }, ({ item, state }) => item.price * state.checkout.discount * state.upsell.discount)}
          </span>)), {
                state: {
                    checkout: {
                        discount: state.checkout.discount
                    },
                    upsell: {
                        discount: state.upsell.discount
                    }
                }
            })}
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
