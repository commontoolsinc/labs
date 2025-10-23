import * as __ctHelpers from "commontools";
import { cell, recipe, UI } from "commontools";
export default recipe("MapWithArrayParam", (_state) => {
    const items = cell([1, 2, 3, 4, 5]);
    return {
        [UI]: (<div>
        {items.mapWithPattern(__ctHelpers.recipe({
                $schema: "https://json-schema.org/draft/2020-12/schema",
                type: "object",
                properties: {
                    element: {
                        type: "number"
                    },
                    index: {
                        type: "number"
                    },
                    array: true,
                    params: {
                        type: "object",
                        properties: {}
                    }
                },
                required: ["element", "params"]
            } as const satisfies __ctHelpers.JSONSchema, ({ element, index, array, params: {} }) => (<div>
            Item {element} at index {index} of {array.length} total items
          </div>)), {})}
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
