import * as __ctHelpers from "commontools";
import { Writable, derive, pattern } from "commontools";
// FIXTURE: derive-nested-callback
// Verifies: capture extraction works with nested plain-array .map() inside derive
//   derive(numbers, fn) → derive(schema, schema, { numbers, multiplier }, fn)
//   inner nums.map(fn) stays as plain .map(fn)
// Context: inside derive, `nums` is a plain array, so nested array methods are not rewritten
export default pattern(() => {
    const numbers = Writable.of([1, 2, 3], {
        type: "array",
        items: {
            type: "number"
        }
    } as const satisfies __ctHelpers.JSONSchema);
    const multiplier = Writable.of(2, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema);
    // Nested callback - inner array map should not capture outer multiplier
    const result = __ctHelpers.derive({
        type: "object",
        properties: {
            numbers: {
                type: "array",
                items: {
                    type: "number"
                },
                asCell: true
            },
            multiplier: {
                type: "number",
                asCell: true
            }
        },
        required: ["numbers", "multiplier"]
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "array",
        items: {
            type: "number"
        }
    } as const satisfies __ctHelpers.JSONSchema, {
        numbers,
        multiplier: multiplier
    }, ({ numbers: nums, multiplier }) => nums.map(n => n * multiplier.get()));
    return result;
}, false as const satisfies __ctHelpers.JSONSchema, {
    type: "array",
    items: {
        type: "number"
    }
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
