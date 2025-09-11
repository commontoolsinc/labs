import ts from "typescript";
import type {
  GenerationContext,
  SchemaDefinition,
  TypeFormatter,
} from "../interface.ts";
import { safeGetPropertyType } from "../type-utils.ts";
import type { SchemaGenerator } from "../schema-generator.ts";
import { extractDocFromSymbolAndDecls, getDeclDocs } from "../doc-utils.ts";
import { getLogger } from "@commontools/utils/logger";

const logger = getLogger("schema-generator.object", {
  enabled: true,
  level: "warn",
});

/**
 * Formatter for object types (interfaces, type literals, etc.)
 */
export class ObjectFormatter implements TypeFormatter {
  constructor(private schemaGenerator: SchemaGenerator) {}

  supportsType(type: ts.Type, context: GenerationContext): boolean {
    // Handle object types (interfaces, type literals, classes) and the
    // TypeScript "object" type (non-primitive).
    const flags = type.flags;
    return (flags & ts.TypeFlags.Object) !== 0 ||
      (flags & (ts as any).TypeFlags.NonPrimitive) !== 0;
  }

  formatType(type: ts.Type, context: GenerationContext): SchemaDefinition {
    const checker = context.typeChecker;

    // If this is the TS `object` type (unknown object shape), emit a permissive
    // object schema instead of attempting to enumerate properties.
    // This avoids false "no formatter" errors for unions containing `object`.
    const typeName = checker.typeToString(type);
    if (typeName === "object") {
      return { type: "object", additionalProperties: true };
    }

    // Special-case Date to a string with date-time format (match old behavior)
    if (type.symbol?.name === "Date" && type.symbol?.valueDeclaration) {
      // Check if this is the built-in Date type (not a user-defined type named "Date")
      const sourceFile = type.symbol.valueDeclaration.getSourceFile();

      if (
        sourceFile.fileName.includes("lib.") ||
        sourceFile.fileName.includes("typescript/lib") ||
        sourceFile.fileName.includes("ES2023.d.ts") ||
        sourceFile.fileName.includes("DOM.d.ts")
      ) {
        return { type: "string", format: "date-time" };
      }
    }

    // Do not early-return for empty object types. Instead, try to enumerate
    // properties via the checker to allow type literals to surface members.

    const properties: Record<string, SchemaDefinition> = {};
    const required: string[] = [];

    const props = checker.getPropertiesOfType(type);
    for (const prop of props) {
      const propName = prop.getName();
      if (propName.startsWith("__")) continue; // Skip internal properties

      const isOptional = (prop.flags & ts.SymbolFlags.Optional) !== 0;
      if (!isOptional) required.push(propName);

      let propTypeNode: ts.TypeNode | undefined;
      const propDecl = prop.valueDeclaration ??
        (prop.declarations?.[0] as ts.Declaration);
      if (propDecl) {
        if (
          ts.isPropertySignature(propDecl) || ts.isPropertyDeclaration(propDecl)
        ) {
          if (propDecl.type) propTypeNode = propDecl.type as ts.TypeNode;
        }
      }

      // Get the actual property type and recursively delegate to the main schema generator
      const resolvedPropType = safeGetPropertyType(
        prop,
        type,
        checker,
        propTypeNode,
      );

      // Delegate to the main generator (specific formatters handle wrappers/defaults)
      const generated: SchemaDefinition = this.schemaGenerator.formatChildType(
        resolvedPropType,
        context,
        propTypeNode,
      );
      // Attach property description from JSDoc (if any)
      const { text, all } = extractDocFromSymbolAndDecls(prop, checker);
      if (text && typeof generated === "object" && generated) {
        const conflicts = all.filter((s) => s && s !== text);
        (generated as any).description = text;
        if (conflicts.length > 0) {
          const comment = (generated as any).$comment as string | undefined;
          (generated as any).$comment = comment
            ? comment
            : "Conflicting docs across declarations; using first";
          // Warning only
          logger.warn(() =>
            `JSDoc conflict for property '${propName}'; using first doc`
          );
        }
      }
      properties[propName] = generated;
    }

    const schema: SchemaDefinition = { type: "object", properties };

    // Handle string/number index signatures → additionalProperties with description
    const stringIndex = checker.getIndexTypeOfType(type, ts.IndexKind.String);
    const numberIndex = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
    const chosenIndex = stringIndex ?? numberIndex;
    if (chosenIndex) {
      const apSchema = this.schemaGenerator.formatChildType(
        chosenIndex,
        context,
        undefined,
      );
      // Attempt to read JSDoc from index signature declarations
      const sym = (type as ts.Type).getSymbol?.();
      const foundDocs: string[] = [];
      if (sym) {
        for (const decl of sym.declarations ?? []) {
          if (ts.isInterfaceDeclaration(decl) || ts.isTypeLiteralNode(decl)) {
            for (const member of decl.members) {
              if (ts.isIndexSignatureDeclaration(member)) {
                const docs = getDeclDocs(member);
                for (const d of docs) {
                  if (!foundDocs.includes(d)) foundDocs.push(d);
                }
              }
            }
          }
        }
      }
      if (foundDocs.length > 0 && typeof apSchema === "object" && apSchema) {
        (apSchema as any).description = foundDocs[0]!;
        if (foundDocs.length > 1) {
          const comment = (apSchema as any).$comment as string | undefined;
          (apSchema as any).$comment = comment
            ? comment
            : "Conflicting docs for index signatures; using first";
          logger.warn(() =>
            "JSDoc conflict for index signatures; using first doc"
          );
        }
      }
      (schema as any).additionalProperties = apSchema as any;
    }
    if (required.length > 0) schema.required = required;

    return schema;
  }
}
