/// <cts-enable />
import { derive } from "commontools";

declare const total: number;

export const doubled = derive(total, (value) => value * 2);
