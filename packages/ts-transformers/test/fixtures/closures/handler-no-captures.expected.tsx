import * as __ctHelpers from "commontools";
import { Cell, recipe, UI } from "commontools";
interface State {
    counter: Cell<number>;
}
export default recipe({
    type: "object",
    properties: {
        counter: {
            type: "number",
            asCell: true
        }
    },
    required: ["counter"]
} as const satisfies __ctHelpers.JSONSchema, (_state) => {
    return {
        [UI]: (<button type="button" onClick={__ctHelpers.handler(false as const satisfies __ctHelpers.JSONSchema, {
            type: "object",
            properties: {}
        } as const satisfies __ctHelpers.JSONSchema, (__ct_handler_event, __ct_handler_params) => console.log("hi"))({})}>
        Log
      </button>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
