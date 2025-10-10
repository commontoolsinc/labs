import * as __ctHelpers from "commontools";
import { toSchema } from "commontools";
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
} as const satisfies __ctHelpers.JSONSchema;
export { configSchema };
__ctHelpers.NAME; // <internals>
