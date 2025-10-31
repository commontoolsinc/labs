import * as __ctHelpers from "commontools";
import { recipe, UI } from "commontools";
interface State {
    items: Array<{
        couponCode: string;
    }>;
}
export default recipe({
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    couponCode: {
                        type: "string"
                    }
                },
                required: ["couponCode"]
            }
        }
    },
    required: ["items"]
} as const satisfies __ctHelpers.JSONSchema, (state) => {
    return {
        [UI]: (<div>
        {state.items.mapWithPattern(__ctHelpers.recipe({
                $schema: "https://json-schema.org/draft/2020-12/schema",
                type: "object",
                properties: {
                    element: {
                        type: "object",
                        properties: {
                            couponCode: {
                                type: "string"
                            }
                        },
                        required: ["couponCode"]
                    },
                    params: {
                        type: "object",
                        properties: {}
                    }
                },
                required: ["element", "params"]
            } as const satisfies __ctHelpers.JSONSchema, ({ element: { couponCode: code }, params: {} }) => (<span>{code}</span>)), {})}
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
