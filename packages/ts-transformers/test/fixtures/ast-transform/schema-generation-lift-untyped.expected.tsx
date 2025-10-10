import * as __ctHelpers from "commontools";
import { lift } from "commontools";
export const doubleValue = lift(true as const satisfies __ctHelpers.JSONSchema, {
    type: "number"
} as const satisfies __ctHelpers.JSONSchema, (value) => value * 2);
__ctHelpers.NAME; // <internals>
