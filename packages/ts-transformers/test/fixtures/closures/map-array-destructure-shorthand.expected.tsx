import * as __ctHelpers from "commontools";
import { recipe, UI } from "commontools";
type ItemTuple = [
    item: string,
    count: number
];
interface State {
    items: ItemTuple[];
}
export default recipe({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/ItemTuple"
            }
        }
    },
    required: ["items"],
    $defs: {
        ItemTuple: {
            type: "array",
            items: {
                anyOf: [{
                        type: "string"
                    }, {
                        type: "number"
                    }]
            }
        }
    }
} as const satisfies __ctHelpers.JSONSchema, ({ items }) => {
    return {
        [UI]: (<div>
        {/* Array destructured parameter - without fix, 'item' would be
                incorrectly captured in params due to shorthand usage in JSX */}
        {items.mapWithPattern(__ctHelpers.recipe({
                $schema: "https://json-schema.org/draft/2020-12/schema",
                type: "object",
                properties: {
                    element: {
                        $ref: "#/$defs/ItemTuple"
                    },
                    params: {
                        type: "object",
                        properties: {}
                    }
                },
                required: ["element", "params"],
                $defs: {
                    ItemTuple: {
                        type: "array",
                        items: {
                            anyOf: [{
                                    type: "string"
                                }, {
                                    type: "number"
                                }]
                        }
                    }
                }
            } as const satisfies __ctHelpers.JSONSchema, ({ element, params: {} }) => (<div data-item={element[0]}>{element[0]}</div>)), {})}

        {/* Multiple array destructured params */}
        {items.mapWithPattern(__ctHelpers.recipe({
                $schema: "https://json-schema.org/draft/2020-12/schema",
                type: "object",
                properties: {
                    element: {
                        $ref: "#/$defs/ItemTuple"
                    },
                    params: {
                        type: "object",
                        properties: {}
                    }
                },
                required: ["element", "params"],
                $defs: {
                    ItemTuple: {
                        type: "array",
                        items: {
                            anyOf: [{
                                    type: "string"
                                }, {
                                    type: "number"
                                }]
                        }
                    }
                }
            } as const satisfies __ctHelpers.JSONSchema, ({ element, params: {} }) => (<div key={element[0]}>
            {element[0]}: {element[1]}
          </div>)), {})}
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
