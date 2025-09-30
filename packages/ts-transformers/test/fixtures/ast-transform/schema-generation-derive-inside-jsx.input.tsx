/// <cts-enable />
import { derive, h } from "commontools";

declare const value: number;

export const result = (
  <div>
    {derive(value, (v) => v * 2)}
  </div>
);