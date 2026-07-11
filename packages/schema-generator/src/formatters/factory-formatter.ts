import ts from "typescript";
import type {
  JSONSchemaMutable,
  JSONSchemaObjMutable,
} from "@commonfabric/api";
import type { GenerationContext, TypeFormatter } from "../interface.ts";
import type { SchemaGenerator } from "../schema-generator.ts";
import { getCellWrapperInfo } from "../typescript/cell-brand.ts";
import type { TypeWithInternals } from "../type-utils.ts";

export type FactoryTypeKind = "pattern" | "module" | "handler";

export interface FactoryTypeInfo {
  readonly kind: FactoryTypeKind;
  readonly inputType: ts.Type;
  readonly outputType: ts.Type;
}

const FACTORY_ALIAS_KINDS: Readonly<Record<string, FactoryTypeKind>> = {
  PatternFactory: "pattern",
  ModuleFactory: "module",
  HandlerFactory: "handler",
};

function hasFabricFactoryBrand(
  type: ts.Type,
  checker: ts.TypeChecker,
): boolean {
  return checker.getPropertiesOfType(type).some((property) =>
    property.getName().startsWith("__@FABRIC_FACTORY_TYPE")
  );
}

function hasProperty(
  type: ts.Type,
  checker: ts.TypeChecker,
  name: string,
): boolean {
  return checker.getPropertyOfType(type, name) !== undefined;
}

function detectFactoryKind(
  type: ts.Type,
  checker: ts.TypeChecker,
): FactoryTypeKind | undefined {
  // A union remains a stored union. UnionFormatter must retain every arm as
  // `anyOf`; invocation compatibility is a transformer concern.
  if ((type.flags & ts.TypeFlags.Union) !== 0) return undefined;

  const aliasName = (type as TypeWithInternals).aliasSymbol?.name;
  const namedKind = aliasName === undefined
    ? undefined
    : FACTORY_ALIAS_KINDS[aliasName];

  // Direct public aliases are authoritative. Alias and branded-intersection
  // spellings lose the public alias name, so recognize those by the private
  // FabricFactory brand plus the stable public factory surface.
  if (namedKind !== undefined) return namedKind;
  if (!hasFabricFactoryBrand(type, checker)) return undefined;

  if (
    hasProperty(type, checker, "argumentSchema") &&
    hasProperty(type, checker, "resultSchema")
  ) {
    return "pattern";
  }
  if (hasProperty(type, checker, "with")) return "handler";
  if (hasProperty(type, checker, "type")) return "module";
  return undefined;
}

function unwrapFactoryInput(type: ts.Type): ts.Type {
  const alias = type as TypeWithInternals;
  if (
    alias.aliasSymbol?.name === "FactoryInput" &&
    alias.aliasTypeArguments?.[0]
  ) {
    return alias.aliasTypeArguments[0];
  }
  return type;
}

function unwrapHandlerEvent(
  type: ts.Type,
  checker: ts.TypeChecker,
): ts.Type | undefined {
  const wrapper = getCellWrapperInfo(type, checker);
  if (wrapper?.kind !== "Stream") return undefined;
  const args = wrapper.typeRef.typeArguments ??
    checker.getTypeArguments(wrapper.typeRef);
  return args[0];
}

/**
 * Detect a first-class public factory and recover its effective call schema
 * types. Call signatures are used after kind detection so aliases and branded
 * intersections retain the concrete substitutions TypeScript already made.
 */
export function detectFactoryType(
  type: ts.Type,
  checker: ts.TypeChecker,
): FactoryTypeInfo | undefined {
  const kind = detectFactoryKind(type, checker);
  if (kind === undefined) return undefined;

  const signature = type.getCallSignatures()[0];
  const parameter = signature?.parameters[0];
  if (!signature || !parameter) return undefined;

  const inputType = unwrapFactoryInput(checker.getTypeOfSymbol(parameter));
  const callResult = signature.getReturnType();
  const outputType = kind === "handler"
    ? unwrapHandlerEvent(callResult, checker)
    : callResult;
  if (!outputType) return undefined;

  return { kind, inputType, outputType };
}

/** True when a stored value type is a factory or a union containing one. */
export function containsFactoryType(
  type: ts.Type,
  checker: ts.TypeChecker,
): boolean {
  if ((type.flags & ts.TypeFlags.Union) !== 0) {
    return (type as ts.UnionType).types.some((member) =>
      containsFactoryType(member, checker)
    );
  }
  return detectFactoryType(type, checker) !== undefined;
}

/** Formats PatternFactory, ModuleFactory, and HandlerFactory values. */
export class FactoryFormatter implements TypeFormatter {
  constructor(private readonly schemaGenerator: SchemaGenerator) {}

  supportsType(type: ts.Type, context: GenerationContext): boolean {
    return detectFactoryType(type, context.typeChecker) !== undefined;
  }

  formatType(
    type: ts.Type,
    context: GenerationContext,
  ): JSONSchemaMutable {
    const factory = detectFactoryType(type, context.typeChecker);
    if (!factory) {
      throw new Error("FactoryFormatter received a non-factory type");
    }

    // Each carried public schema is an independently comparable document.
    // Generate it in a fresh schema context so any $ref has its own $defs
    // rather than borrowing definitions from the containing value schema.
    const inputSchema = this.schemaGenerator.generateSchema(
      factory.inputType,
      context.typeChecker,
    );
    const outputSchema = this.schemaGenerator.generateSchema(
      factory.outputType,
      context.typeChecker,
    );

    const asFactory = factory.kind === "handler"
      ? {
        kind: "handler" as const,
        contextSchema: inputSchema,
        eventSchema: outputSchema,
      }
      : {
        kind: factory.kind,
        argumentSchema: inputSchema,
        resultSchema: outputSchema,
      };

    return { asFactory } as JSONSchemaObjMutable;
  }
}
