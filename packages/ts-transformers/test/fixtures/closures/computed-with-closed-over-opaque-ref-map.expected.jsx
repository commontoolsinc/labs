import * as __cfHelpers from "commonfabric";
import { computed, OpaqueRef } from "commonfabric";
export default function TestComputedWithClosedOverOpaqueRefMap() {
    const items = [1, 2, 3] as OpaqueRef<number[]>;
    // Inside computed, we close over items (an OpaqueRef)
    // The computed gets transformed to derive({}, () => items.map(...))
    // Inside a derive, .map on a closed-over OpaqueRef should NOT be transformed to mapWithPattern
    // because items is already an OpaqueRef and will be passed through as-is
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
