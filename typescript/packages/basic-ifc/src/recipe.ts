import { ModuleDefinition, Path } from "./module.ts";

export interface Node {
  id: string;
  in: [Path, Path][];
  module: string | ModuleDefinition;
}

export interface Recipe {
  nodes: Node[];
}
