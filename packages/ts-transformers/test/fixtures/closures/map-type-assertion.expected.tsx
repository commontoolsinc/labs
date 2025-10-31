import * as __ctHelpers from "commontools";
import { recipe, UI, OpaqueRef } from "commontools";
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
} as const satisfies __ctHelpers.JSONSchema, (state) => {
    // Type assertion to OpaqueRef<Item[]>
    const typedItems = state.items as OpaqueRef<Item[]>;
    return {
        [UI]: (<div>
        {/* Map on type-asserted reactive array */}
        {typedItems.mapWithPattern(__ctHelpers.recipe({
                $schema: "https://json-schema.org/draft/2020-12/schema",
                type: "object",
                properties: {
                    element: {
                        $ref: "#/$defs/Item"
                    },
                    params: {
                        type: "object",
                        properties: {
                            state: {
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
            } as const satisfies __ctHelpers.JSONSchema, ({ element: item, params: { state } }) => (<div>
            {state.prefix}: {item.name}
          </div>)), {
                state: {
                    prefix: state.prefix
                }
            })}
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
