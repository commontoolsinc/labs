import ts from "typescript";
import { isRecord } from "@commontools/utils/types";

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
import { extractDocFromType } from "./doc-utils.ts";

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
      emittedRefs: new Set(),
      anonymousNames: new WeakMap(),
      anonymousNameCounter: 0,

      // Stack state
      definitionStack: new Set(),
      inProgressNames: new Set(),

      // Optional context
      ...(typeNode && { typeNode }),
    };

    // Generate the root schema
    let rootSchema = this.formatType(type, context, true);

    // Attach root-level description from JSDoc if available
    rootSchema = this.attachRootDescription(rootSchema, type, context);

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
   * Create a stack key that distinguishes erased wrapper types from their
   * inner types
   */
  private createStackKey(
    type: ts.Type,
    typeNode?: ts.TypeNode,
    checker?: ts.TypeChecker,
  ): string | ts.Type {
    // Handle Default types (both direct and aliased) with enhanced keys to
    // avoid false cycles
    if (typeNode && ts.isTypeReferenceNode(typeNode)) {
      const isDirectDefault = ts.isIdentifier(typeNode.typeName) &&
        typeNode.typeName.text === "Default";
      const isAliasedDefault = checker && isDefaultTypeRef(typeNode, checker);

      if (isDirectDefault || isAliasedDefault) {
        // Create a more specific key that includes type argument info to
        // avoid false cycles
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

  private ensureSyntheticName(
    type: ts.Type,
    context: GenerationContext,
  ): string {
    const existing = context.anonymousNames.get(type);
    if (existing) return existing;
    const synthetic = `AnonymousType_${++context.anonymousNameCounter}`;
    context.anonymousNames.set(type, synthetic);
    return synthetic;
  }

  /**
   * Format a type using the appropriate formatter
   */
  private formatType(
    type: ts.Type,
    context: GenerationContext,
    isRootType: boolean = false,
  ): SchemaDefinition {
    if ((type.flags & ts.TypeFlags.TypeParameter) !== 0) {
      const checker = context.typeChecker;
      const baseConstraint = checker.getBaseConstraintOfType(type);
      if (baseConstraint && baseConstraint !== type) {
        return this.formatType(baseConstraint, context, isRootType);
      }
      const defaultConstraint = checker.getDefaultFromTypeParameter?.(type);
      if (defaultConstraint && defaultConstraint !== type) {
        return this.formatType(defaultConstraint, context, isRootType);
      }
      return {};
    }

    // All-named strategy:
    // Hoist every named type (excluding wrappers filtered by getNamedTypeKey)
    // into definitions and return $ref for non-root uses. Cycle detection
    // still applies via definitionStack.
    let namedKey = getNamedTypeKey(type);
    if (!namedKey) {
      const synthetic = context.anonymousNames.get(type);
      if (synthetic) namedKey = synthetic;
    }
    if (namedKey) {
      if (
        context.inProgressNames.has(namedKey) || context.definitions[namedKey]
      ) {
        // Already being built or exists: emit a ref
        context.emittedRefs.add(namedKey);
        context.definitionStack.delete(
          this.createStackKey(type, context.typeNode, context.typeChecker),
        );
        return { "$ref": `#/definitions/${namedKey}` };
      }
      // Start building this named type; we'll store the result below
      context.inProgressNames.add(namedKey);
    }

    // Cycle detection: if we see the same type again by identity, emit a $ref
    const stackKey = this.createStackKey(
      type,
      context.typeNode,
      context.typeChecker,
    );
    if (context.definitionStack.has(stackKey)) {
      if (namedKey) {
        context.emittedRefs.add(namedKey);
        return { "$ref": `#/definitions/${namedKey}` };
      }
      const syntheticKey = this.ensureSyntheticName(type, context);
      context.inProgressNames.add(syntheticKey);
      context.emittedRefs.add(syntheticKey);
      return { "$ref": `#/definitions/${syntheticKey}` };
    }

    // Push current type onto the stack
    context.definitionStack.add(
      this.createStackKey(type, context.typeNode, context.typeChecker),
    );

    // Try to find a formatter that supports this type
    for (const formatter of this.formatters) {
      if (formatter.supportsType(type, context)) {
        const result = formatter.formatType(type, context);

        // If this is a named type (all-named policy), store in definitions.
        const keyForDef = namedKey ?? context.anonymousNames.get(type);
        if (keyForDef) {
          context.definitions[keyForDef] = result;
          context.inProgressNames.delete(keyForDef);
          context.definitionStack.delete(
            this.createStackKey(type, context.typeNode, context.typeChecker),
          );
          if (!isRootType) {
            context.emittedRefs.add(keyForDef);
            return { "$ref": `#/definitions/${keyForDef}` };
          }
          // For root, keep inline; buildFinalSchema may promote if we choose
        }
        // Pop after formatting
        context.definitionStack.delete(
          this.createStackKey(type, context.typeNode, context.typeChecker),
        );
        return result;
      }
    }

    // If no formatter supports this type, this is an error - we should have
    // complete coverage
    context.definitionStack.delete(
      this.createStackKey(type, context.typeNode, context.typeChecker),
    );

    const typeName = context.typeChecker.typeToString(type);
    const typeFlags = type.flags;
    throw new Error(
      `No formatter found for type: ${typeName} (flags: ${typeFlags}). ` +
        "This indicates incomplete formatter coverage - every TypeScript " +
        "type should be handled by a formatter.",
    );
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
    const { definitions, emittedRefs } = context;

    // If no definitions were created or used, return simple schema
    if (Object.keys(definitions).length === 0 || emittedRefs.size === 0) {
      return rootSchema;
    }

    // Decide if we promote root to a $ref
    const namedKey = getNamedTypeKey(type) ?? context.anonymousNames.get(type);
    const shouldPromoteRoot = this.shouldPromoteToRef(namedKey, context);

    let base: SchemaDefinition;

    if (shouldPromoteRoot && namedKey) {
      // Ensure root is present in definitions
      if (!definitions[namedKey]) {
        definitions[namedKey] = rootSchema;
      }
      base = { $ref: `#/definitions/${namedKey}` } as SchemaDefinition;
    } else {
      base = rootSchema;
    }

    // Handle boolean schemas (rare, but supported by JSON Schema)
    if (typeof base === "boolean") {
      return base ? { $schema: "https://json-schema.org/draft-07/schema#" } : {
        $schema: "https://json-schema.org/draft-07/schema#",
        not: true,
      };
    }

    // Object schema: attach only the definitions actually referenced by the
    // final output
    const filtered = this.collectReferencedDefinitions(base, definitions);
    const out: Record<string, unknown> = {
      $schema: "https://json-schema.org/draft-07/schema#",
      ...(base as Record<string, unknown>),
    };
    if (Object.keys(filtered).length > 0) out.definitions = filtered;
    return out as SchemaDefinition;
  }

  /**
   * Determine if root schema should be promoted to a $ref
   */
  private shouldPromoteToRef(
    namedKey: string | undefined,
    context: GenerationContext,
  ): boolean {
    if (!namedKey) return false;

    const { definitions, emittedRefs } = context;

    // If the root type already exists in definitions and has been referenced,
    // promote it
    return !!(definitions[namedKey] && emittedRefs.has(namedKey));
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
              const location: ts.Node = prop.valueDeclaration ??
                (prop.declarations?.[0] as ts.Declaration);
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

  /**
   * Attach a root-level description from JSDoc when the root schema does not
   * already supply one.
   */
  private attachRootDescription(
    schema: SchemaDefinition,
    type: ts.Type,
    context: GenerationContext,
  ): SchemaDefinition {
    if (typeof schema !== "object") return schema;

    const docInfo = extractDocFromType(type, context.typeChecker);
    if (docInfo.firstDoc && isRecord(schema) && !("description" in schema)) {
      (schema as Record<string, unknown>).description = docInfo.firstDoc;
    }
    return schema;
  }

  /**
   * Recursively scan a schema fragment to collect referenced definition names
   * and return the minimal subset of definitions required to resolve them,
   * including transitive dependencies.
   */
  private collectReferencedDefinitions(
    fragment: SchemaDefinition,
    allDefs: Record<string, SchemaDefinition>,
  ): Record<string, SchemaDefinition> {
    const needed = new Set<string>();
    const visited = new Set<string>();

    const enqueueFromRef = (ref: string) => {
      const prefix = "#/definitions/";
      if (typeof ref === "string" && ref.startsWith(prefix)) {
        const name = ref.slice(prefix.length);
        if (name) needed.add(name);
      }
    };

    const scan = (node: unknown) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        for (const item of node) scan(item);
        return;
      }
      const obj = node as Record<string, unknown>;
      for (const [k, v] of Object.entries(obj)) {
        if (k === "$ref" && typeof v === "string") enqueueFromRef(v);
        // Skip descending into existing definitions blocks to avoid pulling in
        // already-attached subsets recursively
        if (k === "definitions") continue;
        scan(v);
      }
    };

    // Find initial set of needed names from the fragment
    scan(fragment);

    // Compute transitive closure by following refs inside included definitions
    const stack: string[] = Array.from(needed);
    while (stack.length > 0) {
      const name = stack.pop()!;
      if (visited.has(name)) continue;
      visited.add(name);
      const def = allDefs[name];
      if (!def) continue;
      // Scan definition body for further refs
      scan(def);
      for (const n of Array.from(needed)) {
        if (!visited.has(n)) {
          // Only push newly discovered names
          if (!stack.includes(n)) stack.push(n);
        }
      }
    }

    // Build the subset map
    const subset: Record<string, SchemaDefinition> = {};
    for (const name of visited) {
      if (allDefs[name]) subset[name] = allDefs[name];
    }
    return subset;
  }
}
