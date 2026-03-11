import * as __ctHelpers from "commontools";
import { handler, Cell } from "commontools";
interface CounterEvent {
    increment: number;
}
interface CounterState {
    value: Cell<number>;
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
            type: "number",
            asCell: true
        }
    },
    required: ["value"]
} as const satisfies __ctHelpers.JSONSchema, (event, state) => {
    state.value.set(state.value.get() + event.increment);
});
// FIXTURE: simple-handler
// Verifies: basic handler type parameters are transformed into event and context JSON schemas
//   handler<CounterEvent, CounterState>(fn) → handler(eventSchema, contextSchema, fn)
//   Cell<number> → { type: "number", asCell: true }
export { myHandler };
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
