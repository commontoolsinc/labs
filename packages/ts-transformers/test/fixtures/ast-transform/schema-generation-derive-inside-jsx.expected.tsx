/// <cts-enable />
import { derive, h, JSONSchema } from "commontools";
declare const value: number;
export const result = (<div>
    {derive({
    type: "number"
} as const satisfies JSONSchema, {
    type: "number"
} as const satisfies JSONSchema, value, (v) => v * 2)}
  </div>);