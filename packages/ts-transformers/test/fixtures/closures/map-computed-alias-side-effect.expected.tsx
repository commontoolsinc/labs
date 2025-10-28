import * as __ctHelpers from "commontools";
import { recipe, UI } from "commontools";
let keyCounter = 0;
function nextKey() {
    return `value-${keyCounter++}`;
}
interface State {
    items: Array<Record<string, number>>;
}
export default recipe({
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                type: "object",
                properties: {},
                additionalProperties: {
                    type: "number"
                }
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
                        properties: {},
                        additionalProperties: {
                            type: "number"
                        }
                    },
                    params: {
                        type: "object",
                        properties: {}
                    }
                },
                required: ["element", "params"]
            } as const satisfies __ctHelpers.JSONSchema, ({ element, params: {} }) => {
                const __ct_amount_key = nextKey();
                return (<span>{__ctHelpers.derive({ element, __ct_amount_key }, ({ element: element, __ct_amount_key: __ct_amount_key }) => element[__ct_amount_key])}</span>);
            }), {})}
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
