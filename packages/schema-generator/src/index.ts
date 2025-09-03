// Main API exports
export { SchemaGenerator } from "./schema-generator.ts";
export { createSchemaTransformerV2 } from "./plugin.ts";

// Public types for API consumers
export type {
  SchemaDefinition,
  SchemaGenerator as ISchemaGenerator,
} from "./interface.ts";
