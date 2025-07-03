/// <cts-enable />
import { Cell, toSchema, JSONSchema } from "commontools";
interface State {
    count: Cell<number>;
    name: Cell<string>;
    enabled: boolean;
}
const stateSchema = {
    type: "object",
    properties: {
        count: {
            type: "number",
            asCell: true
        },
        name: {
            type: "string",
            asCell: true
        },
        enabled: {
            type: "boolean"
        }
    },
    required: ["count", "name", "enabled"],
    default: {
        count: 0,
        name: "test",
        enabled: true
    }
} as const satisfies JSONSchema;
export { stateSchema };
