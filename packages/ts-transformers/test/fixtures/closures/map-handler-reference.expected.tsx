/// <cts-enable />
import { h, recipe, UI, handler, Cell, JSONSchema } from "commontools";
declare global {
    namespace JSX {
        interface IntrinsicElements {
            "ct-button": any;
        }
    }
}
// Event handler defined at module scope
const handleClick = handler(true as const satisfies JSONSchema, {
    type: "object",
    properties: {
        count: {
            type: "number",
            asCell: true
        }
    },
    required: ["count"]
} as const satisfies JSONSchema, (_, { count }) => {
    count.set(count.get() + 1);
});
interface Item {
    id: number;
    name: string;
}
interface State {
    items: Item[];
    count: Cell<number>;
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
        count: {
            type: "number",
            asCell: true
        }
    },
    required: ["items", "count"],
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
} as const satisfies JSONSchema, (state) => {
    return {
        [UI]: (<div>
        {/* Map callback references handler - should NOT capture it */}
        {state.items.mapWithPattern(recipe({
                $schema: "https://json-schema.org/draft/2020-12/schema",
                type: "object",
                properties: {
                    element: {
                        $ref: "#/$defs/Item"
                    },
                    params: {
                        type: "object",
                        properties: {
                            count: {
                                type: "number",
                                asCell: true,
                                asOpaque: true
                            }
                        },
                        required: ["count"]
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
            } as const satisfies JSONSchema, ({ element, params: { count } }) => (<ct-button onClick={handleClick({ count: count })}>
            {element.name}
          </ct-button>)), { count: state.count })}
      </div>),
    };
});
