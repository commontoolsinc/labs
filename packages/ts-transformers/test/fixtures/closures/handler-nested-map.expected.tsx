import * as __ctHelpers from "commontools";
import { recipe, UI } from "commontools";
interface State {
    items: Array<{
        value: number;
    }>;
    multiplier: number;
}
export default recipe({
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    value: {
                        type: "number"
                    }
                },
                required: ["value"]
            }
        },
        multiplier: {
            type: "number"
        }
    },
    required: ["items", "multiplier"]
} as const satisfies __ctHelpers.JSONSchema, (state) => {
    return {
        [UI]: (<button type="button" onClick={__ctHelpers.handler(false as const satisfies __ctHelpers.JSONSchema, {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        items: {
                            type: "array",
                            items: {
                                type: "object",
                                properties: {
                                    value: {
                                        type: "number"
                                    }
                                },
                                required: ["value"]
                            },
                            asOpaque: true
                        }
                    },
                    required: ["items"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, (__ct_handler_event, { state }) => {
            const scaled = state.items.mapWithPattern(__ctHelpers.recipe({
                $schema: "https://json-schema.org/draft/2020-12/schema",
                type: "object",
                properties: {
                    element: {
                        type: "object",
                        properties: {
                            value: {
                                type: "number"
                            }
                        },
                        required: ["value"]
                    },
                    params: {
                        type: "object",
                        properties: {
                            state: {
                                type: "object",
                                properties: {
                                    multiplier: {
                                        type: "number",
                                        asOpaque: true
                                    }
                                },
                                required: ["multiplier"]
                            }
                        },
                        required: ["state"]
                    }
                },
                required: ["element", "params"]
            } as const satisfies __ctHelpers.JSONSchema, ({ element: item, params: { state } }) => item.value * state.multiplier), {
                state: {
                    multiplier: state.multiplier
                }
            });
            console.log(scaled);
        })({
            state: {
                items: state.items
            }
        })}>
        Compute
      </button>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
