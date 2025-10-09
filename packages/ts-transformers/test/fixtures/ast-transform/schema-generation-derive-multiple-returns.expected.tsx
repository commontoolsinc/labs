import * as __ctHelpers from "commontools";
import { derive } from "commontools";
declare const flag: boolean;
// Function with multiple return statements - should infer string | number
export const multiReturn = derive({
    type: "boolean"
} as const satisfies __ctHelpers.JSONSchema, {
    enum: ["hello", 42]
} as const satisfies __ctHelpers.JSONSchema, flag, (value) => {
    if (value) {
        return "hello";
    }
    return 42;
});
__ctHelpers.NAME; // <internals>
