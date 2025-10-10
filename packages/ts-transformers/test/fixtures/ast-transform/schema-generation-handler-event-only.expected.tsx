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
} as const satisfies __ctHelpers.JSONSchema, true as const satisfies __ctHelpers.JSONSchema, (event: IncrementEvent, state) => {
    console.log("increment by", event.amount);
});
__ctHelpers.NAME; // <internals>
