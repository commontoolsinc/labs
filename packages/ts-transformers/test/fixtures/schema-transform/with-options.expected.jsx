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
    "default": {
        value: 42
    },
    description: "Configuration schema"
} as const satisfies __ctHelpers.JSONSchema;
// FIXTURE: with-options
// Verifies: toSchema options object (default, description) is merged into generated schema
//   toSchema<Config>({default: ..., description: ...}) → schema with "default" and "description" alongside generated properties
export { configSchema };
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
