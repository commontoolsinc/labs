/// <cts-enable />
import { handler, JSONSchema } from "commontools";
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
} as const satisfies JSONSchema, {} as const satisfies JSONSchema, (event: IncrementEvent, state) => {
    console.log("increment by", event.amount);
});