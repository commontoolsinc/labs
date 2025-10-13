import * as __ctHelpers from "commontools";
import { handler } from "commontools";
interface CounterEvent {
    increment: number;
}
interface CounterState {
    value: number;
}
const myHandler = handler({
    type: "object",
    properties: {
        increment: {
            type: "number"
        }
    },
    required: ["increment"]
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        value: {
            type: "number"
        }
    },
    required: ["value"]
} as const satisfies __ctHelpers.JSONSchema, (event, state) => {
    state.value = state.value + event.increment;
});
export { myHandler };
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
