import * as __ctHelpers from "commontools";
import { pattern } from "commontools";
interface MyInput {
    value: number;
}
export default pattern({
    type: "object",
    properties: {
        value: {
            type: "number"
        }
    },
    required: ["value"]
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        result: {
            type: "number"
        }
    },
    required: ["result"]
} as const satisfies __ctHelpers.JSONSchema, (input: MyInput) => {
    return {
        result: input.value * 2,
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
