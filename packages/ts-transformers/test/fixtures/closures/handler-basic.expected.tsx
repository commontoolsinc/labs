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
} as const satisfies __ctHelpers.JSONSchema, (state) => {
    return {
        [UI]: (<button type="button" onClick={__ctHelpers.handler(true as const satisfies __ctHelpers.JSONSchema, true as const satisfies __ctHelpers.JSONSchema, (__ct_handler_event, { state }) => state.counter.set(state.counter.get() + 1))({
            state: {
                counter: {
                    set: state.counter.set,
                    get: state.counter.get
                }
            }
        })}>
        Increment
      </button>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
