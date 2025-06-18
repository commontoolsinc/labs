import type { SchemaContext } from "./interface.ts";

// This will match every doc reachable by the specified set of documents
export const SchemaAll: SchemaContext = { schema: true, rootSchema: true };

// This is equivalent to a standard query, and will only match the specified documents
export const SchemaNone: SchemaContext = { schema: false, rootSchema: false };

export const SelectAllString = "_";
