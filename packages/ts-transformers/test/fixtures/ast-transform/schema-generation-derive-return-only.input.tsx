/// <cts-enable />
import { derive } from "commontools";

declare const total: number;

// Only return type is annotated, parameter type should be inferred from total
export const doubled = derive(total, (value): number => value * 2);