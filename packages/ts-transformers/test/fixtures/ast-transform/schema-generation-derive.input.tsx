/// <cts-enable />
import { derive } from "commontools";

type DeriveInput = {
  count: number;
};

type DeriveResult = {
  doubled: number;
};

declare const source: DeriveInput;

// FIXTURE: schema-generation-derive
// Verifies: derive() with generic type args generates input and output schemas
//   derive<DeriveInput, DeriveResult>(source, fn) → derive(inputSchema, outputSchema, source, fn)
export const doubledValue = derive<DeriveInput, DeriveResult>(
  source,
  (input) => ({
    doubled: input.count * 2,
  }),
);
