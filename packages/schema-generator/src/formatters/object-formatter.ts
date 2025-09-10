import ts from "typescript";
import type {
  GenerationContext,
  SchemaDefinition,
  TypeFormatter,
} from "../interface.ts";
import { safeGetPropertyType } from "../type-utils.ts";
import type { SchemaGenerator } from "../schema-generator.ts";
import { extractDocFromSymbolAndDecls, getDeclDocs } from "../doc-utils.ts";

/**
 * Formatter for object types (interfaces, type literals, etc.)
 */
export class ObjectFormatter implements TypeFormatter {
  constructor(private schemaGenerator: SchemaGenerator) {}

  supportsType(type: ts.Type, context: GenerationContext): boolean {
    // Handle object types (interfaces, type literals, classes)
    return (type.flags & ts.TypeFlags.Object) !== 0;
  }

  formatType(type: ts.Type, context: GenerationContext): SchemaDefinition {
    const checker = context.typeChecker;

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
      try {
        const { text, all } = extractDocFromSymbolAndDecls(prop, checker);
        if (text && typeof generated === "object" && generated) {
          const conflicts = all.filter((s) => s && s !== text);
          (generated as any).description = text;
          if (conflicts.length > 0) {
            const comment = (generated as any).$comment as string | undefined;
            (generated as any).$comment = comment
              ? comment
              : "Conflicting docs across declarations; using first";
            // Do not throw; warning only
            // deno-lint-ignore no-console
            console.warn(
              `JSDoc conflict for property '${propName}'; using first doc`,
            );
          }
        }
      } catch (_e) {
        // Swallow doc extraction errors for robustness
      }
      properties[propName] = generated;
    }

    const schema: SchemaDefinition = { type: "object", properties };

    // Handle string/number index signatures → additionalProperties with description
    try {
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
            // deno-lint-ignore no-console
            console.warn(
              "JSDoc conflict for index signatures; using first doc",
            );
          }
        }
        (schema as any).additionalProperties = apSchema as any;
      }
    } catch (_e) {
      // Ignore index signature doc extraction errors
    }
    if (required.length > 0) schema.required = required;

    return schema;
  }
}
