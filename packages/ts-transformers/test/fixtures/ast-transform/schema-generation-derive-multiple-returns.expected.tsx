/// <cts-enable />
import { derive, JSONSchema } from "commontools";
declare const flag: boolean;
// Function with multiple return statements - should infer string | number
export const multiReturn = derive({
    type: "boolean"
} as const satisfies JSONSchema, {
    enum: ["hello", 42]
} as const satisfies JSONSchema, flag, (value) => {
    if (value) {
        return "hello";
    }
    return 42;
});