import ts from "typescript";
import type {
  GenerationContext,
  SchemaDefinition,
  TypeFormatter,
} from "../interface.ts";

const NATIVE_TYPE_SCHEMAS: Record<string, SchemaDefinition | boolean> = {
  VNode: { $ref: "https://commontools.dev/schemas/vdom.json" },
  Date: { type: "string", format: "date-time" },
  URL: { type: "string", format: "uri" },
  ArrayBuffer: true,
  ArrayBufferLike: true,
  SharedArrayBuffer: true,
  ArrayBufferView: true,
  Uint8Array: true,
  Uint8ClampedArray: true,
  Int8Array: true,
  Uint16Array: true,
  Int16Array: true,
  Uint32Array: true,
  Int32Array: true,
  Float32Array: true,
  Float64Array: true,
  BigInt64Array: true,
  BigUint64Array: true,
  JSONSchemaObj: true,
  JSONSchema: true,
};

const NATIVE_TYPE_NAMES = new Set(Object.keys(NATIVE_TYPE_SCHEMAS));

/**
 * Formatter that replaces specific types with a manually specified schema
 *
 * This mostly exists to support native types, but it's also used to replace
 * complex types with simpler schemas than what would be generatted, and allow
 * for referencing embedded schema definitions.
 */
export class NativeTypeFormatter implements TypeFormatter {
  supportsType(type: ts.Type, _context: GenerationContext): boolean {
    const typeName = NativeTypeFormatter.getTypeName(type);
    return NativeTypeFormatter.isNativeType(typeName);
  }

  formatType(type: ts.Type, _context: GenerationContext): SchemaDefinition {
    const typeName = NativeTypeFormatter.getTypeName(type);
    const schema = NATIVE_TYPE_SCHEMAS[typeName!];
    return (typeof schema === "boolean" ? schema : structuredClone(schema!));
  }

  private static getTypeName(type: ts.Type): string | undefined {
    // Prefer direct symbol name; fall back to target symbol for TypeReference
    const symbol = type.symbol;
    let name = symbol?.name;
    const objectFlags = (type as ts.ObjectType).objectFlags ?? 0;
    if (!name && (objectFlags & ts.ObjectFlags.Reference)) {
      const ref = type as unknown as ts.TypeReference;
      name = ref.target?.symbol?.name ?? name;
    }
    // Known compiler-internal anonymous type names
    // Using a minimal whitelist - only block the most common cases we know are problematic.
    // Fail open: if uncertain, let it through rather than break user code (like GraphQL __Schema types).
    const compilerInternalNames = new Set([
      "__type", // Anonymous object literals
      "__object", // Anonymous object types
    ]);

    // Helper to check if a name is compiler-internal/anonymous
    // vs. user-defined types that happen to start with __ (e.g., GraphQL introspection types like __Schema)
    const isAnonymousName = (n: string | undefined) => {
      if (!n) return true; // No name = anonymous
      return compilerInternalNames.has(n); // Check against whitelist
    };

    const aliasName = type.aliasSymbol?.name;

    // Fall back to alias symbol when present (type aliases) if we haven't used it yet
    // This includes the case where symbol.name is "__type" (anonymous object literal)
    // but the type has an explicit alias name
    if (isAnonymousName(name) && aliasName) {
      name = aliasName;
    }

    if (isAnonymousName(name)) {
      return undefined;
    }

    return name;
  }

  // We expose this so type-utils can skip generating $defs for these
  public static isNativeType(typeName: string | undefined): boolean {
    return typeName !== undefined && NATIVE_TYPE_NAMES.has(typeName);
  }
}
