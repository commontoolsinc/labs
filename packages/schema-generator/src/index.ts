// Main API exports
export { SchemaGenerator } from "./schema-generator.ts";
export { closeVerbEventRoot } from "./event-closure.ts";

// Public types for API consumers
export type {
  SchemaGenerationOptions,
  WriterSourceIdentity,
} from "./interface.ts";
export type { MutableJSONSchemaObj } from "@commonfabric/api";
