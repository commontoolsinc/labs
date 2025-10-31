import * as __ctHelpers from "commontools";
import { recipe, UI } from "commontools";
interface Item {
    id: number;
    name: string;
}
interface State {
    items: Item[];
    offset: number;
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
        offset: {
            type: "number"
        }
    },
    required: ["items", "offset"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                id: {
                    type: "number"
                },
                name: {
                    type: "string"
                }
            },
            required: ["id", "name"]
        }
    }
} as const satisfies __ctHelpers.JSONSchema, (state) => {
    return {
        [UI]: (<div>
        {/* Uses both index parameter and captures state.offset */}
        {state.items.mapWithPattern(__ctHelpers.recipe({
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
                            state: {
                                type: "object",
                                properties: {
                                    offset: {
                                        type: "number",
                                        asOpaque: true
                                    }
                                },
                                required: ["offset"]
                            }
                        },
                        required: ["state"]
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
                            name: {
                                type: "string"
                            }
                        },
                        required: ["id", "name"]
                    }
                }
            } as const satisfies __ctHelpers.JSONSchema, ({ element: item, index: index, params: { state } }) => (<div>
            Item #{__ctHelpers.derive({
                index: index,
                state: {
                    offset: state.offset
                }
            }, ({ index, state }) => index + state.offset)}: {item.name}
          </div>)), {
                state: {
                    offset: state.offset
                }
            })}
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
