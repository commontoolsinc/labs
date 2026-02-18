import * as __ctHelpers from "commontools";
import { handler } from "commontools";
interface IncrementEvent {
    amount: number;
}
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
