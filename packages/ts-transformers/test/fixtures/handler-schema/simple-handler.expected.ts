import * as __ctHelpers from "commontools";
import { handler } from "commontools";
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
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        value: {
            type: "number"
        }
    },
    required: ["value"]
} as const satisfies __ctHelpers.JSONSchema, (event, state) => {
    state.value = state.value + event.increment;
});
export { myHandler };
__ctHelpers.NAME; // <internals>
