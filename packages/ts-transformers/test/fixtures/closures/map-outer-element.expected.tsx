import * as __ctHelpers from "commontools";
import { recipe, UI } from "commontools";
interface State {
    items: number[];
    highlight: string;
}
export default recipe({
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                type: "number"
            }
        },
        highlight: {
            type: "string"
        }
    },
    required: ["items", "highlight"]
} as const satisfies __ctHelpers.JSONSchema, (state) => {
    const element = state.highlight;
    return {
        [UI]: (<div>
        {state.items.mapWithPattern(__ctHelpers.recipe({
                $schema: "https://json-schema.org/draft/2020-12/schema",
                type: "object",
                properties: {
                    element: {
                        type: "number"
                    },
                    params: {
                        type: "object",
                        properties: {
                            element: {
                                type: "string",
                                asOpaque: true
                            }
                        },
                        required: ["element"]
                    }
                },
                required: ["element", "params"]
            } as const satisfies __ctHelpers.JSONSchema, ({ element: __ct_element, params: { element } }) => (<span>{element}</span>)), {
                element: element
            })}
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
