// Main API exports
export { SchemaGenerator } from "./schema-generator.ts";
export { createSchemaTransformerV2 } from "./plugin.ts";
export {
  containsFactoryType,
  detectFactoryType,
  type FactoryTypeInfo,
  type FactoryTypeKind,
} from "./formatters/factory-formatter.ts";

// Public types for API consumers
export type { SchemaGenerator as ISchemaGenerator } from "./interface.ts";
export type { JSONSchemaObjMutable } from "@commonfabric/api";
