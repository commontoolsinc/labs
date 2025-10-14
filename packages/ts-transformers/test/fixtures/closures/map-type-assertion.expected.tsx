/// <cts-enable />
import { h, recipe, UI, OpaqueRef, JSONSchema } from "commontools";
interface Item {
    id: number;
    name: string;
}
interface State {
    items: any; // Type will be asserted
    prefix: string;
}
export default recipe({
    type: "object",
    properties: {
        items: true,
        prefix: {
            type: "string"
        }
    },
    required: ["items", "prefix"]
} as const satisfies JSONSchema, (state) => {
    // Type assertion to OpaqueRef<Item[]>
    const typedItems = state.items as OpaqueRef<Item[]>;
    return {
        [UI]: (<div>
        {/* Map on type-asserted reactive array */}
        {typedItems.mapWithPattern(recipe({
                $schema: "https://json-schema.org/draft/2020-12/schema",
                type: "object",
                properties: {
                    element: {
                        $ref: "#/$defs/Item"
                    },
                    params: {
                        type: "object",
                        properties: {
                            prefix: {
                                type: "string",
                                asOpaque: true
                            }
                        },
                        required: ["prefix"]
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
            } as const satisfies JSONSchema, ({ element, params: { prefix } }) => (<div>
            {prefix}: {element.name}
          </div>)), { prefix: state.prefix })}
      </div>),
    };
});
