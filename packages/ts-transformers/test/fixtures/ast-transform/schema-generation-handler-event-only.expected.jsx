import * as __ctHelpers from "commontools";
import { handler } from "commontools";
interface IncrementEvent {
    amount: number;
}
// FIXTURE: schema-generation-handler-event-only
// Verifies: handler() with only event param typed generates event schema and false for state
//   handler((event: IncrementEvent, _state) => ...) → handler(eventSchema, false, fn)
// Context: Untyped state param gets `false` as its schema (unknown)
// Only event is typed, state should get unknown schema
export const incrementer = handler({
    type: "object",
    properties: {
        amount: {
            type: "number"
        }
    },
    required: ["amount"]
} as const satisfies __ctHelpers.JSONSchema, false as const satisfies __ctHelpers.JSONSchema, (event: IncrementEvent, _state) => {
    console.log("increment by", event.amount);
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
