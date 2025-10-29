import * as __ctHelpers from "commontools";
import { Cell, Default, handler, recipe, UI } from "commontools";
interface Item {
    text: Default<string, "">;
}
interface InputSchema {
    items: Default<Item[], [
    ]>;
}
const removeItem = handler(true as const satisfies __ctHelpers.JSONSchema, {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            },
            asCell: true
        },
        index: {
            type: "number"
        }
    },
    required: ["items", "index"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                text: {
                    type: "string",
                    default: ""
                }
            },
            required: ["text"]
        }
    }
} as const satisfies __ctHelpers.JSONSchema, (_, _2) => {
    // Not relevant for repro
});
export default recipe({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            },
            default: []
        }
    },
    required: ["items"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                text: {
                    type: "string",
                    default: ""
                }
            },
            required: ["text"]
        }
    }
} as const satisfies __ctHelpers.JSONSchema, ({ items }) => {
    return {
        [UI]: (<ul>
          {items.mapWithPattern(__ctHelpers.recipe({
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
                            items: {
                                type: "array",
                                items: {
                                    $ref: "#/$defs/Item"
                                },
                                asOpaque: true
                            }
                        },
                        required: ["items"]
                    }
                },
                required: ["element", "params"],
                $defs: {
                    Item: {
                        type: "object",
                        properties: {
                            text: {
                                type: "string",
                                default: ""
                            }
                        },
                        required: ["text"]
                    }
                }
            } as const satisfies __ctHelpers.JSONSchema, ({ element: _, index: index, params: { items } }) => (<li key={index}>
              <ct-button onClick={removeItem({ items, index })}>
                Remove
              </ct-button>
            </li>)), {
                items: items
            })}
        </ul>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
