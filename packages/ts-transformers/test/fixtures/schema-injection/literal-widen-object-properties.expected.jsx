import * as __cfHelpers from "commonfabric";
import { cell } from "commonfabric";
// FIXTURE: literal-widen-object-properties
// Verifies: object literal properties are widened to typed schema with required keys
//   cell({ x: 10, y: 20, name: "point" }) → cell(..., { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, name: { type: "string" } }, required: ["x", "y", "name"] })
export default function TestLiteralWidenObjectProperties() {
    const _obj = cell({ x: 10, y: 20, name: "point" }, {
        type: "object",
        properties: {
            x: {
                type: "number"
            },
            y: {
                type: "number"
            },
            name: {
                type: "string"
            }
        },
        required: ["x", "y", "name"]
    } as const satisfies __cfHelpers.JSONSchema);
    return null;
}
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __cfHelpers.h.fragment;
