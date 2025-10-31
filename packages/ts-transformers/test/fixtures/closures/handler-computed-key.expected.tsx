import * as __ctHelpers from "commontools";
import { Cell, recipe, UI } from "commontools";
interface State {
    records: Record<string, Cell<number>>;
}
let counter = 0;
function nextKey(): string {
    counter += 1;
    return `key-${counter}`;
}
export default recipe({
    type: "object",
    properties: {
        records: {
            type: "object",
            properties: {},
            additionalProperties: {
                type: "number",
                asCell: true
            }
        }
    },
    required: ["records"]
} as const satisfies __ctHelpers.JSONSchema, (state) => {
    const recordMap = state.records;
    return {
        [UI]: (<button type="button" onClick={__ctHelpers.handler(true as const satisfies __ctHelpers.JSONSchema, true as const satisfies __ctHelpers.JSONSchema, (__ct_handler_event, { recordMap }) => recordMap[nextKey()].set(counter))({
            recordMap: recordMap
        })}>
        Step
      </button>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
