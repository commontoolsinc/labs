// Main API exports
export { SchemaGenerator } from "./schema-generator.ts";
export { createSchemaTransformerV2 } from "./plugin.ts";
export {
  containsFactoryType,
  detectFactoryType,
  detectTrustedFactoryType,
  type FactoryTypeInfo,
  type FactoryTypeKind,
} from "./formatters/factory-formatter.ts";
export {
  getImportTypeModuleName,
  isCommonFabricDeclaration,
  isCommonFabricModuleName,
  isCommonFabricSymbol,
} from "./typescript/common-fabric-symbols.ts";

// Public types for API consumers
export type { SchemaGenerator as ISchemaGenerator } from "./interface.ts";
export type { JSONSchemaObjMutable } from "@commonfabric/api";
