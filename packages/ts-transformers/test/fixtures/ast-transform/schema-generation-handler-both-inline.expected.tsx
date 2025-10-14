import * as __ctHelpers from "commontools";
import { handler } from "commontools";
interface IncrementEvent {
    amount: number;
}
interface CounterState {
    count: number;
}
// Both parameters typed inline (no generic type arguments)
export const incrementer = handler({
    type: "object",
    properties: {
        amount: {
            type: "number"
        }
    },
    required: ["amount"]
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        count: {
            type: "number"
        }
    },
    required: ["count"]
} as const satisfies __ctHelpers.JSONSchema, (event: IncrementEvent, state: CounterState) => {
    state.count += event.amount;
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
