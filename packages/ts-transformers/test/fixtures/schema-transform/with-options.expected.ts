/// <cts-enable />
import { JSONSchema } from "commontools";
interface Config {
    value: number;
}
const configSchema = {
    type: "object",
    properties: {
        value: {
            type: "number"
        }
    },
    required: ["value"],
    default: {
        value: 42
    },
    description: "Configuration schema"
} as const satisfies JSONSchema;
export { configSchema };
