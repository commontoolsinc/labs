/// <cts-enable />
import { handler, toSchema, JSONSchema } from "commontools";
interface Event {
    detail: {
        value: number;
    };
}
interface State {
    value: number;
}
const increment = handler({
    type: "object",
    properties: {
        detail: {
            type: "object",
            properties: {
                value: {
                    type: "number"
                }
            },
            required: ["value"]
        }
    },
    required: ["detail"]
} as const satisfies JSONSchema, {
    type: "object",
    properties: {
        value: {
            type: "number"
        }
    },
    required: ["value"]
} as const satisfies JSONSchema, (_, state) => {
    state.value = state.value + 1;
});