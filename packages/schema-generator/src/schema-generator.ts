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
import { NativeTypeFormatter } from "./formatters/native-type-formatter.ts";
import { UnionFormatter } from "./formatters/union-formatter.ts";
import { IntersectionFormatter } from "./formatters/intersection-formatter.ts";
import {
  detectWrapperViaNode,
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
    new NativeTypeFormatter(this),
    new UnionFormatter(this),
    new IntersectionFormatter(this),
    // Prefer array detection before primitives to avoid Any-flag misrouting
    new ArrayFormatter(this),
    new PrimitiveFormatter(),
    new ObjectFormatter(this),
  ];
  /** Synthetic names for anonymous recursive types */
  private anonymousNames: WeakMap<ts.Type, string> = new WeakMap();
  /** Counter to generate stable synthetic identifiers */
  private anonymousNameCounter: number = 0;

  /**
   * Generate JSON Schema for a TypeScript type.
   * AUTO-DETECTS whether to use type-based or node-based analysis.
   */
  generateSchema(
    type: ts.Type,
    checker: ts.TypeChecker,
    typeNode?: ts.TypeNode,
    options?: { widenLiterals?: boolean },
    schemaHints?: WeakMap<ts.Node, { items?: unknown }>,
  ): SchemaDefinition {
    return this.generateSchemaInternal(
      type,
      checker,
      typeNode,
      undefined,
      options,
      schemaHints,
    );
  }

  /**
   * Generate schema from a synthetic TypeNode that doesn't resolve to a proper Type.
   * Used by transformers that create synthetic type structures programmatically.
   *
   * This is now a simple wrapper around generateSchema that passes an 'any' type,
   * which triggers the auto-detection logic to use node-based analysis.
   */
  public generateSchemaFromSyntheticTypeNode(
    typeNode: ts.TypeNode,
    checker: ts.TypeChecker,
    typeRegistry?: WeakMap<ts.Node, ts.Type>,
    schemaHints?: WeakMap<ts.Node, { items?: unknown }>,
  ): SchemaDefinition {
    // Pass 'any' type with the typeNode - auto-detection will choose node-based analysis
    const anyType = checker.getAnyType();
    return this.generateSchemaInternal(
      anyType,
      checker,
      typeNode,
      typeRegistry,
      undefined,
      schemaHints,
    );
  }

  /**
   * Internal unified implementation for schema generation.
   * Handles both normal and synthetic type node cases, with optional typeRegistry.
   */
  private generateSchemaInternal(
    type: ts.Type,
    checker: ts.TypeChecker,
    typeNode?: ts.TypeNode,
    typeRegistry?: WeakMap<ts.Node, ts.Type>,
    options?: { widenLiterals?: boolean },
    schemaHints?: WeakMap<ts.Node, { items?: unknown }>,
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

      // Stack state
      definitionStack: new Set(),
      inProgressNames: new Set(),

      // Optional context
      ...(typeNode && { typeNode }),
      ...(typeRegistry && { typeRegistry }),
      ...(options?.widenLiterals && { widenLiterals: true }),
      ...(schemaHints && { schemaHints }),
    };

    // Auto-detect: Should we use node-based or type-based analysis?
    let rootSchema: SchemaDefinition;
    if (this.shouldUseNodeBasedAnalysis(type, typeNode, checker)) {
      // Use node-based analysis (for synthetic nodes or when type is unreliable)
      rootSchema = this.analyzeTypeNodeStructure(
        typeNode!,
        checker,
        context,
      );
      // Build final schema with $schema and $defs
      return this.buildFinalSchemaForSynthetic(rootSchema, context);
    }

    // Use type-based analysis (normal path)
    rootSchema = this.formatType(type, context, true);

    // Attach root-level description from JSDoc if available
    rootSchema = this.attachRootDescription(rootSchema, type, context);

    // Build final schema with definitions if needed
    return this.buildFinalSchema(rootSchema, type, context, typeNode);
  }

  /**
   * Determine if we should use node-based analysis instead of type-based.
   * This happens when the Type is unreliable (any/unknown) but we have a concrete TypeNode.
   *
   * When TypeScript widens a type to 'any' (e.g., for array element types or synthetic nodes),
   * the TypeNode structure is more reliable than the Type.
   *
   * EXCEPTION: Wrapper types (Default/Cell/Stream/OpaqueRef) erase to their inner type,
   * which may appear as 'any', but they should use type-based analysis because
   * CommonToolsFormatter handles them specially via typeNode context.
   */
  private shouldUseNodeBasedAnalysis(
    type: ts.Type,
    typeNode: ts.TypeNode | undefined,
    checker: ts.TypeChecker,
  ): boolean {
    if (!typeNode || !(type.flags & ts.TypeFlags.Any)) {
      return false;
    }

    // Check if this is a wrapper type - if so, use type-based analysis
    const wrapperKind = detectWrapperViaNode(typeNode, checker);
    if (wrapperKind) {
      return false;
    }

    return true;
  }

  /**
   * Format a nested/child type within the current active context. This preserves
   * definition/$ref behavior (including cycles) and ensures non-root usages can
   * return $ref where appropriate.
   *
   * AUTO-DETECTS whether to use type-based or node-based analysis.
   */
  public formatChildType(
    type: ts.Type,
    context: GenerationContext,
    typeNode?: ts.TypeNode,
  ): SchemaDefinition {
    // IMPORTANT: Always create a new context, replacing typeNode (even if undefined).
    // If we pass the parent context as-is when typeNode is undefined, the child will
    // inherit the parent's typeNode which leads to mismatched type/node pairs.
    const { typeNode: _, ...baseContext } = context;
    const childContext = typeNode ? { ...context, typeNode } : baseContext;

    // Auto-detect: Should we use node-based or type-based analysis?
    const useNodeBased = this.shouldUseNodeBasedAnalysis(
      type,
      typeNode,
      context.typeChecker,
    );
    if (useNodeBased) {
      // Use node-based analysis (for synthetic nodes or when type is unreliable)
      return this.analyzeTypeNodeStructure(
        typeNode!,
        context.typeChecker,
        childContext,
      );
    }

    // Use type-based analysis (normal path)
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
  ): string {
    const existing = this.anonymousNames.get(type);
    if (existing) return existing;
    const synthetic = `AnonymousType_${++this.anonymousNameCounter}`;
    this.anonymousNames.set(type, synthetic);
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

    // Handle conditional types that arise from unresolved type parameters.
    // When a generic type like OpaqueRef<T | undefined> is used where T is a
    // type parameter, TypeScript represents this as a conditional type for
    // deferred evaluation. We treat these as "any" schema since the concrete
    // type isn't known at compile time.
    if ((type.flags & ts.TypeFlags.Conditional) !== 0) {
      return {};
    }

    // All-named strategy:
    // Hoist every named type (excluding wrappers filtered by getNamedTypeKey)
    // into definitions and return $ref for non-root uses. Cycle detection
    // still applies via definitionStack.

    // Check if we're in a wrapper context (Default/Cell/Stream/OpaqueRef).
    // Wrapper types erase to their inner type, so we must check typeNode to
    // distinguish wrapper context from inner context.
    // This now handles both direct wrappers and aliases (e.g., type MyDefault<T> = Default<T, T>)
    const wrapperKind = detectWrapperViaNode(
      context.typeNode,
      context.typeChecker,
    );
    const isWrapperContext = wrapperKind !== undefined;

    let namedKey = getNamedTypeKey(type, context.typeNode);

    if (!namedKey && !isWrapperContext) {
      // Only use synthetic names if we're not processing a wrapper type
      const synthetic = this.anonymousNames.get(type);
      if (synthetic) namedKey = synthetic;
    }

    // Check if this type is already being built or exists
    if (namedKey) {
      if (
        context.inProgressNames.has(namedKey) || context.definitions[namedKey]
      ) {
        // Already being built or exists: emit a ref
        context.emittedRefs.add(namedKey);
        return { "$ref": `#/$defs/${namedKey}` };
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
        return { "$ref": `#/$defs/${namedKey}` };
      }
      const syntheticKey = this.ensureSyntheticName(type);
      context.inProgressNames.add(syntheticKey);
      context.emittedRefs.add(syntheticKey);
      return { "$ref": `#/$defs/${syntheticKey}` };
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
        // We already computed namedKey above with wrapper checks, so reuse it.
        // Only look up synthetic names if namedKey wasn't already set and we're
        // not in a wrapper context (to avoid storing wrapper results).
        const keyForDef = namedKey ??
          (isWrapperContext ? undefined : this.anonymousNames.get(type));
        if (keyForDef) {
          context.definitions[keyForDef] = result;
          context.inProgressNames.delete(keyForDef);
          context.definitionStack.delete(
            this.createStackKey(type, context.typeNode, context.typeChecker),
          );
          if (!isRootType) {
            context.emittedRefs.add(keyForDef);
            return { "$ref": `#/$defs/${keyForDef}` };
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
    _typeNode?: ts.TypeNode,
  ): SchemaDefinition {
    const { definitions, emittedRefs } = context;

    // If no definitions were created or used, return simple schema without $schema
    if (Object.keys(definitions).length === 0 || emittedRefs.size === 0) {
      return rootSchema;
    }

    // Decide if we promote root to a $ref
    const namedKey = getNamedTypeKey(type) ?? this.anonymousNames.get(type);
    const shouldPromoteRoot = this.shouldPromoteToRef(namedKey, context);

    let base: SchemaDefinition;

    if (shouldPromoteRoot && namedKey) {
      // Ensure root is present in definitions
      if (!definitions[namedKey]) {
        definitions[namedKey] = rootSchema;
      }
      base = { $ref: `#/$defs/${namedKey}` } as SchemaDefinition;
    } else {
      base = rootSchema;
    }

    // Handle boolean schemas (rare, but supported by JSON Schema)
    if (typeof base === "boolean") {
      return base;
    }

    // Object schema: attach only the definitions actually referenced by the
    // final output
    const filtered = this.collectReferencedDefinitions(base, definitions);
    const out: Record<string, unknown> = {
      ...(base as Record<string, unknown>),
    };
    if (Object.keys(filtered).length > 0) out.$defs = filtered;
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
      const prefix = "#/$defs/";
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
        // Skip descending into existing $defs blocks to avoid pulling in
        // already-attached subsets recursively
        if (k === "$defs" || k === "definitions") continue;
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

  /**
   * Internal helper to analyze synthetic TypeNode structure.
   * Uses formatChildType for properties to share context properly.
   * Gets typeRegistry from context.typeRegistry if available.
   */
  private analyzeTypeNodeStructure(
    typeNode: ts.TypeNode,
    checker: ts.TypeChecker,
    context: GenerationContext,
  ): SchemaDefinition {
    const typeRegistry = context.typeRegistry;

    // Handle TypeLiteral nodes (object types)
    if (ts.isTypeLiteralNode(typeNode)) {
      const properties: Record<string, SchemaDefinition> = {};
      const required: string[] = [];

      for (const member of typeNode.members) {
        if (
          ts.isPropertySignature(member) &&
          member.name &&
          ts.isIdentifier(member.name) &&
          member.type
        ) {
          const propName = member.name.text;

          // Get the property type - check typeRegistry first, then resolve from node
          let propType: ts.Type;
          if (typeRegistry && typeRegistry.has(member.type)) {
            propType = typeRegistry.get(member.type)!;
          } else {
            propType = checker.getTypeFromTypeNode(member.type);
          }

          // Use formatChildType - it will auto-detect whether to use type-based
          // or node-based analysis depending on whether propType is reliable
          const propSchema = this.formatChildType(
            propType,
            context,
            member.type,
          );

          properties[propName] = propSchema;

          // Add to required if not optional
          if (!member.questionToken) {
            required.push(propName);
          }
        }
      }

      const schema: SchemaDefinition = {
        type: "object",
        properties,
      };

      if (required.length > 0) {
        schema.required = required;
      }

      return schema;
    }

    // Handle ArrayTypeNode (e.g., number[], string[])
    if (ts.isArrayTypeNode(typeNode)) {
      const elementType = checker.getTypeFromTypeNode(typeNode.elementType);
      const items = this.formatChildType(
        elementType,
        context,
        typeNode.elementType,
      );
      return { type: "array", items };
    }

    // Handle keyword types (string, number, boolean, etc.)
    switch (typeNode.kind) {
      case ts.SyntaxKind.StringKeyword:
        return { type: "string" };
      case ts.SyntaxKind.NumberKeyword:
        return { type: "number" };
      case ts.SyntaxKind.BooleanKeyword:
        return { type: "boolean" };
      case ts.SyntaxKind.NullKeyword:
        return { type: "null" };
      case ts.SyntaxKind.NeverKeyword:
        // Reject all values (never type can never occur)
        return false as SchemaDefinition;
      case ts.SyntaxKind.UndefinedKeyword:
      case ts.SyntaxKind.VoidKeyword:
      case ts.SyntaxKind.AnyKeyword:
      case ts.SyntaxKind.UnknownKeyword:
        // Accept any value
        return true as SchemaDefinition;
    }

    // For other TypeNode kinds, try to resolve as Type
    const type = checker.getTypeFromTypeNode(typeNode);
    if (!(type.flags & ts.TypeFlags.Any)) {
      // Successfully resolved - use formatChildType to share context
      return this.formatChildType(type, context, typeNode);
    }

    // Fallback: accept any value
    return true as SchemaDefinition;
  }

  /**
   * Build final schema for synthetic TypeNode with $schema and $defs
   */
  private buildFinalSchemaForSynthetic(
    rootSchema: SchemaDefinition,
    context: GenerationContext,
  ): SchemaDefinition {
    const { definitions, emittedRefs } = context;

    // Handle boolean schemas (rare, but supported by JSON Schema)
    if (typeof rootSchema === "boolean") {
      return rootSchema;
    }

    // If no definitions were created or used, return simple schema
    if (Object.keys(definitions).length === 0 || emittedRefs.size === 0) {
      return rootSchema;
    }

    // Object schema: attach only the definitions actually referenced
    const filtered = this.collectReferencedDefinitions(rootSchema, definitions);
    const out: Record<string, unknown> = {
      ...(rootSchema as Record<string, unknown>),
    };
    if (Object.keys(filtered).length > 0) out.$defs = filtered;
    return out as SchemaDefinition;
  }
}
