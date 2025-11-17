import * as __ctHelpers from "commontools";
import { cell, recipe, UI } from "commontools";
export default recipe("MapWithArrayParam", false as const satisfies __ctHelpers.JSONSchema, (_state) => {
    const items = cell([1, 2, 3, 4, 5]);
    return {
        [UI]: (<div>
        {items.mapWithPattern(__ctHelpers.recipe({
                type: "object",
                properties: {
                    element: {
                        type: "number"
                    },
                    index: {
                        type: "number"
                    },
                    array: {
                        type: "array",
                        items: {
                            type: "number"
                        }
                    },
                    params: {
                        type: "object",
                        properties: {}
                    }
                },
                required: ["element", "params"]
            } as const satisfies __ctHelpers.JSONSchema, ({ element: item, index: index, array: array, params: {} }) => (<div>
            Item {item} at index {index} of {array.length} total items
          </div>)), {})}
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
