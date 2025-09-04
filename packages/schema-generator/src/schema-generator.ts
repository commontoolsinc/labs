import ts from "typescript";
import type {
  GenerationContext,
  SchemaDefinition,
  SchemaGenerator as ISchemaGenerator,
  TypeFormatter,
} from "./interface.ts";
import { PrimitiveFormatter } from "./formatters/primitive-formatter.ts";
import { ObjectFormatter } from "./formatters/object-formatter.ts";
import { ArrayFormatter } from "./formatters/array-formatter.ts";
import { CommonToolsFormatter } from "./formatters/common-tools-formatter.ts";
import { UnionFormatter } from "./formatters/union-formatter.ts";
import { IntersectionFormatter } from "./formatters/intersection-formatter.ts";
import {
  getNamedTypeKey,
  isDefaultTypeRef,
  safeGetIndexTypeOfType,
  safeGetTypeOfSymbolAtLocation,
} from "./type-utils.ts";

/**
 * Main schema generator that uses a chain of formatters
 */
export class SchemaGenerator implements ISchemaGenerator {
  private formatters: TypeFormatter[] = [
    new CommonToolsFormatter(this),
    new UnionFormatter(this),
    new IntersectionFormatter(this),
    // Prefer array detection before primitives to avoid Any-flag misrouting
    new ArrayFormatter(this),
    new PrimitiveFormatter(),
    new ObjectFormatter(this),
  ];

  /**
   * Generate JSON Schema for a TypeScript type
   */
  generateSchema(
    type: ts.Type,
    checker: ts.TypeChecker,
    typeNode?: ts.TypeNode,
  ): SchemaDefinition {
    // Create unified context with all state
    const cycles = this.getCycles(type, checker);
    const context: GenerationContext = {
      // Immutable context
      typeChecker: checker,
      cyclicTypes: cycles.types,
      cyclicNames: cycles.names,

      // Accumulating state
      definitions: {},
      definitionOrder: [],
      emittedRefs: new Set(),

      // Stack state
      definitionStack: new Set(),
      inProgressNames: new Set(),

      // Optional context
      ...(typeNode && { typeNode }),
    };

    // Generate the root schema
    const rootSchema = this.formatType(type, context, true);

    // Build final schema with definitions if needed
    return this.buildFinalSchema(rootSchema, type, context, typeNode);
  }

  /**
   * Format a nested/child type within the current active context. This preserves
   * definition/$ref behavior (including cycles) and ensures non-root usages can
   * return $ref where appropriate.
   */
  public formatChildType(
    type: ts.Type,
    context: GenerationContext,
    typeNode?: ts.TypeNode,
  ): SchemaDefinition {
    const childContext = typeNode ? { ...context, typeNode } : context;
    return this.formatType(type, childContext, false);
  }

  /**
   * Create a stack key that distinguishes erased wrapper types from their inner types
   */
  private createStackKey(
    type: ts.Type,
    typeNode?: ts.TypeNode,
    checker?: ts.TypeChecker,
  ): any {
    // Handle Default types (both direct and aliased) with enhanced keys to avoid false cycles
    if (typeNode && ts.isTypeReferenceNode(typeNode)) {
      const isDirectDefault = ts.isIdentifier(typeNode.typeName) &&
        typeNode.typeName.text === "Default";
      const isAliasedDefault = checker && isDefaultTypeRef(typeNode, checker);

      if (isDirectDefault || isAliasedDefault) {
        // Create a more specific key that includes type argument info to avoid false cycles
        const argTexts = typeNode.typeArguments
          ? typeNode.typeArguments.map((arg) => arg.getText()).join(",")
          : "";
        // Include a source location hash to further distinguish instances
        const locationHash = typeNode.getSourceFile?.()?.fileName || "";
        const position = typeNode.pos || 0;
        return `Default_${type.flags}_${argTexts}_${locationHash}_${position}`;
      }
    }
    return type;
  }

  private removeFromDefinitionStack(
    definitionStack: Set<any>,
    type: ts.Type,
    typeNode?: ts.TypeNode,
    checker?: ts.TypeChecker,
  ) {
    const key = this.createStackKey(type, typeNode, checker);
    definitionStack.delete(key);
  }

  /**
   * Format a type using the appropriate formatter
   */
  private formatType(
    type: ts.Type,
    context: GenerationContext,
    isRootType: boolean = false,
  ): SchemaDefinition {
    const {
      cyclicTypes,
      cyclicNames,
      definitions,
      definitionStack,
      inProgressNames,
      emittedRefs,
      typeNode,
    } = context;

    // Early named-type handling for named types (wrappers/anonymous filtered)
    const inCycle = cyclicTypes.has(type);
    const namedKey = getNamedTypeKey(type);
    const inCycleByName = !!(namedKey && cyclicNames.has(namedKey));


    if (namedKey && (inCycle || inCycleByName)) {
      if (inProgressNames.has(namedKey) || definitions[namedKey]) {
        emittedRefs.add(namedKey);
        this.removeFromDefinitionStack(
          definitionStack,
          type,
          typeNode,
          context.typeChecker,
        );
        return { "$ref": `#/definitions/${namedKey}` };
      }
      // Mark as in-progress but delay writing definition until filled to preserve post-order
      inProgressNames.add(namedKey);
    }

    // Cycle detection: if we see the same type again by identity, emit a $ref
    const stackKey = this.createStackKey(type, typeNode, context.typeChecker);
    if (definitionStack.has(stackKey)) {
      if (namedKey) {
        emittedRefs.add(namedKey);
        return { "$ref": `#/definitions/${namedKey}` };
      }
      return { type: "object", additionalProperties: true };
    }

    // Push current type onto the stack
    definitionStack.add(this.createStackKey(type, typeNode, context.typeChecker));

    // Try to find a formatter that supports this type
    for (const formatter of this.formatters) {
      if (formatter.supportsType(type, context)) {
        const result = formatter.formatType(type, context);

        // If we seeded a named placeholder, fill it and return $ref for non-root
        if (namedKey && (inCycle || inCycleByName)) {
          // Finish cyclic def
          definitions[namedKey] = result;
          if (!context.definitionOrder.includes(namedKey)) {
            context.definitionOrder.push(namedKey);
          }
          inProgressNames.delete(namedKey);
          this.removeFromDefinitionStack(
            definitionStack,
            type,
            typeNode,
            context.typeChecker,
          );
          if (!isRootType) {
            emittedRefs.add(namedKey);
            return { "$ref": `#/definitions/${namedKey}` };
          }
        }
        // Pop after formatting
        this.removeFromDefinitionStack(
          definitionStack,
          type,
          typeNode,
          context.typeChecker,
        );
        return result;
      }
    }

    // If no formatter supports this type, return a fallback
    this.removeFromDefinitionStack(
      definitionStack,
      type,
      typeNode,
      context.typeChecker,
    );
    return { type: "object", additionalProperties: true };
  }

  /**
   * Build the final schema with definitions if needed
   */
  private buildFinalSchema(
    rootSchema: SchemaDefinition,
    type: ts.Type,
    context: GenerationContext,
    typeNode?: ts.TypeNode,
  ): SchemaDefinition {
    const { definitions, emittedRefs, definitionOrder } = context;

    // If no definitions were created or used, return simple schema
    if (Object.keys(definitions).length === 0 || emittedRefs.size === 0) {
      return rootSchema;
    }

    // Check if root schema should be promoted to a definition
    const namedKey = getNamedTypeKey(type);
    const shouldPromoteRoot = this.shouldPromoteToRef(
      rootSchema,
      namedKey,
      context,
    );

    if (shouldPromoteRoot && namedKey) {
      // Add root schema to definitions if not already there
      if (!definitions[namedKey]) {
        definitions[namedKey] = rootSchema;
        if (!definitionOrder.includes(namedKey)) {
          definitionOrder.push(namedKey);
        }
      }

      // Return schema with $ref to root and definitions
      return {
        $schema: "https://json-schema.org/draft-07/schema#",
        $ref: `#/definitions/${namedKey}`,
        definitions: this.orderDefinitions(definitions, definitionOrder),
      };
    }

    // Return root schema with definitions
    return {
      $schema: "https://json-schema.org/draft-07/schema#",
      ...rootSchema,
      definitions: this.orderDefinitions(definitions, definitionOrder),
    };
  }

  /**
   * Determine if root schema should be promoted to a $ref
   */
  private shouldPromoteToRef(
    rootSchema: SchemaDefinition,
    namedKey: string | undefined,
    context: GenerationContext,
  ): boolean {
    if (!namedKey) return false;

    const { definitions, emittedRefs } = context;

    // If the root type already exists in definitions and has been referenced, promote it
    if (definitions[namedKey] && emittedRefs.has(namedKey)) {
      return true;
    }

    // Don't promote simple schemas to refs
    if (this.isSimpleSchema(rootSchema)) {
      return false;
    }

    return false;
  }

  /**
   * Check if a schema is simple enough to not warrant promotion to $ref
   */
  private isSimpleSchema(schema: SchemaDefinition): boolean {
    // Simple primitive types
    if (
      schema.type && !schema.properties && !schema.items &&
      !schema.additionalProperties
    ) {
      return true;
    }

    // Empty objects with just additionalProperties
    if (
      schema.type === "object" && !schema.properties &&
      schema.additionalProperties === true
    ) {
      return true;
    }

    return false;
  }

  /**
   * Order definitions according to creation order
   */
  private orderDefinitions(
    definitions: Record<string, SchemaDefinition>,
    definitionOrder: string[],
  ): Record<string, SchemaDefinition> {
    const ordered: Record<string, SchemaDefinition> = {};

    // Add definitions in creation order
    for (const key of definitionOrder) {
      if (definitions[key]) {
        ordered[key] = definitions[key];
      }
    }

    // Add any remaining definitions (shouldn't happen, but safety net)
    for (const [key, value] of Object.entries(definitions)) {
      if (!ordered[key]) {
        ordered[key] = value;
      }
    }

    return ordered;
  }

  /**
   * Detect cycles in the type graph
   */
  private getCycles(
    type: ts.Type,
    checker?: ts.TypeChecker,
  ): { types: Set<ts.Type>; names: Set<string> } {
    // Identity and name-based DFS cycle detection
    const visiting = new Set<ts.Type>();
    const stack: ts.Type[] = [];
    const cycles = new Set<ts.Type>();
    const cycleNames = new Set<string>();

    const visit = (t: ts.Type) => {
      if (visiting.has(t)) {
        // Mark all nodes from the first occurrence of t on the stack to the end
        const idx = stack.lastIndexOf(t);
        if (idx >= 0) {
          for (let i = idx; i < stack.length; i++) {
            const tt = stack[i]!;
            cycles.add(tt);
            const nk = getNamedTypeKey(tt);
            if (nk) cycleNames.add(nk);
          }
        } else {
          cycles.add(t);
          const nk = getNamedTypeKey(t);
          if (nk) cycleNames.add(nk);
        }
        return;
      }
      visiting.add(t);
      stack.push(t);

      const flags = t.flags;
      try {
        if (flags & ts.TypeFlags.Union) {
          const ut = t as ts.UnionType;
          for (const mt of ut.types) {
            visit(mt);
          }
        } else if (flags & ts.TypeFlags.Object) {
          const obj = t as ts.ObjectType;
          // Traverse properties
          if (checker) {
            for (const prop of checker.getPropertiesOfType(t)) {
              const location = prop.valueDeclaration ??
                (prop.declarations?.[0] as any);
              const pt = safeGetTypeOfSymbolAtLocation(
                checker,
                prop,
                location,
                "cycle detection property",
              );
              if (pt) visit(pt);
            }
            // Traverse numeric index (arrays/tuples)
            const idx = safeGetIndexTypeOfType(
              checker,
              t,
              ts.IndexKind.Number,
              "cycle detection numeric index",
            );
            if (idx) visit(idx);
          }
        }
      } finally {
        stack.pop();
        visiting.delete(t);
      }
    };

    if (checker) visit(type);
    return { types: cycles, names: cycleNames };
  }
}
