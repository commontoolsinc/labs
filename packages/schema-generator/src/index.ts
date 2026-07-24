// Main API exports
export { SchemaGenerator } from "./schema-generator.ts";
export { createSchemaTransformerV2 } from "./plugin.ts";

// Public types for API consumers
export type {
  SchemaGenerationOptions,
  SchemaGenerator as ISchemaGenerator,
  WriterSourceIdentity,
} from "./interface.ts";
export type { JSONSchemaObjMutable } from "@commonfabric/api";
