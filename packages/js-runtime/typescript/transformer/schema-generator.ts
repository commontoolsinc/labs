import ts from "typescript";
import { getLogger } from "@commontools/utils/logger";

// Create logger for Schema transformer
const logger = getLogger("schema-transformer", {
  enabled: true,
  level: "info",
});

/**
 * Extract plain-text JSDoc from a symbol. Filters out tag lines starting with '@'.
 */
function getSymbolDoc(
  symbol: ts.Symbol | undefined,
  checker: ts.TypeChecker,
): string | undefined {
  if (!symbol) return undefined;
  let text = "";
  try {
    const parts = symbol.getDocumentationComment(checker);
    // @ts-ignore - displayPartsToString is available on ts
    text = ts.displayPartsToString(parts) || "";
  } catch (_e) {
    // ignore
  }
  if (!text) return undefined;
  const lines = text.split(/\r?\n/).filter((l) => !l.trim().startsWith("@"));
  const cleaned = lines.join("\n").trim();
  return cleaned || undefined;
}

/**
 * Extract JSDoc comments from a declaration node if available.
 */
function getDeclDocs(decl: ts.Declaration): string[] {
  const docs: string[] = [];
  const jsDocs = (decl as any).jsDoc as Array<ts.JSDoc> | undefined;
  if (jsDocs && jsDocs.length > 0) {
    for (const d of jsDocs) {
      const comment = (d as any).comment;
      let text = "";
      if (typeof comment === "string") text = comment;
      else if (Array.isArray(comment)) {
        text = comment.map((
          c,
        ) => (typeof c === "string" ? c : (c as any).text ?? "")).join("");
      }
      if (text) {
        const lines = String(text).split(/\r?\n/).filter((l) =>
          !l.trim().startsWith("@")
        );
        const cleaned = lines.join("\n").trim();
        if (cleaned) docs.push(cleaned);
      }
    }
  }
  return docs;
}

/**
 * Extract merged doc from declarations and symbol.
 */
function extractDocFromSymbolAndDecls(
  symbol: ts.Symbol | undefined,
  checker: ts.TypeChecker,
): { text?: string; all: string[] } {
  const all: string[] = [];
  if (symbol) {
    const decls = symbol.declarations ?? [];
    for (const decl of decls) {
      const sf = decl.getSourceFile();
      // Only consider docs from non-declaration files (user/project code)
      if (!sf.isDeclarationFile) {
        for (const s of getDeclDocs(decl)) if (!all.includes(s)) all.push(s);
      }
    }
  }
  // Only include symbol-level docs if symbol has any non-declaration-file declarations
  const hasUserDecl = (symbol?.declarations ?? []).some((d) =>
    !d.getSourceFile().isDeclarationFile
  );
  if (hasUserDecl) {
    const symText = getSymbolDoc(symbol, checker);
    if (symText && !all.includes(symText)) all.push(symText);
  }
  return { text: all[0], all };
}

/**
 * Get a stable, human-readable type name for definitions
 */
function getStableTypeName(
  type: ts.Type,
  definitions?: Record<string, any>,
): string {
  const symbolName = type.symbol?.name;
  if (symbolName && symbolName !== "__type") return symbolName;
  if (definitions) {
    return `Type${Object.keys(definitions).length}`;
  }
  return "Type0";
}

/**
 * Helper to extract array element type using multiple detection methods
 */
function getArrayElementType(
  type: ts.Type,
  checker: ts.TypeChecker,
): ts.Type | undefined {
  // Check ObjectFlags.Reference for Array/ReadonlyArray
  const objectFlags = (type as ts.ObjectType).objectFlags ?? 0;

  if (objectFlags & ts.ObjectFlags.Reference) {
    const typeRef = type as ts.TypeReference;
    const symbol = typeRef.target?.symbol;
    if (
      symbol && (symbol.name === "Array" || symbol.name === "ReadonlyArray")
    ) {
      const elementType = typeRef.typeArguments?.[0];
      return elementType;
    }
  }

  // Check symbol name for Array
  if (type.symbol?.name === "Array") {
    const typeRef = type as ts.TypeReference;
    const elementType = typeRef.typeArguments?.[0];
    return elementType;
  }

  // Use numeric index type as fallback
  try {
    const elementType = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
    if (elementType) {
      return elementType;
    }
  } catch (error) {
    // Stack overflow can happen with recursive types
    // Don't log as it could cause another stack overflow
    // Emit a lightweight breadcrumb without touching the error object
    try {
      logger.warn(() =>
        "getArrayElementType: checker.getIndexTypeOfType threw; treating as non-array"
      );
    } catch (_e) {
      // Swallow any logging issues to remain safe
    }
  }

  return undefined;
}

/**
 * Safely resolve a property's type, preferring AST nodes to avoid deep checker recursion
 */
function safeGetPropertyType(
  prop: ts.Symbol,
  parentType: ts.Type,
  checker: ts.TypeChecker,
  fallbackNode?: ts.TypeNode,
): ts.Type {
  // Prefer declared type node when available
  const decl = prop.valueDeclaration;
  if (decl && ts.isPropertySignature(decl) && decl.type) {
    try {
      return checker.getTypeFromTypeNode(decl.type);
    } catch (_) {
      // fallthrough
    }
  }
  if (fallbackNode) {
    try {
      return checker.getTypeFromTypeNode(fallbackNode);
    } catch (_) {
      // fallthrough
    }
  }
  // Last resort: use symbol location
  try {
    return checker.getTypeOfSymbolAtLocation(
      prop,
      prop.valueDeclaration || fallbackNode || prop.declarations?.[0]!,
    );
  } catch (_) {
    // As a conservative fallback, return the parent type to avoid crashes
    try {
      logger.warn(() =>
        "safeGetPropertyType: checker.getTypeOfSymbolAtLocation threw; returning parentType"
      );
    } catch (_e) {
      // Swallow any logging issues to remain safe
    }
    return parentType;
  }
}

/**
 * Extract the target symbol name for a TypeReference, if any.
 */
function getTargetSymbolName(type: ts.Type): string | undefined {
  const typeRef = type as ts.TypeReference;
  return (typeRef as any).target?.symbol?.name || type.symbol?.name;
}

/**
 * Return the nth type argument if this is a TypeReference and available.
 */
function getTypeArgument(type: ts.Type, index: number): ts.Type | undefined {
  const typeRef = type as ts.TypeReference;
  const args = typeRef.typeArguments as ts.Type[] | undefined;
  if (args && args.length > index) return args[index];
  const resolved = (type as any).resolvedTypeArguments as ts.Type[] | undefined;
  if (resolved && resolved.length > index) return resolved[index];
  return undefined;
}

/**
 * Determine if a TypeReferenceNode is Default<T, V> or an alias to it
 */
function isDefaultTypeRef(
  node: ts.TypeReferenceNode,
  checker: ts.TypeChecker,
): boolean {
  // Direct name match
  if (ts.isIdentifier(node.typeName) && node.typeName.text === "Default") {
    return true;
  }
  // Alias case: resolve symbol and inspect alias declaration target
  const sym = checker.getSymbolAtLocation(node.typeName);
  if (!sym) return false;
  const decl = sym.declarations?.[0];
  if (decl && ts.isTypeAliasDeclaration(decl)) {
    const aliased = decl.type;
    if (ts.isTypeReferenceNode(aliased) && ts.isIdentifier(aliased.typeName)) {
      return aliased.typeName.text === "Default";
    }
  }
  return false;
}

/**
 * Return the symbol name for a type if it's a named interface/class/alias; otherwise undefined.
 */
function getNamedTypeKey(type: ts.Type): string | undefined {
  const sym = (type as any).aliasSymbol as ts.Symbol | undefined;
  const aliasName = sym?.name;
  if (aliasName && aliasName !== "__type") return aliasName;
  const direct = type.getSymbol?.();
  const name = direct?.name;
  if (!name || name === "__type") return undefined;
  return name;
}

/**
 * Build an object schema for a given type. This is separated so we can reuse it
 * while guarding against self-recursion via definitionStack.
 */
function buildObjectSchema(
  type: ts.Type,
  checker: ts.TypeChecker,
  typeNode: ts.TypeNode | undefined,
  depth: number,
  seenTypes: Set<ts.Type>,
  cyclicTypes: Set<ts.Type> | undefined,
  definitions: Record<string, any> | undefined,
  definitionStack: Set<ts.Type>,
  inProgressNames: Set<string>,
  emittedRefs: Set<string>,
): any {
  if (depth > 200) {
    // If we hit an extreme depth, prefer a $ref if possible, else a permissive object
    const namedKey = definitions ? getNamedTypeKey(type) : undefined;
    if (namedKey && definitions) {
      if (!definitions[namedKey]) {
        definitions[namedKey] = { type: "object", properties: {} };
      }
      return { "$ref": `#/definitions/${namedKey}` };
    }
    return { type: "object", additionalProperties: true };
  }
  const properties: any = {};
  const required: string[] = [];

  const props = checker.getPropertiesOfType(type);
  for (const prop of props) {
    const propName = prop.getName();
    if (propName.startsWith("__")) continue;

    const isOptional = (prop.flags & ts.SymbolFlags.Optional) !== 0;
    if (!isOptional) required.push(propName);

    let propTypeNode: ts.TypeNode | undefined;
    const propDecl = prop.valueDeclaration;
    if (propDecl && ts.isPropertySignature(propDecl) && propDecl.type) {
      propTypeNode = propDecl.type;
    }

    const resolvedPropType = safeGetPropertyType(
      prop,
      type,
      checker,
      propTypeNode,
    );

    const propSchema = typeToJsonSchemaHelper(
      resolvedPropType,
      checker,
      propTypeNode,
      depth + 1,
      seenTypes,
      cyclicTypes,
      definitions,
      definitionStack,
      false,
      inProgressNames,
      emittedRefs,
    );

    // Attach property description from JSDoc
    try {
      const { text, all } = extractDocFromSymbolAndDecls(prop, checker);
      if (text) {
        // If there are multiple distinct docs, append a consolidation note
        if (all.filter((s) => s && s !== text).length > 0) {
          propSchema.description =
            `${text} (Consolidated from intersection constituents)`;
          try {
            logger.warn(() =>
              `Consolidated docs for property '${propName}' from multiple declarations.`
            );
          } catch (_e) {}
        } else {
          propSchema.description = text;
        }
      }
    } catch (_e) {
      // ignore doc extraction errors
    }

    properties[propName] = propSchema;
  }

  const schema: any = { type: "object", properties };

  // Handle index signatures → additionalProperties with description
  try {
    const stringIndex = checker.getIndexTypeOfType(type, ts.IndexKind.String);
    if (stringIndex) {
      const apSchema = typeToJsonSchemaHelper(
        stringIndex,
        checker,
        undefined,
        depth + 1,
        seenTypes,
        cyclicTypes,
        definitions,
        definitionStack,
        false,
        inProgressNames,
        emittedRefs,
      );
      // Attempt to read JSDoc from index signature declaration if available
      const sym = type.getSymbol?.();
      let indexDoc: string | undefined;
      if (sym) {
        for (const decl of sym.declarations ?? []) {
          if (ts.isInterfaceDeclaration(decl) || ts.isTypeLiteralNode(decl)) {
            for (const member of decl.members) {
              if (ts.isIndexSignatureDeclaration(member)) {
                const docs = getDeclDocs(member);
                if (docs.length > 0) {
                  indexDoc = docs[0];
                  break;
                }
              }
            }
          }
        }
      }
      if (indexDoc) {
        apSchema.description = indexDoc;
      }
      schema.additionalProperties = apSchema;
    }
  } catch (_e) {
    // Index signature extraction failed; continue without description
  }
  if (required.length > 0) schema.required = required;
  return schema;
}

/**
 * Convert a TypeScript type to JSONSchema (helper with cycle handling)
 */
function typeToJsonSchemaHelper(
  type: ts.Type,
  checker: ts.TypeChecker,
  typeNode?: ts.TypeNode,
  depth: number = 0,
  seenTypes: Set<ts.Type> = new Set(),
  cyclicTypes?: Set<ts.Type>,
  definitions?: Record<string, any>,
  definitionStack: Set<ts.Type> = new Set(),
  isRootType: boolean = false,
  inProgressNames: Set<string> = new Set(),
  emittedRefs: Set<string> = new Set(),
): any {
  if (depth > 200) {
    const namedKey = definitions ? getNamedTypeKey(type) : undefined;
    if (namedKey && definitions) {
      if (!definitions[namedKey]) {
        definitions[namedKey] = { type: "object", properties: {} };
      }
      return { "$ref": `#/definitions/${namedKey}` };
    }
    return { type: "object", additionalProperties: true };
  }
  // If the type node explicitly represents Default<T,V>, handle it first so defaults propagate
  if (
    typeNode && ts.isTypeReferenceNode(typeNode) && typeNode.typeArguments &&
    typeNode.typeArguments.length >= 2
  ) {
    if (isDefaultTypeRef(typeNode, checker)) {
      const innerNode = typeNode.typeArguments[0]!;
      const defaultNode = typeNode.typeArguments[1]!;
      const innerType = checker.getTypeFromTypeNode(innerNode);
      const schema = typeToJsonSchemaHelper(
        innerType,
        checker,
        innerNode,
        depth + 1,
        seenTypes,
        cyclicTypes,
        definitions,
        definitionStack,
        false,
        inProgressNames,
        emittedRefs,
      );
      const extracted = extractValueFromTypeNode(defaultNode, checker);
      if (extracted !== undefined) (schema as any).default = extracted as any;
      return schema;
    }
  }

  // Name-based guards/ref reuse: if a named type is in progress or already defined, return a $ref
  const namedKey = definitions ? getNamedTypeKey(type) : undefined;
  if (namedKey && definitions) {
    if (inProgressNames.has(namedKey)) {
      emittedRefs.add(namedKey);
      return { "$ref": `#/definitions/${namedKey}` };
    }
    if (definitions[namedKey]) {
      emittedRefs.add(namedKey);
      return { "$ref": `#/definitions/${namedKey}` };
    }
  }

  // If cyclicTypes is provided, check if this is a cyclic type by identity
  if (cyclicTypes && cyclicTypes.has(type) && definitions) {
    const typeName = getStableTypeName(type, definitions);

    // If we're already generating or have seen this type in the current path, return a $ref
    if (definitionStack.has(type) || seenTypes.has(type)) {
      return { "$ref": `#/definitions/${typeName}` };
    }

    // Non-root: ensure definition exists and return a $ref
    if (!isRootType) {
      if (!definitions[typeName]) {
        // Mark as in-progress to break self-recursion
        definitionStack.add(type);
        // Add to seen types for this path
        const newSeen = new Set(seenTypes);
        newSeen.add(type);
        const defSchema = buildObjectSchema(
          type,
          checker,
          typeNode,
          depth,
          newSeen,
          cyclicTypes,
          definitions,
          definitionStack,
          inProgressNames,
          emittedRefs,
        );
        definitions[typeName] = defSchema;
        definitionStack.delete(type);
      }
      return { "$ref": `#/definitions/${typeName}` };
    }

    // Root cyclic type: allow building root schema with self-refs
    // Mark as in-progress so inner references become $ref
    definitionStack.add(type);
    seenTypes.add(type);
  }

  // Create a new set with this type added for recursive calls where appropriate
  const newSeenTypes = new Set(seenTypes);

  // Only add interface/class types to seenTypes - only these can cause recursive cycles
  // Skip arrays, built-in types, and other types that can't self-reference
  if (type.flags & ts.TypeFlags.Object) {
    const symbol = type.getSymbol();

    const shouldTrack = symbol &&
      (symbol.flags &
        (ts.SymbolFlags.Interface | ts.SymbolFlags.Class |
          ts.SymbolFlags.TypeAlias)) &&
      symbol.name !== "Array" &&
      !["Date", "RegExp", "Promise", "Map", "Set", "WeakMap", "WeakSet"]
        .includes(symbol.name);

    if (shouldTrack && !newSeenTypes.has(type)) {
      newSeenTypes.add(type);
    }
  }

  // Handle wrapper types before anything else to avoid deep recursion
  const targetName = getTargetSymbolName(type);
  if (targetName === "Default") {
    const inner = getTypeArgument(type, 0);
    const defaultValueType = getTypeArgument(type, 1);
    if (inner) {
      const schema = typeToJsonSchemaHelper(
        inner,
        checker,
        typeNode,
        depth + 1,
        newSeenTypes,
        cyclicTypes,
        definitions,
        definitionStack,
        false,
        inProgressNames,
        emittedRefs,
      );
      // Prefer extracting default from typeNode if available (handles objects/arrays)
      if (
        typeNode && ts.isTypeReferenceNode(typeNode) &&
        typeNode.typeArguments &&
        typeNode.typeArguments.length >= 2
      ) {
        const defaultNode = typeNode.typeArguments[1]!;
        const extracted = extractValueFromTypeNode(defaultNode, checker);
        if (extracted !== undefined) schema.default = extracted as any;
      } else if (defaultValueType) {
        // Fallback to simple literal defaults from the type-level defaultValueType
        if (defaultValueType.flags & ts.TypeFlags.NumberLiteral) {
          // @ts-ignore: Accessing internal TypeScript API to read literal value
          schema.default = (defaultValueType as any).value;
        } else if (defaultValueType.flags & ts.TypeFlags.StringLiteral) {
          // @ts-ignore: Accessing internal TypeScript API to read literal value
          schema.default = (defaultValueType as any).value;
        } else if (defaultValueType.flags & ts.TypeFlags.BooleanLiteral) {
          // @ts-ignore: Accessing internal TypeScript API to read intrinsicName for boolean literal
          schema.default = (defaultValueType as any).intrinsicName === "true";
        }
      }
      return schema;
    }
  }
  if (targetName === "Cell" || targetName === "Stream") {
    const inner = getTypeArgument(type, 0) || type;
    let innerTypeNode: ts.TypeNode | undefined;
    if (
      typeNode && ts.isTypeReferenceNode(typeNode) && typeNode.typeArguments &&
      typeNode.typeArguments.length > 0
    ) {
      innerTypeNode = typeNode.typeArguments[0];
    }
    const schema = typeToJsonSchemaHelper(
      inner,
      checker,
      innerTypeNode || typeNode,
      depth + 1,
      newSeenTypes,
      cyclicTypes,
      definitions,
      definitionStack,
      false,
      inProgressNames,
      emittedRefs,
    );
    if (targetName === "Cell") schema.asCell = true;
    if (targetName === "Stream") schema.asStream = true;
    return schema;
  }

  // Handle primitive types
  if (type.flags & ts.TypeFlags.String) {
    return { type: "string" };
  }
  if (type.flags & ts.TypeFlags.Number) {
    return { type: "number" };
  }
  if (type.flags & ts.TypeFlags.Boolean) {
    return { type: "boolean" };
  }
  if (type.flags & ts.TypeFlags.BooleanLiteral) {
    return { type: "boolean" };
  }
  if (type.flags & ts.TypeFlags.Null) {
    return { type: "null" };
  }

  // Handle arrays BEFORE object types (arrays are objects too)
  if (typeNode && ts.isArrayTypeNode(typeNode)) {
    const elementTypeNode = typeNode.elementType;
    const elementType = checker.getTypeFromTypeNode(elementTypeNode);
    const itemsSchema = typeToJsonSchemaHelper(
      elementType,
      checker,
      elementTypeNode,
      depth + 1,
      newSeenTypes,
      cyclicTypes,
      definitions,
      definitionStack,
      false,
      inProgressNames,
      emittedRefs,
    );
    const schema: any = { type: "array", items: itemsSchema };
    return schema;
  }

  const arrayElementType = getArrayElementType(type, checker);
  if (arrayElementType) {
    let elementTypeNode: ts.TypeNode | undefined;
    if (
      typeNode && ts.isTypeReferenceNode(typeNode) &&
      typeNode.typeName && typeNode.typeArguments &&
      typeNode.typeArguments.length > 0
    ) {
      elementTypeNode = typeNode.typeArguments[0];
    }

    const itemsSchema = typeToJsonSchemaHelper(
      arrayElementType,
      checker,
      elementTypeNode,
      depth + 1,
      newSeenTypes,
      cyclicTypes,
      definitions,
      definitionStack,
      false,
      inProgressNames,
      emittedRefs,
    );
    return { type: "array", items: itemsSchema };
  }

  // Handle Date
  const symbol = type.getSymbol();
  if (symbol && symbol.name === "Date") {
    return { type: "string", format: "date-time" };
  }

  // Handle intersection types (A & B & ...)
  if (type.flags & ts.TypeFlags.Intersection) {
    const intersection = type as ts.IntersectionType;
    const constituents = intersection.types;

    const failureReasons: string[] = [];
    const isObjectLike = (t: ts.Type) => (t.flags & ts.TypeFlags.Object) !== 0;

    for (const t of constituents) {
      // Must be object-like
      if (!isObjectLike(t)) {
        failureReasons.push("non-object constituent");
        break;
      }

      try {
        // Disallow index signatures for now (would require patternProperties/additionalProperties merging)
        const stringIndex = checker.getIndexTypeOfType(t, ts.IndexKind.String);
        const numberIndex = checker.getIndexTypeOfType(t, ts.IndexKind.Number);
        if (stringIndex || numberIndex) {
          failureReasons.push("index signature on constituent");
          break;
        }

        // Disallow callable/constructable constituents (not meaningful for handler state schemas)
        const callSigs = checker.getSignaturesOfType(t, ts.SignatureKind.Call);
        const constructSigs = checker.getSignaturesOfType(
          t,
          ts.SignatureKind.Construct,
        );
        if (callSigs.length > 0 || constructSigs.length > 0) {
          failureReasons.push("call/construct signatures on constituent");
          break;
        }
      } catch (_err) {
        // If the checker throws, err on the side of not merging
        failureReasons.push("checker error while validating intersection");
        break;
      }
    }

    if (failureReasons.length > 0) {
      try {
        logger.warn(() =>
          `typeToJsonSchema: not merging intersection — ${failureReasons[0]}`
        );
      } catch (_e) {
        // Swallow logging issues to remain safe
      }
      return {
        type: "object",
        additionalProperties: true,
        $comment: `Unsupported intersection pattern: ${failureReasons[0]}`,
      };
    }

    // Safe to merge: build merged object schema via existing helper
    return buildObjectSchema(
      type,
      checker,
      typeNode,
      depth,
      newSeenTypes,
      cyclicTypes,
      definitions,
      definitionStack,
      inProgressNames,
      emittedRefs,
    );
  }

  // Handle object types (interfaces, type literals)
  if (type.flags & ts.TypeFlags.Object) {
    // If this is a named type and we can emit definitions, build via a placeholder and decide whether to keep a $ref
    if (
      namedKey &&
      definitions &&
      !(cyclicTypes && cyclicTypes.has(type) && isRootType)
    ) {
      // Set placeholder and mark in-progress
      if (!definitions[namedKey]) definitions[namedKey] = {};
      inProgressNames.add(namedKey);

      const defSchema = buildObjectSchema(
        type,
        checker,
        typeNode,
        depth,
        newSeenTypes,
        cyclicTypes,
        definitions,
        definitionStack,
        inProgressNames,
        emittedRefs,
      );

      inProgressNames.delete(namedKey);

      // Keep definition only if recursion occurred or identity-based cycle detected
      if (emittedRefs.has(namedKey) || (cyclicTypes && cyclicTypes.has(type))) {
        definitions[namedKey] = defSchema;
        if (!isRootType) {
          return { "$ref": `#/definitions/${namedKey}` };
        }
        return defSchema;
      } else {
        // No recursion: remove placeholder and inline schema
        delete definitions[namedKey];
        return defSchema;
      }
    }

    return buildObjectSchema(
      type,
      checker,
      typeNode,
      depth,
      newSeenTypes,
      cyclicTypes,
      definitions,
      definitionStack,
      inProgressNames,
      emittedRefs,
    );
  }

  // Handle union types
  if (type.isUnion()) {
    const unionTypes = (type as ts.UnionType).types;
    const nonNullTypes = unionTypes.filter((t) =>
      !(t.flags & ts.TypeFlags.Undefined)
    );

    // Special handling for boolean | undefined
    if (
      unionTypes.length === 3 &&
      unionTypes.filter((t) => t.flags & ts.TypeFlags.BooleanLiteral).length ===
        2 &&
      unionTypes.filter((t) => t.flags & ts.TypeFlags.Undefined).length === 1
    ) {
      return { type: "boolean" };
    }

    if (nonNullTypes.length === 1 && unionTypes.length === 2) {
      return typeToJsonSchemaHelper(
        nonNullTypes[0],
        checker,
        typeNode,
        depth,
        newSeenTypes,
        cyclicTypes,
        definitions,
        definitionStack,
        false,
        inProgressNames,
        emittedRefs,
      );
    }
    return {
      oneOf: unionTypes.map((t) =>
        typeToJsonSchemaHelper(
          t,
          checker,
          typeNode,
          depth,
          newSeenTypes,
          cyclicTypes,
          definitions,
          definitionStack,
          false,
          inProgressNames,
          emittedRefs,
        )
      ),
    };
  }

  // Fallback
  return { type: "object", additionalProperties: true };
}

/**
 * Extract literal/default value from a type node, when possible
 */
function extractValueFromTypeNode(node: ts.TypeNode, checker: ts.TypeChecker):
  | string
  | number
  | boolean
  | null
  | undefined
  | any[]
  | Record<string, any> {
  // Handle literal types directly
  if (ts.isLiteralTypeNode(node)) {
    const literal = node.literal;
    if (ts.isStringLiteral(literal)) return literal.text;
    if (ts.isNumericLiteral(literal)) return Number(literal.text);
    if (literal.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (literal.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (literal.kind === ts.SyntaxKind.NullKeyword) return null;
  }

  // Tuple type nodes (e.g., ["a", "b"]) map to array defaults
  if (ts.isTupleTypeNode(node)) {
    const values: any[] = [];
    for (const elem of node.elements) {
      const v = extractValueFromTypeNode(elem, checker);
      values.push(v);
    }
    return values;
  }

  // Type literal nodes map to object defaults
  if (ts.isTypeLiteralNode(node)) {
    const obj: Record<string, any> = {};
    for (const member of node.members) {
      if (
        ts.isPropertySignature(member) && member.name &&
        ts.isIdentifier(member.name)
      ) {
        const key = member.name.text;
        if (member.type) {
          const v = extractValueFromTypeNode(member.type, checker);
          obj[key] = v;
        }
      }
    }
    return obj;
  }

  // Union type with null/undefined handling (already above)
  if (ts.isUnionTypeNode(node)) {
    for (const t of node.types) {
      if (t.kind === ts.SyntaxKind.NullKeyword) return null;
      if (t.kind === ts.SyntaxKind.UndefinedKeyword) return undefined;
    }
  }

  // Handle direct null/undefined keywords
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (node.kind === ts.SyntaxKind.UndefinedKeyword) return undefined;

  return undefined;
}

/**
 * First pass: Detect which types are involved in cycles
 * Returns a Set of types that have recursive references
 */
export function getCycles(
  type: ts.Type,
  checker: ts.TypeChecker,
  visiting: Set<ts.Type> = new Set(),
  cycles: Set<ts.Type> = new Set(),
  depth: number = 0,
): Set<ts.Type> {
  // Depth guard to avoid stack overflow in pathological cases
  if (depth > 200) return cycles;

  // Skip primitive types - they can't have cycles
  if (
    type.flags &
    (ts.TypeFlags.String | ts.TypeFlags.Number | ts.TypeFlags.Boolean |
      ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)
  ) {
    return cycles;
  }

  // Unwrap known wrappers early (Default<T, V>, Cell<T>, Stream<T>)
  const wrapperName = getTargetSymbolName(type);
  if (
    wrapperName === "Default" || wrapperName === "Cell" ||
    wrapperName === "Stream"
  ) {
    const inner = getTypeArgument(type, 0);
    if (inner) {
      getCycles(inner, checker, visiting, cycles, depth + 1);
    }
    // For Default<T, V> we only care about T for cycles
    return cycles;
  }

  // Only track types that could potentially self-reference
  if (type.flags & ts.TypeFlags.Object) {
    const symbol = type.getSymbol();

    // Use same logic as in typeToJsonSchema for consistency
    const shouldTrack = symbol &&
      (symbol.flags &
        (ts.SymbolFlags.Interface | ts.SymbolFlags.Class |
          ts.SymbolFlags.TypeAlias)) &&
      symbol.name !== "Array" &&
      !["Date", "RegExp", "Promise", "Map", "Set", "WeakMap", "WeakSet"]
        .includes(symbol.name);

    if (!shouldTrack) {
      // Check if it's an array type using our helper
      const elementType = getArrayElementType(type, checker);
      if (elementType) {
        getCycles(elementType, checker, visiting, cycles, depth + 1);
      }
      return cycles;
    }

    // Check if we're already visiting this type (cycle detected)
    if (visiting.has(type)) {
      // This type is part of a cycle
      cycles.add(type);
      // Also mark all types currently being visited as potentially cyclic
      visiting.forEach((t) => {
        cycles.add(t);
      });
      return cycles;
    }

    // Add to visiting set
    visiting.add(type);

    // Check all properties
    const props = checker.getPropertiesOfType(type);

    if (props.length === 0) {
      // No properties - might be an array type
      const elementType = getArrayElementType(type, checker);
      if (elementType) {
        getCycles(elementType, checker, visiting, cycles, depth + 1);
      }
    } else {
      for (const prop of props) {
        // Skip symbol properties
        if (prop.getName().startsWith("__")) continue;

        let propType: ts.Type | undefined;
        try {
          propType = checker.getTypeOfSymbolAtLocation(
            prop,
            prop.valueDeclaration || prop.declarations?.[0]!,
          );
        } catch (_err) {
          try {
            logger.warn(() =>
              "getCycles: checker.getTypeOfSymbolAtLocation threw; skipping property"
            );
          } catch (_e) {
            // Swallow any logging issues to remain safe
          }
          continue;
        }

        // Check if the property has a type node we can analyze directly
        const propDecl = prop.valueDeclaration;
        if (propDecl && ts.isPropertySignature(propDecl) && propDecl.type) {
          // Check if it's an array type node
          if (ts.isArrayTypeNode(propDecl.type)) {
            const elementTypeNode = propDecl.type.elementType;
            let elementType: ts.Type | undefined;
            try {
              elementType = checker.getTypeFromTypeNode(elementTypeNode);
            } catch (_err) {
              try {
                logger.warn(() =>
                  "getCycles: checker.getTypeFromTypeNode threw; skipping array element type"
                );
              } catch (_e) {
                // Swallow any logging issues to remain safe
              }
              continue;
            }
            getCycles(elementType, checker, visiting, cycles, depth + 1);
            continue;
          }

          // Unwrap Default<Cell<...>> style references by name when possible
          if (ts.isTypeReferenceNode(propDecl.type)) {
            const typeName = propDecl.type.typeName;
            if (ts.isIdentifier(typeName)) {
              const refSymbol = checker.getSymbolAtLocation(typeName);
              const refType = refSymbol
                ? checker.getDeclaredTypeOfSymbol(refSymbol)
                : undefined;
              if (refType) {
                getCycles(refType, checker, visiting, cycles, depth + 1);
                continue;
              }
            }
          }
        }

        if (propType) getCycles(propType, checker, visiting, cycles, depth + 1);
      }
    }

    // Remove from visiting set
    visiting.delete(type);
  }

  // Handle union types
  if (type.isUnion()) {
    const unionTypes = (type as ts.UnionType).types;
    for (const unionType of unionTypes) {
      getCycles(unionType, checker, visiting, cycles, depth + 1);
    }
  }

  return cycles;
}

/**
 * Convert a TypeScript type to JSONSchema
 * Handles recursive types with JSON Schema $ref/definitions
 */
export function typeToJsonSchema(
  type: ts.Type,
  checker: ts.TypeChecker,
  typeNode?: ts.TypeNode,
): any {
  // First pass: detect cycles
  const cyclicTypes = getCycles(type, checker);

  // Second pass: generate schema with definitions (always thread a definitions object)
  const definitions: Record<string, any> = {};
  const seenTypes = new Set<ts.Type>();
  const inProgressNames = new Set<string>();
  const emittedRefs = new Set<string>();

  // Generate the schema for the root type
  const rootSchema = typeToJsonSchemaHelper(
    type,
    checker,
    typeNode,
    0,
    seenTypes,
    cyclicTypes,
    definitions,
    new Set<ts.Type>(),
    true, // isRootType
    inProgressNames,
    emittedRefs,
  );

  // Attach root description from JSDoc if available and none provided by options layer
  try {
    const sym = (type as any).aliasSymbol || type.getSymbol?.() ||
      (type as any).symbol;
    const hasUserDecl = (sym?.declarations ?? []).some((d: ts.Declaration) =>
      !d.getSourceFile().isDeclarationFile
    );
    if (hasUserDecl) {
      const { text } = extractDocFromSymbolAndDecls(sym, checker);
      if (
        text && rootSchema && typeof rootSchema === "object" &&
        !("description" in rootSchema)
      ) {
        (rootSchema as any).description = text;
      }
    }
  } catch (_e) {
    // ignore
  }

  // If the root type itself is cyclic by identity, return a top-level $ref with definitions
  if (cyclicTypes.has(type)) {
    const typeName = getStableTypeName(type, definitions);
    if (!definitions[typeName]) {
      definitions[typeName] = rootSchema;
    }
    return {
      "$ref": `#/definitions/${typeName}`,
      "$schema": "http://json-schema.org/draft-07/schema#",
      "definitions": definitions,
    };
  }

  // If we have any definitions, attach them to the root schema
  if (Object.keys(definitions).length > 0) {
    return {
      ...rootSchema,
      "$schema": "http://json-schema.org/draft-07/schema#",
      "definitions": definitions,
    };
  }

  // No cycles/definitions to attach
  return rootSchema;
}
