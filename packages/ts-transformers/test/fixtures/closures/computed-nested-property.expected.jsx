import * as __ctHelpers from "commontools";
import { cell, computed } from "commontools";
export default function TestComputeNestedProperty() {
    const counter = cell({ count: 0 }, {
        type: "object",
        properties: {
            count: {
                type: "number"
            }
        },
        required: ["count"]
    } as const satisfies __ctHelpers.JSONSchema);
    const doubled = __ctHelpers.derive({
        type: "object",
        properties: {
            counter: {
                type: "object",
                properties: {
                    count: {
                        type: "number"
                    }
                },
                required: ["count"],
                asCell: true
            }
        },
        required: ["counter"]
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema, { counter: counter }, ({ counter }) => {
        const current = counter.get();
        return current.count * 2;
    });
    return doubled;
}
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
