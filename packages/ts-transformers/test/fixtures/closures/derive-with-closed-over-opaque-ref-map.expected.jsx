import * as __cfHelpers from "commonfabric";
import { derive, OpaqueRef } from "commonfabric";
export default function TestDeriveWithClosedOverOpaqueRefMap() {
    const items = [1, 2, 3] as OpaqueRef<number[]>;
    // Explicit derive with closed-over OpaqueRef
    // .map on a closed-over OpaqueRef should NOT be transformed to mapWithPattern
    const doubled = __cfHelpers.derive({
        type: "object",
        properties: {
            items: {
                type: "array",
                items: {
                    type: "number"
                }
            }
        },
        required: ["items"]
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "array",
        items: {
            type: "number"
        }
    } as const satisfies __cfHelpers.JSONSchema, { items: items }, ({ items }) => items.map(n => n * 2));
    return doubled;
}
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __cfHelpers.h.fragment;
