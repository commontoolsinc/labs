/// <cts-enable />
import { lift, JSONSchema } from "commontools";
export const doubleValue = lift(true as const satisfies JSONSchema, {
    type: "number"
} as const satisfies JSONSchema, (value) => value * 2);
