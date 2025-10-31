import * as __ctHelpers from "commontools";
import { recipe, UI } from "commontools";
interface State {
    label: string;
}
export default recipe({
    type: "object",
    properties: {
        label: {
            type: "string"
        }
    },
    required: ["label"]
} as const satisfies __ctHelpers.JSONSchema, (state) => {
    const __ct_handler_event = state.label;
    return {
        [UI]: (<button type="button" onClick={__ctHelpers.handler(true as const satisfies __ctHelpers.JSONSchema, true as const satisfies __ctHelpers.JSONSchema, (__ct_handler_event_1, { __ct_handler_event }) => __ct_handler_event)({
            __ct_handler_event: __ct_handler_event
        })}>
        Echo
      </button>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
