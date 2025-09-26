/// <cts-enable />
import { derive } from "commontools";

type DeriveInput = {
  count: number;
};

type DeriveResult = {
  doubled: number;
};

declare const source: DeriveInput;

export const doubledValue = derive<DeriveInput, DeriveResult>(
  source,
  (input) => ({
    doubled: input.count * 2,
  }),
);
