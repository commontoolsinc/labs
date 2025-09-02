import ts from "typescript";
import type {
  FormatterContext,
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
import { getNamedTypeKey, getStableTypeName } from "./type-utils.ts";

/**
 * Main schema generator that uses a chain of formatters
 */
export class SchemaGenerator implements ISchemaGenerator {
  private activeContext: {
    definitions: Record<string, SchemaDefinition>;
    cyclicTypes: Set<ts.Type>;
    cyclicNames: Set<string>;
    seenTypes: Set<ts.Type>;
    inProgressNames: Set<string>;
    emittedRefs: Set<string>;
    definitionStack: Set<ts.Type>;
    inlineSchemas: Map<string, SchemaDefinition>;
    definitionOrder: string[];
  } | undefined;
  private formatters: TypeFormatter[] = [
    new CommonToolsFormatter(this), // Pass self-reference for recursive delegation
    new UnionFormatter(this),
    new IntersectionFormatter(this),
    new PrimitiveFormatter(),
    // Handle arrays before generic object handling to avoid misclassification
    new ArrayFormatter(this),
    new ObjectFormatter(this), // Pass self-reference for recursive delegation
    // TODO(#CT-841): Add more formatters here
  ];

  /**
   * Generate JSON Schema for a TypeScript type
   */
  generateSchema(
    type: ts.Type,
    checker: ts.TypeChecker,
    typeNode?: ts.TypeNode,
  ): SchemaDefinition {
    const isRoot = !this.activeContext;
    if (isRoot) {
      this.activeContext = {
        definitions: {},
        cyclicTypes: this.getCycles(type, checker).types,
        cyclicNames: this.getCycles(type, checker).names,
        seenTypes: new Set<ts.Type>(),
        inProgressNames: new Set<string>(),
        emittedRefs: new Set<string>(),
        definitionStack: new Set<ts.Type>(),
        inlineSchemas: new Map<string, SchemaDefinition>(),
        definitionOrder: [],
      };
    }

    const {
      definitions,
      cyclicTypes,
      cyclicNames,
      seenTypes,
      inProgressNames,
      emittedRefs,
      definitionStack,
      inlineSchemas,
      definitionOrder,
    } = this.activeContext!;

    const context: FormatterContext = {
      rootSchema: {} as SchemaDefinition,
      seenTypes,
      typeChecker: checker,
      depth: 0,
      maxDepth: 200,
      definitions,
      definitionStack,
      inProgressNames,
      emittedRefs,
    };

    const rootSchema = this.formatType(
      type,
      context,
      typeNode,
      0,
      seenTypes,
      cyclicTypes,
      cyclicNames,
      definitions,
      definitionStack,
      true,
      inProgressNames,
      emittedRefs,
    );

    // If the root is named and either participates in a cycle OR we emitted a $ref
    // to it anywhere within, promote the root to a top-level $ref and attach defs.
    if (isRoot) {
      let rootName = getNamedTypeKey(type);
      if (!rootName && typeNode && ts.isTypeReferenceNode(typeNode)) {
        const tn = typeNode.typeName;
        if (ts.isIdentifier(tn)) rootName = tn.text;
      }
      if (
        rootName &&
        (cyclicTypes.has(type) || cyclicNames.has(rootName) ||
          this.activeContext!.emittedRefs.has(rootName) ||
          Object.keys(definitions).length > 0)
      ) {
        definitions[rootName] = rootSchema;
        if (!this.activeContext!.definitionOrder.includes(rootName)) {
          this.activeContext!.definitionOrder.push(rootName);
        }
        const ordered: Record<string, SchemaDefinition> = {};
        for (const k of this.activeContext!.definitionOrder) {
          if (definitions[k]) ordered[k] = definitions[k];
        }
        const out = {
          "$ref": `#/definitions/${rootName}`,
          "$schema": "http://json-schema.org/draft-07/schema#",
          "definitions": ordered,
        } as SchemaDefinition;
        this.activeContext = undefined;
        return out;
      }
    }

    // If we have any definitions, attach them to the root schema
    if (
      isRoot && this.activeContext && this.activeContext.emittedRefs.size > 0 &&
      Object.keys(definitions).length > 0
    ) {
      const ordered: Record<string, SchemaDefinition> = {};
      for (const k of this.activeContext!.definitionOrder) {
        if (definitions[k]) ordered[k] = definitions[k];
      }
      const out = {
        ...rootSchema,
        "$schema": "http://json-schema.org/draft-07/schema#",
        "definitions": Object.keys(ordered).length ? ordered : definitions,
      } as SchemaDefinition;
      this.activeContext = undefined;
      return out;
    }

    // No cycles/definitions to attach
    if (isRoot) this.activeContext = undefined;
    return rootSchema;
  }

  /**
   * Format a nested/child type within the current active context. This preserves
   * definition/$ref behavior (including cycles) and ensures non-root usages can
   * return $ref where appropriate.
   */
  public formatChildType(
    type: ts.Type,
    checker: ts.TypeChecker,
    typeNode?: ts.TypeNode,
  ): SchemaDefinition {
    if (!this.activeContext) {
      // Fallback to full generate if no context yet
      return this.generateSchema(type, checker, typeNode);
    }
    const {
      definitions,
      cyclicTypes,
      cyclicNames,
      seenTypes,
      inProgressNames,
      emittedRefs,
      definitionStack,
    } = this.activeContext;

    return this.formatType(
      type,
      {
        rootSchema: {} as SchemaDefinition,
        seenTypes,
        typeChecker: checker,
        depth: 0,
        maxDepth: 200,
        definitions,
        definitionStack,
        inProgressNames,
        emittedRefs,
        typeNode: typeNode!,
      },
      typeNode,
      0,
      seenTypes,
      cyclicTypes,
      cyclicNames,
      definitions,
      definitionStack,
      false,
      inProgressNames,
      emittedRefs,
    );
  }

  /**
   * Format a type using the appropriate formatter
   */
  private formatType(
    type: ts.Type,
    context: FormatterContext,
    typeNode?: ts.TypeNode,
    depth: number = 0,
    seenTypes: Set<ts.Type> = new Set(),
    cyclicTypes?: Set<ts.Type>,
    cyclicNames?: Set<string>,
    definitions?: Record<string, SchemaDefinition>,
    definitionStack: Set<ts.Type> = new Set(),
    isRootType: boolean = false,
    inProgressNames: Set<string> = new Set(),
    emittedRefs: Set<string> = new Set(),
  ): SchemaDefinition {
    // Early named-type handling for named types (wrappers/anonymous filtered)
    const inCycle = !!(cyclicTypes && cyclicTypes.has(type));
    const namedKey = definitions ? getNamedTypeKey(type) : undefined;
    const inCycleByName =
      !!(namedKey && cyclicNames && cyclicNames.has(namedKey));
    if (namedKey && definitions && (inCycle || inCycleByName)) {
      if (inProgressNames.has(namedKey) || definitions[namedKey]) {
        emittedRefs.add(namedKey);
        definitionStack.delete(type);
        return { "$ref": `#/definitions/${namedKey}` };
      }
      // Mark as in-progress but delay writing definition until filled to preserve post-order
      inProgressNames.add(namedKey);
    }

    // Cycle detection: if we see the same type again by identity, emit a $ref
    if (definitionStack.has(type)) {
      if (definitions) {
        const defName = getNamedTypeKey(type);
        if (defName) {
          emittedRefs.add(defName);
          return { "$ref": `#/definitions/${defName}` };
        }
      }
      return { type: "object", additionalProperties: true };
    }

    // Push current type onto the stack
    definitionStack.add(type);
    if (depth > 200) {
      const nk = definitions ? getNamedTypeKey(type) : undefined;
      if (nk && definitions) {
        if (!definitions[nk]) {
          definitions[nk] = { type: "object", properties: {} };
        }
        emittedRefs.add(nk);
        return { "$ref": `#/definitions/${nk}` };
      }
      return { type: "object", additionalProperties: true };
    }

    // Check if this is an array type node first (most reliable way)
    if (typeNode && ts.isArrayTypeNode(typeNode)) {
      // Extract the element type and recursively generate its schema
      const elementType = context.typeChecker.getTypeFromTypeNode(
        typeNode.elementType,
      );
      if (elementType) {
        const elementSchema = this.formatType(
          elementType,
          context,
          typeNode.elementType,
          depth + 1,
          seenTypes,
          cyclicTypes,
          cyclicNames,
          definitions,
          definitionStack,
          false,
          inProgressNames,
          emittedRefs,
        );

        return {
          type: "array",
          items: elementSchema,
        };
      }
    }

    // Try to find a formatter that supports this type
    for (const formatter of this.formatters) {
      if (formatter.supportsType(type, context)) {
        // Special handling for ArrayFormatter - we need to extract element type
        if (formatter.constructor.name === "ArrayFormatter") {
          // For Array<T> types, try to extract the type argument
          if (type.flags & ts.TypeFlags.Object) {
            const objectType = type as ts.ObjectType;
            if (objectType.objectFlags & ts.ObjectFlags.Reference) {
              const typeRef = objectType as ts.TypeReference;
              if (typeRef.typeArguments && typeRef.typeArguments.length > 0) {
                // Extract the first type argument (Array<T> -> T)
                const elementType = typeRef.typeArguments[0];
                if (elementType) {
                  const elementSchema = this.formatType(
                    elementType,
                    context,
                    undefined,
                    depth + 1,
                    seenTypes,
                    cyclicTypes,
                    cyclicNames,
                    definitions,
                    definitionStack,
                    false,
                    inProgressNames,
                    emittedRefs,
                  );

                  return {
                    type: "array",
                    items: elementSchema,
                  };
                }
              }
            }
          }

          // For T[] types, try to get the numeric index type
          const indexType = context.typeChecker.getIndexTypeOfType(
            type,
            ts.IndexKind.Number,
          );
          if (indexType) {
            const elementSchema = this.formatType(
              indexType,
              context,
              undefined,
              depth + 1,
              seenTypes,
              cyclicTypes,
              cyclicNames,
              definitions,
              definitionStack,
              false,
              inProgressNames,
              emittedRefs,
            );

            return {
              type: "array",
              items: elementSchema,
            };
          }
        }

        // Update context to include typeNode for formatters that need it
        const updatedContext = typeNode ? { ...context, typeNode } : context;
        const result = formatter.formatType(type, updatedContext);
        // Do not promote non-cyclic named types into definitions by default.
        // Rely on cycle detection to introduce $ref/$definitions only when
        // necessary to satisfy recursion.
        // If we seeded a named placeholder, fill it and return $ref for non-root
        if (namedKey && definitions && (inCycle || inCycleByName)) {
          // Finish cyclic def
          definitions[namedKey] = result;
          if (
            this.activeContext &&
            !this.activeContext.definitionOrder.includes(namedKey)
          ) {
            this.activeContext.definitionOrder.push(namedKey);
          }
          inProgressNames.delete(namedKey);
          definitionStack.delete(type);
          if (!isRootType) {
            emittedRefs.add(namedKey);
            return { "$ref": `#/definitions/${namedKey}` };
          }
        }
        // Pop after formatting
        definitionStack.delete(type);
        return result;
      }
    }

    // If no formatter supports this type, return a fallback
    definitionStack.delete(type);
    return { type: "object", additionalProperties: true };
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

    const visit = (t: ts.Type, depth: number) => {
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
            visit(mt, depth + 1);
          }
        } else if (flags & ts.TypeFlags.Object) {
          const obj = t as ts.ObjectType;
          // Traverse properties
          if (checker) {
            for (const prop of checker.getPropertiesOfType(t)) {
              try {
                const pt = checker.getTypeOfSymbolAtLocation(
                  prop,
                  prop.valueDeclaration ?? (prop.declarations?.[0] as any),
                );
                if (pt) visit(pt, depth + 1);
              } catch (_) {
                // ignore
              }
            }
            // Traverse numeric index (arrays/tuples)
            try {
              const idx = checker.getIndexTypeOfType(t, ts.IndexKind.Number);
              if (idx) visit(idx, depth + 1);
            } catch (_) {
              // ignore
            }
          }
        }
      } finally {
        stack.pop();
        visiting.delete(t);
      }
    };

    if (checker) visit(type, 0);
    return { types: cycles, names: cycleNames };
  }
}
