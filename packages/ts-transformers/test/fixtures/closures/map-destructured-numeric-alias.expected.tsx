import * as __ctHelpers from "commontools";
import { recipe, UI } from "commontools";
interface State {
    entries: Array<{
        zero: number;
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
                    zero: {
                        type: "number"
                    }
                },
                required: ["zero"]
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
                            zero: {
                                type: "number"
                            }
                        },
                        required: ["zero"]
                    },
                    params: {
                        type: "object",
                        properties: {}
                    }
                },
                required: ["element", "params"]
            } as const satisfies __ctHelpers.JSONSchema, ({ element, params: {} }) => (<span>{element.zero}</span>)), {})}
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
