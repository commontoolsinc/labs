/// <cts-enable />
import { handler, toSchema } from "commontools";
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
} as const satisfies JSONSchema, {
    type: "object",
    properties: {
        value: {
            type: "number"
        }
    },
    required: ["value"]
} as const satisfies JSONSchema, (event, state) => {
    state.value = state.value + event.increment;
});
export { myHandler };