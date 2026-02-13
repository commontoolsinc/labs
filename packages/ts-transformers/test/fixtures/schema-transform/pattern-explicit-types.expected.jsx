import * as __ctHelpers from "commontools";
import { pattern, } from "commontools";
interface Input {
    foo: string;
}
interface Output extends Input {
    bar: number;
}
export default pattern({
    type: "object",
    properties: {
        foo: {
            type: "string"
        }
    },
    required: ["foo"]
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        bar: {
            type: "number"
        },
        foo: {
            type: "string"
        }
    },
    required: ["bar", "foo"]
} as const satisfies __ctHelpers.JSONSchema, (input) => {
    return { ...input, bar: 123 };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
