import * as __ctHelpers from "commontools";
import { recipe, UI } from "commontools";
interface Item {
    maybe?: {
        value: number;
    };
}
interface State {
    maybe?: {
        value: number;
    };
    items: Item[];
}
export default recipe({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
        maybe: {
            type: "object",
            properties: {
                value: {
                    type: "number"
                }
            },
            required: ["value"]
        },
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
                maybe: {
                    type: "object",
                    properties: {
                        value: {
                            type: "number"
                        }
                    },
                    required: ["value"]
                }
            }
        }
    }
} as const satisfies __ctHelpers.JSONSchema, (state) => {
    return {
        [UI]: (<div>
        <span>{state.maybe?.value}</span>
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
                            maybe: {
                                type: "object",
                                properties: {
                                    value: {
                                        type: "number"
                                    }
                                },
                                required: ["value"]
                            }
                        }
                    }
                }
            } as const satisfies __ctHelpers.JSONSchema, ({ element: item, params: {} }) => (<span>{__ctHelpers.derive({ item: {
                    maybe: {
                        value: item.maybe?.value
                    }
                } }, ({ item }) => item.maybe?.value ?? 0)}</span>)), {})}
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
