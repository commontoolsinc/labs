import * as __ctHelpers from "commontools";
import { Cell, handler, pattern } from "commontools";
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
        }
    },
    required: ["value"]
} as const satisfies __ctHelpers.JSONSchema, (_, state: State) => {
    state.value.set(state.value.get() + 1);
});
// FIXTURE: handler-object-literal
// Verifies: handler gets schema from inline param type; handler invocations use state.key()
//   handler((_, state: State) => ...)          → handler(false, stateSchema, fn)
//   myHandler({ value: state.value, ... })     → myHandler({ value: state.key("value"), ... })
//   myHandler(state)                           → myHandler(state) (unchanged)
// Context: Pattern already has explicit schemas; only handler schema injection and property access transforms apply
export default pattern((state) => {
    return {
        // Test case 1: Object literal with all properties from state
        onClick1: myHandler({ value: state.key("value"), name: state.key("name") }),
        // Test case 2: Object literal with all properties (explicitly listed)
        onClick2: myHandler({ value: state.key("value"), name: state.key("name") }),
        // Test case 3: Direct state passing (what we want to transform to)
        onClick3: myHandler(state),
    };
}, {
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
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        onClick1: {
            type: "unknown",
            asStream: true
        },
        onClick2: {
            type: "unknown",
            asStream: true
        },
        onClick3: {
            type: "unknown",
            asStream: true
        }
    },
    required: ["onClick1", "onClick2", "onClick3"]
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
