/// <cts-enable />
import { derive as deriveAlias } from "commontools";

type AliasInput = {
  text: string;
};

type AliasResult = {
  length: number;
};

declare const state: AliasInput;

export const textLength = deriveAlias<AliasInput, AliasResult>(
  state,
  (value) => ({
    length: value.text.length,
  }),
);
