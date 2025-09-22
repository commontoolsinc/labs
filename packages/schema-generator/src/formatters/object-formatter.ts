import ts from "typescript";
import type {
  GenerationContext,
  SchemaDefinition,
  TypeFormatter,
} from "../interface.ts";
import {
  cloneSchemaDefinition,
  getNativeTypeSchema,
  isFunctionLike,
  safeGetPropertyType,
} from "../type-utils.ts";
import type { SchemaGenerator } from "../schema-generator.ts";
import { extractDocFromSymbolAndDecls, getDeclDocs } from "../doc-utils.ts";
import { getLogger } from "@commontools/utils/logger";
import { isRecord } from "@commontools/utils/types";

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
    // Handle object types (interfaces, type literals, classes)
    const flags = type.flags;
    if ((flags & ts.TypeFlags.Object) !== 0) return true;
    // Also claim the exact TypeScript `object` type via string check.
    return context.typeChecker.typeToString(type) === "object";
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

    const builtin = this.lookupBuiltInSchema(type, checker);
    if (builtin) return builtin;

    // Do not early-return for empty object types. Instead, try to enumerate
    // properties via the checker to allow type literals to surface members.

    const properties: Record<string, SchemaDefinition> = {};
    const required: string[] = [];

    const props = checker.getPropertiesOfType(type);
    for (const prop of props) {
      const propName = prop.getName();
      if (propName.startsWith("__")) continue; // Skip internal properties

      let propTypeNode: ts.TypeNode | undefined;
      const propDecl = prop.valueDeclaration ??
        (prop.declarations?.[0] as ts.Declaration | undefined);

      if (propDecl) {
        if (
          ts.isMethodSignature(propDecl) || ts.isMethodDeclaration(propDecl)
        ) {
          continue;
        }
        if (
          ts.isPropertySignature(propDecl) || ts.isPropertyDeclaration(propDecl)
        ) {
          if (propDecl.type) propTypeNode = propDecl.type as ts.TypeNode;
        }
      }

      if ((prop.flags & ts.SymbolFlags.Method) !== 0) continue;

      // Get the actual property type and recursively delegate to the main schema generator
      const resolvedPropType = safeGetPropertyType(
        prop,
        type,
        checker,
        propTypeNode,
      );

      if (isFunctionLike(resolvedPropType)) {
        continue;
      }

      const isOptional = (prop.flags & ts.SymbolFlags.Optional) !== 0;
      if (!isOptional) required.push(propName);

      // Delegate to the main generator (specific formatters handle wrappers/defaults)
      const generated: SchemaDefinition = this.schemaGenerator.formatChildType(
        resolvedPropType,
        context,
        propTypeNode,
      );
      // Attach property description from JSDoc (if any)
      const { text, all } = extractDocFromSymbolAndDecls(prop, checker);
      if (text && isRecord(generated)) {
        const conflicts = all.filter((s) => s && s !== text);
        (generated as Record<string, unknown>).description = text;
        if (conflicts.length > 0) {
          const comment = typeof generated.$comment === "string"
            ? (generated.$comment as string)
            : undefined;
          (generated as Record<string, unknown>).$comment = comment
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
      const sym = type.getSymbol?.();
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
      if (foundDocs.length > 0 && isRecord(apSchema)) {
        (apSchema as Record<string, unknown>).description = foundDocs[0]!;
        if (foundDocs.length > 1) {
          const comment = typeof apSchema.$comment === "string"
            ? (apSchema.$comment as string)
            : undefined;
          (apSchema as Record<string, unknown>).$comment = comment
            ? comment
            : "Conflicting docs for index signatures; using first";
          logger.warn(() =>
            "JSDoc conflict for index signatures; using first doc"
          );
        }
      }
      (schema as Record<string, unknown>).additionalProperties =
        apSchema as SchemaDefinition;
    }
    if (required.length > 0) schema.required = required;

    return schema;
  }

  private lookupBuiltInSchema(
    type: ts.Type,
    checker: ts.TypeChecker,
  ): SchemaDefinition | boolean | undefined {
    const builtin = getNativeTypeSchema(type, checker);
    return builtin === undefined ? undefined : cloneSchemaDefinition(builtin);
  }
}
