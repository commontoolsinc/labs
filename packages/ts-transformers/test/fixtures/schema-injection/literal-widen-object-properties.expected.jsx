function __ctHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __ctHelpers as __cfHelpers } from "commonfabric";
import { cell } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __ctAmdHooks = undefined;
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
__ctHardenFn(TestLiteralWidenObjectProperties);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__ctHardenFn(h);
