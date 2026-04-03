import * as __cfHelpers from "commonfabric";
import { handler } from "commonfabric";
interface IncrementEvent {
    amount: number;
}
interface CounterState {
    count: number;
}
// FIXTURE: schema-generation-handler-both-inline
// Verifies: handler() with both params typed inline generates event and state schemas
//   handler((event: IncrementEvent, state: CounterState) => ...) → handler(eventSchema, stateSchema, fn)
// Context: Types come from inline parameter annotations, not generic type args
// Both parameters typed inline (no generic type arguments)
export const incrementer = handler({
    type: "object",
    properties: {
        amount: {
            type: "number"
        }
    },
    required: ["amount"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        count: {
            type: "number"
        }
    },
    required: ["count"]
} as const satisfies __cfHelpers.JSONSchema, (event: IncrementEvent, state: CounterState) => {
    state.count += event.amount;
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __cfHelpers.h.fragment;
