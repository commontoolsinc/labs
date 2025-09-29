/// <cts-enable />
import { derive, JSONSchema } from "commontools";
declare const total: number;
// Only return type is annotated, parameter type should be inferred from total
export const doubled = derive({
    type: "number"
} as const satisfies JSONSchema, {
    type: "number"
} as const satisfies JSONSchema, total, (value): number => value * 2);