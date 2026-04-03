import * as __cfHelpers from "commonfabric";
import { toSchema } from "commonfabric";
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
} as const satisfies __cfHelpers.JSONSchema;
// FIXTURE: with-options
// Verifies: toSchema options object (default, description) is merged into generated schema
//   toSchema<Config>({default: ..., description: ...}) → schema with "default" and "description" alongside generated properties
export { configSchema };
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __cfHelpers.h.fragment;
