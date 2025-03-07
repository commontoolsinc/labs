import { Principal } from "./principals.ts";
import { Schema } from "./schema.ts";

export type Path = string[];

export type ConstraintOnData = {
  path: Path;
} & (
  | { opaque: boolean }
  | { from: Path }
  | { from: Path; invariant: "subset" | "length" | "members" | "frequency" }
  | { minimumIntegrity: string | Principal }
  | { maximumIntegrity: string | Principal }
  | { minimumConfidentiality: string | Principal }
  | { maximumConfidentiality: string | Principal }
);

/**
  TODO: Add restrictions on the inputs and outputs
 */
export interface ModuleDefinition {
  hash: string;
  contentType?: string;
  body?: string | object;
  inputSchema?: Schema;
  outputSchema?: Schema;
  inputRestrictions?: ConstraintOnData[];
  outputRestrictions?: ConstraintOnData[];
}
