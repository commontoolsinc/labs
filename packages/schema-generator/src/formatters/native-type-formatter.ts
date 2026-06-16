import ts from "typescript";
import type { JSONSchemaMutable } from "@commonfabric/api";
import type { GenerationContext, TypeFormatter } from "../interface.ts";

const NATIVE_TYPE_SCHEMAS: Record<string, JSONSchemaMutable> = {
  // This schema is embedded in the code, so we can have simpler links.
  VNode: { $ref: "https://commonfabric.org/schemas/vnode.json" },
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
  // These types are complex, and aren't a meaningful filter
  JSONSchemaObj: true,
  JSONSchema: true,
};

const NATIVE_TYPE_NAMES = new Set(Object.keys(NATIVE_TYPE_SCHEMAS));
const LIB_DECLARED_NATIVE_TYPES = new Set([
  "Date",
  "URL",
  "ArrayBuffer",
  "ArrayBufferLike",
  "SharedArrayBuffer",
  "ArrayBufferView",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int8Array",
  "Uint16Array",
  "Int16Array",
  "Uint32Array",
  "Int32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
]);

/**
 * Formatter that replaces specific types with a manually specified schema
 *
 * This mostly exists to support native types, but it's also used to replace
 * complex types with simpler schemas than what would be generatted, and allow
 * for referencing embedded schema definitions.
 */
export class NativeTypeFormatter implements TypeFormatter {
  supportsType(type: ts.Type, context: GenerationContext): boolean {
    const typeName = NativeTypeFormatter.getTypeName(type);
    if (!NativeTypeFormatter.isNativeType(typeName)) {
      return false;
    }
    if (
      typeName !== undefined && LIB_DECLARED_NATIVE_TYPES.has(typeName)
    ) {
      return NativeTypeFormatter.hasLibraryDeclaration(type, context);
    }
    return true;
  }

  formatType(
    type: ts.Type,
    _context: GenerationContext,
  ): JSONSchemaMutable {
    const typeName = NativeTypeFormatter.getTypeName(type);
    const schema = NATIVE_TYPE_SCHEMAS[typeName!];
    // TODO(danfuzz): `structuredClone()` mangles non-JSON `FabricValue`s —
    // harmless while `NATIVE_TYPE_SCHEMAS` are plain JSON, but a problem once
    // schema-generator covers the full `FabricValue` spectrum. See the matching
    // note on `cloneSchemaDefinition()` re: a FabricValue-aware clone and
    // whether mutability is even needed.
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

  private static getTypeSymbol(type: ts.Type): ts.Symbol | undefined {
    if (type.symbol) return type.symbol;

    const objectFlags = (type as ts.ObjectType).objectFlags ?? 0;
    if (objectFlags & ts.ObjectFlags.Reference) {
      const ref = type as unknown as ts.TypeReference;
      return ref.target?.symbol;
    }

    return type.aliasSymbol;
  }

  private static hasLibraryDeclaration(
    type: ts.Type,
    context: GenerationContext,
  ): boolean {
    const symbol = NativeTypeFormatter.getTypeSymbol(type);
    return symbol?.declarations?.some((declaration) => {
      const sourceFile = declaration.getSourceFile();
      const program = (
        context.typeChecker as ts.TypeChecker & {
          getProgram?: () => ts.Program;
        }
      ).getProgram?.();
      if (program?.isSourceFileDefaultLibrary(sourceFile)) {
        return true;
      }

      const fileName = sourceFile.fileName;
      return fileName === "lib.d.ts" ||
        fileName.endsWith("/lib.d.ts") ||
        /(^|\/)lib\.[^/]+\.d\.ts$/i.test(fileName) ||
        /(^|\/)(es\d+(?:\.[^/]+)?|dom|jsx)\.d\.ts$/i.test(fileName) ||
        /(^|[\\/])node_modules[\\/]@types[\\/]node[\\/]/.test(fileName);
    }) ?? false;
  }

  // We expose this so type-utils can skip generating $defs for these
  public static isNativeType(typeName: string | undefined): boolean {
    return typeName !== undefined && NATIVE_TYPE_NAMES.has(typeName);
  }
}
