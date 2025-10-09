import * as __ctHelpers from "commontools";
import { derive } from "commontools";
declare const total: number;
export const doubled = derive({
    type: "number"
} as const satisfies __ctHelpers.JSONSchema, {
    type: "number"
} as const satisfies __ctHelpers.JSONSchema, total, (value) => value * 2);
__ctHelpers.NAME; // <internals>
