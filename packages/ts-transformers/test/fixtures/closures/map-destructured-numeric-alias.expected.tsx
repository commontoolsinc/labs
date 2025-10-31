import * as __ctHelpers from "commontools";
import { recipe, UI } from "commontools";
interface State {
    entries: Array<{
        0: number;
    }>;
}
export default recipe({
    type: "object",
    properties: {
        entries: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    0: {
                        type: "number"
                    }
                },
                required: ["0"]
            }
        }
    },
    required: ["entries"]
} as const satisfies __ctHelpers.JSONSchema, (state) => {
    return {
        [UI]: (<div>
        {state.entries.mapWithPattern(__ctHelpers.recipe({
                $schema: "https://json-schema.org/draft/2020-12/schema",
                type: "object",
                properties: {
                    element: {
                        type: "object",
                        properties: {
                            0: {
                                type: "number"
                            }
                        },
                        required: ["0"]
                    },
                    params: {
                        type: "object",
                        properties: {}
                    }
                },
                required: ["element", "params"]
            } as const satisfies __ctHelpers.JSONSchema, ({ element: { 0: first }, params: {} }) => (<span>{first}</span>)), {})}
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
