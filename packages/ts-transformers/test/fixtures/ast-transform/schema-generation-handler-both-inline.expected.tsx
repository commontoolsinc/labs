/// <cts-enable />
import { handler, JSONSchema } from "commontools";
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
} as const satisfies JSONSchema, {
    type: "object",
    properties: {
        count: {
            type: "number"
        }
    },
    required: ["count"]
} as const satisfies JSONSchema, (event: IncrementEvent, state: CounterState) => {
    state.count += event.amount;
});