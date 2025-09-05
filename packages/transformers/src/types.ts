// Common types for transformer options and configuration
import ts from "typescript";

export interface SchemaTransformerOptions {
  // Options for schema transformer
}

export interface OpaqueRefTransformerOptions {
  // Options for opaque ref transformer
}

export interface TransformerContext {
  program: ts.Program;
  checker: ts.TypeChecker;
}