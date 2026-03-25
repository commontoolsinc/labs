import * as __cfHelpers from "commonfabric";
import { handler, Writable } from "commonfabric";
interface CounterEvent {
    increment: number;
}
interface CounterState {
    value: Writable<number>;
}
const myHandler = handler({
    type: "object",
    properties: {
        increment: {
            type: "number"
        }
    },
    required: ["increment"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        value: {
            type: "number",
            asCell: true
        }
    },
    required: ["value"]
} as const satisfies __cfHelpers.JSONSchema, (event, state) => {
    state.value.set(state.value.get() + event.increment);
});
// FIXTURE: simple-handler-writable
// Verifies: Writable<T> is treated identically to Cell<T> and generates asCell in the schema
//   Writable<number> → { type: "number", asCell: true }
//   handler<CounterEvent, CounterState>(fn) → handler(eventSchema, contextSchema, fn)
export { myHandler };
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __cfHelpers.h.fragment;
