/// <cts-enable />
import { derive } from "commonfabric";

declare const value: number;

// FIXTURE: schema-generation-derive-inside-jsx
// Verifies: derive() inside a JSX expression still gets schemas injected
//   derive(value, (v) => v * 2) → derive(inputSchema, outputSchema, value, fn)
// Context: derive() appears as a JSX child expression, not a standalone statement
export const result = (
  <div>
    {derive(value, (v) => v * 2)}
  </div>
);
