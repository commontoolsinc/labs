import * as __ctHelpers from "commontools";
import { Cell, pattern, action } from "commontools";
interface State {
    count: Cell<number>;
}
// FIXTURE: action-basic
// Verifies: action() callback is extracted into a handler with captured state
//   action(() => count.set(...)) → handler(eventSchema, captureSchema, (_, { count }) => count.set(...))({ count })
export default pattern((__ct_pattern_input) => {
    const count = __ct_pattern_input.key("count");
    return {
        inc: __ctHelpers.handler(false as const satisfies __ctHelpers.JSONSchema, {
            type: "object",
            properties: {
                count: {
                    type: "number",
                    asCell: true
                }
            },
            required: ["count"]
        } as const satisfies __ctHelpers.JSONSchema, (_, { count }) => count.set(count.get() + 1))({
            count: count
        }),
    };
}, {
    type: "object",
    properties: {
        count: {
            type: "number",
            asCell: true
        }
    },
    required: ["count"]
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        inc: {
            asStream: true
        }
    },
    required: ["inc"]
} as const satisfies __ctHelpers.JSONSchema);
void __ctHelpers;
