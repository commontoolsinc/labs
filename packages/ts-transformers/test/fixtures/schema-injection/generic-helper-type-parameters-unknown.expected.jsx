import * as __cfHelpers from "commonfabric";
import { Cell, generateObject, wish } from "commonfabric";
// FIXTURE: generic-helper-type-parameters-unknown
// Verifies: generic definition-site helper wrappers degrade injected schemas to unknown
//   wish<T>({ query }) → wish<T>({ query }, { type: "unknown" })
//   generateObject<T>({ ... }) → generateObject<T>({ ..., schema: { type: "unknown" } })
//   Cell.of<T>(value) → Cell.of<T>(value, { type: "unknown" })
export function buildWishExplicit<T>(path: string) {
    return wish<T>({ query: path }, {
        type: "unknown"
    } as const satisfies __cfHelpers.JSONSchema);
}
export function buildObjectExplicit<T>(prompt: string) {
    return generateObject<T>({
        model: "gpt-4o-mini",
        prompt,
        schema: {
            type: "unknown"
        } as const satisfies __cfHelpers.JSONSchema
    });
}
export function buildCellExplicit<T>(value: T) {
    return Cell.of<T>(value, {
        type: "unknown"
    } as const satisfies __cfHelpers.JSONSchema);
}
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __cfHelpers.h.fragment;
