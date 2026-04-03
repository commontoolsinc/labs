import ts from "typescript";
import type {
  JSONSchemaMutable,
  JSONSchemaObjMutable,
} from "@commonfabric/api";
import type { GenerationContext, TypeFormatter } from "../interface.ts";
import {
  cloneSchemaDefinition,
  getNativeTypeSchema,
  getPropertyNameText,
  isFunctionLike,
  safeGetPropertyType,
} from "../type-utils.ts";
import {
  getCellWrapperInfo,
  isCellInternalMarkerName,
} from "../typescript/cell-brand.ts";
import {
  isDefaultNodeWithUndefined,
  isOptionalSymbol,
} from "../typescript/property-optionality.ts";
import type { SchemaGenerator } from "../schema-generator.ts";
import { extractDocFromSymbolAndDecls, getDeclDocs } from "../doc-utils.ts";
import { getLogger } from "@commonfabric/utils/logger";
import { isRecord } from "@commonfabric/utils/types";

const logger = getLogger("schema-generator.object", {
  enabled: true,
  level: "warn",
});

/**
 * Check if a callable type (like ModuleFactory or HandlerFactory) returns a wrapper type.
 * ModuleFactory<T, R> when called returns OpaqueRef<R>.
 * If R is Stream<T>, we should generate { asStream: true } instead of skipping.
 * If R is Cell<T>, we should generate { asCell: true } instead of skipping.
 *
 * Returns the schema definition for the wrapper if detected, undefined otherwise.
 */
function getWrapperSchemaFromCallable(
  type: ts.Type,
  checker: ts.TypeChecker,
): JSONSchemaObjMutable | undefined {
  const callSignatures = type.getCallSignatures();
  if (callSignatures.length === 0) return undefined;

  // Get the return type of the first call signature
  const callReturnType = callSignatures[0]!.getReturnType();

  // Check if the return type is a wrapper (Stream<T>, Cell<T>, or OpaqueRef<...>)
  const wrapperInfo = getCellWrapperInfo(callReturnType, checker);
  if (wrapperInfo?.kind === "Stream") {
    return { asStream: true };
  }
  if (wrapperInfo?.kind === "Cell") {
    return { asCell: true };
  }

  // Also check if it's an OpaqueRef wrapping a Stream or Cell
  if (wrapperInfo?.kind === "OpaqueRef") {
    // Get the inner type of OpaqueRef
    const typeRef = wrapperInfo.typeRef;
    const typeArgs = checker.getTypeArguments(typeRef);
    if (typeArgs.length > 0) {
      const innerType = typeArgs[0]!;
      const innerWrapperInfo = getCellWrapperInfo(innerType, checker);
      if (innerWrapperInfo?.kind === "Stream") {
        return { asStream: true };
      }
      if (innerWrapperInfo?.kind === "Cell") {
        return { asCell: true };
      }
    }
  }

  return undefined;
}

function typeNodeExplicitlyDeclaresProperty(
  typeNode: ts.TypeNode | undefined,
  propName: string,
): boolean {
  if (!typeNode) return false;

  if (ts.isParenthesizedTypeNode(typeNode)) {
    return typeNodeExplicitlyDeclaresProperty(typeNode.type, propName);
  }

  if (ts.isUnionTypeNode(typeNode)) {
    return typeNode.types.some((member) =>
      typeNodeExplicitlyDeclaresProperty(member, propName)
    );
  }

  if (!ts.isTypeLiteralNode(typeNode)) {
    return false;
  }

  return typeNode.members.some((member) =>
    (ts.isPropertySignature(member) || ts.isPropertyDeclaration(member)) &&
    !!member.name &&
    getPropertyNameText(member.name) === propName
  );
}

function shouldSkipInternalProperty(
  propName: string,
  propDecl: ts.Declaration | undefined,
  context: GenerationContext,
): boolean {
  if (propName.startsWith("__@")) {
    return true;
  }

  if (isCellInternalMarkerName(propName)) {
    return true;
  }

  if (!propName.startsWith("__")) {
    return false;
  }

  if (propDecl) {
    return false;
  }

  return !typeNodeExplicitlyDeclaresProperty(context.typeNode, propName);
}

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

  formatType(
    type: ts.Type,
    context: GenerationContext,
  ): JSONSchemaMutable {
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

    const properties: Record<string, JSONSchemaMutable> = {};
    const required: string[] = [];

    const props = checker.getPropertiesOfType(type);
    for (const prop of props) {
      const propName = prop.getName();

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

      if (shouldSkipInternalProperty(propName, propDecl, context)) {
        continue;
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
        // Special case: ModuleFactory/HandlerFactory types that return Stream or Cell
        // should generate { asStream: true } or { asCell: true } instead of being skipped
        const wrapperSchema = getWrapperSchemaFromCallable(
          resolvedPropType,
          checker,
        );
        if (wrapperSchema) {
          // This is a factory that returns a wrapper type (Stream or Cell)
          if (
            !isOptionalSymbol(prop) &&
            !isDefaultNodeWithUndefined(propTypeNode, checker)
          ) {
            required.push(propName);
          }
          properties[propName] = wrapperSchema;
        }
        continue;
      }

      if (
        !isOptionalSymbol(prop) &&
        !isDefaultNodeWithUndefined(propTypeNode, checker)
      ) {
        required.push(propName);
      }

      // Delegate to the main generator (specific formatters handle wrappers/defaults)
      const generated = this.schemaGenerator.formatChildType(
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
          logger.warn(
            "schema-gen",
            () => `JSDoc conflict for property '${propName}'; using first doc`,
          );
        }
      }
      properties[propName] = generated;
    }

    const schema: JSONSchemaObjMutable = { type: "object", properties };

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
          logger.warn(
            "schema-gen",
            () => "JSDoc conflict for index signatures; using first doc",
          );
        }
      }
      (schema as Record<string, unknown>).additionalProperties =
        apSchema as JSONSchemaObjMutable;
    }
    if (required.length > 0) schema.required = required;

    return schema;
  }

  private lookupBuiltInSchema(
    type: ts.Type,
    checker: ts.TypeChecker,
  ): JSONSchemaMutable | undefined {
    const builtin = getNativeTypeSchema(type, checker);
    return builtin === undefined ? undefined : cloneSchemaDefinition(builtin);
  }
}
