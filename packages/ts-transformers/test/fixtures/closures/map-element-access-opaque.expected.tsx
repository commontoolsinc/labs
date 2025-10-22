import * as __ctHelpers from "commontools";
import { recipe, UI } from "commontools";
interface State {
    sortedTags: string[];
    tagCounts: Record<string, number>;
}
export default recipe({
    type: "object",
    properties: {
        sortedTags: {
            type: "array",
            items: {
                type: "string"
            }
        },
        tagCounts: {
            type: "object",
            properties: {},
            additionalProperties: {
                type: "number"
            }
        }
    },
    required: ["sortedTags", "tagCounts"]
} as const satisfies __ctHelpers.JSONSchema, (state) => {
    return {
        [UI]: (<div>
        {state.sortedTags.mapWithPattern(__ctHelpers.recipe({
                $schema: "https://json-schema.org/draft/2020-12/schema",
                type: "object",
                properties: {
                    element: {
                        type: "string"
                    },
                    params: {
                        type: "object",
                        properties: {
                            tagCounts: {
                                type: "object",
                                properties: {},
                                additionalProperties: {
                                    type: "number"
                                },
                                asOpaque: true
                            }
                        },
                        required: ["tagCounts"]
                    }
                },
                required: ["element", "params"]
            } as const satisfies __ctHelpers.JSONSchema, ({ element, params: { tagCounts } }) => (<span>
            {element}: {__ctHelpers.derive({ tagCounts, element }, ({ tagCounts: _v1, element: _v2 }) => _v1[_v2])}
          </span>)), { tagCounts: state.tagCounts })}
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
