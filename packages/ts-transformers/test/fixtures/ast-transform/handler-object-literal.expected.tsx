import * as __ctHelpers from "commontools";
import { Cell, handler, recipe } from "commontools";
import "commontools/schema";
interface State {
    value: Cell<number>;
    name?: Cell<string>;
}
const myHandler = handler(false as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        value: {
            type: "number",
            asCell: true
        },
        name: {
            type: "string",
            asCell: true
        }
    },
    required: ["value"]
} as const satisfies __ctHelpers.JSONSchema, (_, state: State) => {
    state.value.set(state.value.get() + 1);
});
export default recipe({
    type: "object",
    properties: {
        value: { type: "number", asCell: true },
        name: { type: "string", asCell: true },
    },
    required: ["value"],
}, {
    type: "object",
    properties: {
        onClick1: {
            asStream: true
        },
        onClick2: {
            asStream: true
        },
        onClick3: {
            asStream: true
        }
    },
    required: ["onClick1", "onClick2", "onClick3"]
} as const satisfies __ctHelpers.JSONSchema, (state) => {
    return {
        // Test case 1: Object literal with all properties from state
        onClick1: myHandler({ value: state.value, name: state.name }),
        // Test case 2: Object literal with all properties (explicitly listed)
        onClick2: myHandler({ value: state.value, name: state.name }),
        // Test case 3: Direct state passing (what we want to transform to)
        onClick3: myHandler(state),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
