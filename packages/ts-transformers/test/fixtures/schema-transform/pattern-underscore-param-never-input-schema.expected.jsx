import * as __cfHelpers from "commonfabric";
import { pattern } from "commonfabric";
// FIXTURE: pattern-underscore-param-never-input-schema
// Verifies: underscore-prefixed authored pattern params still emit the `false`
// / never input schema while preserving the result schema.
export default pattern((_state: {
    name: string;
    count: number;
}) => {
    return { ok: true as const };
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        ok: {
            type: "boolean",
            "enum": [true]
        }
    },
    required: ["ok"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __cfHelpers.h.fragment;
