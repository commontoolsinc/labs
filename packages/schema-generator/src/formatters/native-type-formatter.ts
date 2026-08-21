import ts from "typescript";
import {
  FABRIC_PRIMITIVE_SCHEMA_TYPES,
  FABRIC_SPECIAL_OBJECT_BRAND,
  type MutableJSONSchema,
} from "@commonfabric/api";
import type { GenerationContext, TypeFormatter } from "../interface.ts";

const NATIVE_TYPE_SCHEMAS: Record<string, MutableJSONSchema> = {
  // This schema is embedded in the code, so we can have simpler links.
  VNode: { $ref: "https://commonfabric.org/schemas/vnode.json" },
  // A `Date` is stored as a `FabricEpochNsec` and a `Uint8Array` as a
  // `FabricBytes`, so both are objects at the fabric boundary, and a value
  // stored as one reads back intact through `"object"`. (`{ type: "string" }`
  // does not: the read projects to `undefined`, which is what the `Date`
  // mapping used to do to every value read through the schema its own TS type
  // generates.) These deliberately stay `"object"` rather than adopting the
  // fabric-primitive type names below: a field authored against a NATIVE TS
  // type can hold a raw native value on the way into the fabric boundary, and
  // the fabric-primitive types validate by prototype only.
  Date: { type: "object" },
  RegExp: { type: "object" },
  Uint8Array: { type: "object" },
  // Fields authored against the fabric-primitive classes themselves emit the
  // fabric-primitive schema vocabulary (`FABRIC_PRIMITIVE_SCHEMA_TYPES` in
  // `@commonfabric/api`): a value matches by prototype, not by structure.
  // Guarded in `supportsType` by the `FabricSpecialObject` brand so an
  // unrelated user type sharing a name keeps its structural schema.
  FabricBytes: { type: "FabricBytes" },
  FabricEpochDay: { type: "FabricEpochDay" },
  FabricEpochNsec: { type: "FabricEpochNsec" },
  FabricHash: { type: "FabricHash" },
  FabricKeyPair: { type: "FabricKeyPair" },
  FabricRegExp: { type: "FabricRegExp" },
  // A `URL` converts to a plain string, so this one is accurate as written.
  URL: { type: "string", format: "uri" },
  ArrayBuffer: true,
  ArrayBufferLike: true,
  SharedArrayBuffer: true,
  ArrayBufferView: true,
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
const FABRIC_PRIMITIVE_TYPE_NAMES: ReadonlySet<string> = new Set(
  FABRIC_PRIMITIVE_SCHEMA_TYPES,
);
const LIB_DECLARED_NATIVE_TYPES = new Set([
  "Date",
  "RegExp",
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
    if (NativeTypeFormatter.isFabricPrimitiveTypeName(typeName)) {
      return NativeTypeFormatter.declaresFabricSpecialObjectBrand(type);
    }
    return true;
  }

  formatType(
    type: ts.Type,
    _context: GenerationContext,
  ): MutableJSONSchema {
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

  /** Whether the name is one of the fabric-primitive schema-vocabulary names. */
  public static isFabricPrimitiveTypeName(
    typeName: string | undefined,
  ): boolean {
    return typeName !== undefined && FABRIC_PRIMITIVE_TYPE_NAMES.has(typeName);
  }

  /**
   * Whether the type carries the `FabricSpecialObject` nominal brand
   * (directly or by inheritance). This is what makes a type named e.g.
   * `FabricBytes` actually BE the fabric-primitive class rather than an
   * unrelated user type that happens to share the name. Both this formatter's
   * `supportsType` and named-type hoisting (`getNamedTypeKey`,
   * `type-utils.ts`) classify by it, so an unbranded name-sharer keeps its
   * structural schema AND its normal `$defs` hoisting.
   */
  public static declaresFabricSpecialObjectBrand(type: ts.Type): boolean {
    return type.getProperty(FABRIC_SPECIAL_OBJECT_BRAND) !== undefined;
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
