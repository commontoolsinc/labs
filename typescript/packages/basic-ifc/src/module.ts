import { Integrity } from "./principals.ts";

/**
TODO:
  - Maybe for now do a hacky version without JSON schema
  - Later write code that extracts constraints from JSON schema

 */

export interface ModuleDefinition {
  hash: string;
  inputs: { [key: string]: Integrity };
}
