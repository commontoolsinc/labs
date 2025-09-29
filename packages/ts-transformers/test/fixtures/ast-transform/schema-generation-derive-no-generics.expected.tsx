/// <cts-enable />
import { derive, JSONSchema } from "commontools";
declare const total: number;
export const doubled = derive({
    type: "number"
} as const satisfies JSONSchema, {
    type: "number"
} as const satisfies JSONSchema, total, (value: number) => value * 2);
