/// <cts-enable />
import { h, recipe, UI, JSONSchema } from "commontools";
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
} as const satisfies JSONSchema, (state) => {
    return {
        [UI]: (<div>
        {/* Uses both index parameter and captures state.offset */}
        {state.items.mapWithPattern(recipe({
                type: "object",
                properties: {
                    element: {
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
                    },
                    index: {
                        type: "number"
                    },
                    params: {
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
                required: ["element", "params"]
            } as const satisfies JSONSchema, ({ element, index, params: { offset } }) => (<div>
            Item #{index + offset}: {element.name}
          </div>)), { offset: state.offset })}
      </div>),
    };
});
