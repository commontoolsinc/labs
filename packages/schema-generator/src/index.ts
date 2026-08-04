// Main API exports
export { SchemaGenerator } from "./schema-generator.ts";

// Public types for API consumers
export type {
  SchemaGenerationOptions,
  SchemaGenerator as ISchemaGenerator,
  WriterSourceIdentity,
} from "./interface.ts";
export type { MutableJSONSchemaObj } from "@commonfabric/api";
