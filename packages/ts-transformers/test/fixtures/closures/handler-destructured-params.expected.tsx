import * as __ctHelpers from "commontools";
import { Cell, recipe, UI } from "commontools";
declare global {
    interface EventTarget {
        setAttribute(name: string, value: string): void;
    }
}
interface State {
    nested: Cell<string>;
}
export default recipe({
    type: "object",
    properties: {
        nested: {
            type: "string",
            asCell: true
        }
    },
    required: ["nested"]
} as const satisfies __ctHelpers.JSONSchema, (state) => {
    return {
        [UI]: (<button type="button" onClick={__ctHelpers.handler(true as const satisfies __ctHelpers.JSONSchema, true as const satisfies __ctHelpers.JSONSchema, ({ currentTarget }, { state: { nested } }) => {
            currentTarget.setAttribute("data-nested", nested.get());
            console.log(state.nested === nested);
        })({
            state: {
                nested: state.nested
            }
        })}>
        Destructure
      </button>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
