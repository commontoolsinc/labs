import ts from "typescript";
import {
  CF_HELPERS_IDENTIFIER,
  HelpersOnlyTransformer,
  TransformationContext,
} from "../core/mod.ts";
import { createSchemaTransformerV2 } from "@commonfabric/schema-generator";
import { numberFromExpression } from "@commonfabric/schema-generator/numeric-expression";
import {
  getNodeText,
  getTypeFromTypeNodeWithFallback,
  visitEachChildWithJsx,
} from "../ast/mod.ts";
import { createPropertyName } from "../utils/identifiers.ts";
import { compileCfcPolicyManifestsForSource } from "./cfc-policy-authoring.ts";

export type GeneratedToSchemaValue =
  | { readonly resolved: true; readonly value: unknown }
  | { readonly resolved: false };

/**
 * Generate the exact value emitted for a compiler-owned `toSchema<T>()` call.
 *
 * Schema injection uses this before the schema-generator pass when a pattern
 * contract references a stable const initialized by `toSchema`. Keeping the
 * implementation here makes the early contract hint and the later emitted
 * schema share one source of truth.
 */
export function generateToSchemaValue(
  node: ts.Node,
  context: TransformationContext,
  schemaTransformer = createSchemaTransformerV2(),
): GeneratedToSchemaValue {
  if (!isToSchemaNode(node)) return { resolved: false };

  const { sourceFile, checker } = context;
  // Earlier transformer stages may rebuild the working SourceFile. Its nodes
  // are valid for emission, but they are not the SourceFile bound into the
  // Program and can expose transient or unbound symbols to the checker. Schema
  // generation needs the canonical source scope so synthetic closure-param
  // TypeNodes can resolve local aliases and collect their reachable $defs.
  const schemaSourceFile = context.program.getSourceFile(sourceFile.fileName) ??
    sourceFile;
  const { logger, state } = context.options;
  const typeRegistry = state?.typeRegistry;
  const schemaHints = state?.schemaHints;
  const typeArg = node.typeArguments[0]!;
  const typeArguments = ts.isTypeReferenceNode(typeArg)
    ? typeArg.typeArguments
    : undefined;
  const writeAuthorizedByIdentity = extractWriteAuthorizedByIdentity(
    typeArg,
    sourceFile.fileName,
  );
  let schemaTypeArg: ts.TypeNode = typeArg;
  if (
    writeAuthorizedByIdentity &&
    isWriteAuthorizedByType(typeArg) &&
    typeArguments?.length
  ) {
    schemaTypeArg = typeArguments[0]!;
  }

  // First check if we have a registered Type for this node or the typeArg
  // (from schema-injection when synthetic TypeNodes were created).
  //
  // Note on typeRegistry's three overloaded uses (see core/mod.ts): this
  // reads the toSchema CallExpression key (use-(c), synthetic call result)
  // here, then TypeNode keys (use-(b)) via getTypeFromTypeNodeWithFallback
  // below and inside the schema-generator package. The uses don't collide
  // because they key on different node-kinds; no split needed.
  let type: ts.Type;
  if (typeRegistry && typeRegistry.has(node)) {
    type = typeRegistry.get(node)!;
  } else {
    type = getTypeFromTypeNodeWithFallback(
      schemaTypeArg,
      checker,
      typeRegistry,
    );
  }

  if (logger) {
    const typeText = getNodeText(schemaTypeArg);
    logger(`[SchemaTransformer] Found toSchema<${typeText}>() call`);
  }

  const arg0 = node.arguments[0];
  let optionsObj: Record<string, unknown> = {};
  let widenLiterals: boolean | undefined;
  if (arg0 && ts.isObjectLiteralExpression(arg0)) {
    optionsObj = evaluateObjectLiteral(arg0, checker);
    // Extract widenLiterals as a generation option (don't merge into schema)
    if (typeof optionsObj.widenLiterals === "boolean") {
      widenLiterals = optionsObj.widenLiterals;
      delete optionsObj.widenLiterals;
    }
  }

  const generationOptions = widenLiterals !== undefined
    ? { widenLiterals }
    : undefined;

  let schema: unknown;
  if (
    ((typeArg.pos === -1 &&
      typeArg.end === -1 &&
      (type.flags & ts.TypeFlags.Any)) ||
      containsAnyOrUnknownTypeNode(typeArg))
  ) {
    schema = schemaTransformer.generateSchemaFromSyntheticTypeNode(
      schemaTypeArg,
      checker,
      typeRegistry,
      schemaHints,
      schemaSourceFile,
    );
  } else {
    schema = schemaTransformer.generateSchema(
      type,
      checker,
      schemaTypeArg,
      generationOptions,
      schemaHints,
      schemaSourceFile,
      typeRegistry,
    );
  }

  let finalSchema: unknown = typeof schema === "boolean"
    ? schema
    : { ...(schema as Record<string, unknown>), ...optionsObj };
  if (schemaHints) {
    finalSchema = attachUiContractFromSchemaHints(
      finalSchema,
      node,
      schemaTypeArg,
      schemaHints,
    );
  }
  if (writeAuthorizedByIdentity && typeof finalSchema !== "boolean") {
    finalSchema = attachWriteAuthorizedByMarker(
      finalSchema as Record<string, unknown>,
      writeAuthorizedByIdentity,
    );
  }
  const emittedValue = typeof finalSchema === "boolean"
    ? finalSchema
    : { ...(finalSchema as Record<string, unknown>), ...optionsObj };
  return {
    resolved: true,
    value: resolvePolicyOfMarkers(emittedValue, context, node),
  };
}

export class SchemaGeneratorTransformer extends HelpersOnlyTransformer {
  transform(context: TransformationContext): ts.SourceFile {
    const schemaTransformer = createSchemaTransformerV2();
    const { sourceFile, tsContext: transformation } = context;

    const visit: ts.Visitor = (node) => {
      if (isToSchemaNode(node)) {
        const generated = generateToSchemaValue(
          node,
          context,
          schemaTransformer,
        );
        if (!generated.resolved) {
          return visitEachChildWithJsx(node, visit, transformation);
        }
        const schemaAst = createSchemaAst(generated.value, context.factory);

        // Wrap in `as const satisfies JSONSchema` so that schema-inference
        // overloads (e.g. CellTypeConstructor.of, WishFunction) can infer
        // TypeScript types from the literal schema shape.
        const constAssertion = context.factory.createAsExpression(
          schemaAst,
          context.factory.createTypeReferenceNode(
            context.factory.createIdentifier("const"),
            undefined,
          ),
        );

        const jsonSchemaName = context.cfHelpers.getHelperQualified(
          "JSONSchema",
        );
        const satisfiesExpression = context.factory.createSatisfiesExpression(
          constAssertion,
          context.factory.createTypeReferenceNode(jsonSchemaName),
        );

        return satisfiesExpression;
      }

      return visitEachChildWithJsx(node, visit, transformation);
    };

    return ts.visitNode(sourceFile, visit) as ts.SourceFile;
  }
}

function resolvePolicyOfMarkers(
  value: unknown,
  context: TransformationContext,
  diagnosticNode: ts.Node,
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) =>
      resolvePolicyOfMarkers(entry, context, diagnosticNode)
    );
  }
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const marker = record.__ctPolicyIdentityOf;
  if (marker && typeof marker === "object" && !Array.isArray(marker)) {
    const identity = marker as { file?: unknown; path?: unknown };
    const file = typeof identity.file === "string" ? identity.file : undefined;
    const symbol = Array.isArray(identity.path) &&
        typeof identity.path[0] === "string"
      ? identity.path[0]
      : undefined;
    const identityEntries = [
      ...(context.options.moduleIdentities?.entries() ?? []),
    ];
    const exactSourceEntry = file === undefined
      ? undefined
      : identityEntries.find(([sourceName]) =>
        sourceName.replace(/\\/g, "/") === file
      );
    const normalizedSourceEntries = file === undefined
      ? []
      : identityEntries.filter(([sourceName]) =>
        normalizeSourceFilePath(sourceName) === file
      );
    const sourceEntry = exactSourceEntry ??
      (normalizedSourceEntries.length === 1
        ? normalizedSourceEntries[0]
        : undefined);
    let manifests = sourceEntry === undefined
      ? undefined
      : context.options.state?.getPolicyManifests().get(sourceEntry[0]);
    if (sourceEntry !== undefined && manifests === undefined) {
      const definingSource = context.program.getSourceFile(sourceEntry[0]);
      if (definingSource !== undefined) {
        try {
          manifests = compileCfcPolicyManifestsForSource(
            definingSource,
            sourceEntry[1],
          );
          context.options.state?.recordPolicyManifests(
            sourceEntry[0],
            manifests,
          );
        } catch {
          manifests = undefined;
        }
      }
    }
    const artifact = manifests?.find((candidate) =>
      candidate.manifest.symbol === symbol
    );
    if (!sourceEntry || !symbol || !artifact) {
      context.reportDiagnostic({
        node: diagnosticNode,
        type: "cfc-policy-of",
        message:
          "PolicyOf requires a direct typeof reference to a compiler-verified exported exchangeRules() binding.",
      });
      return value;
    }
    const { __ctPolicyIdentityOf: _, ...rest } = record;
    return {
      ...rest,
      moduleIdentity: sourceEntry[1],
      symbol,
      policyDigest: artifact.policyDigest,
    };
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [
      key,
      resolvePolicyOfMarkers(entry, context, diagnosticNode),
    ]),
  );
}

function normalizeSourceFilePath(fileName: string): string {
  const normalized = fileName.replace(/\\/g, "/");
  return normalized.match(/^\/[^/]+(\/.+)$/)?.[1] ?? normalized;
}

export function createSchemaAst(
  schema: unknown,
  factory: ts.NodeFactory,
): ts.Expression {
  if (isWriteAuthorizedByMarker(schema)) {
    return createWriteAuthorizedByMarkerAst(schema, factory);
  }
  if (schema === null) return factory.createNull();
  if (typeof schema === "string") return factory.createStringLiteral(schema);
  if (typeof schema === "number") return createNumericAst(schema, factory);
  if (typeof schema === "boolean") {
    return schema ? factory.createTrue() : factory.createFalse();
  }
  if (Array.isArray(schema)) {
    return factory.createArrayLiteralExpression(
      schema.map((item) => createSchemaAst(item, factory)),
    );
  }
  if (typeof schema === "object") {
    const properties = Object.entries(schema as Record<string, unknown>).map((
      [key, value],
    ) => {
      // Use createPropertyName which handles safe identifiers vs string literals
      // This includes checking for reserved words using TypeScript's scanner
      const propertyName = createPropertyName(key, factory);

      return factory.createPropertyAssignment(
        propertyName,
        createSchemaAst(value, factory),
      );
    });
    return factory.createObjectLiteralExpression(properties, true);
  }
  return factory.createIdentifier("undefined");
}

// The TS factory rejects negative numbers in createNumericLiteral; they must
// be emitted as a unary minus wrapping a positive literal. Non-finite values
// have no literal form at all, so emit them as global identifiers.
function createNumericAst(
  value: number,
  factory: ts.NodeFactory,
): ts.Expression {
  if (Number.isNaN(value)) return factory.createIdentifier("NaN");
  if (value === Infinity) return factory.createIdentifier("Infinity");
  if (value === -Infinity) {
    return factory.createPrefixUnaryExpression(
      ts.SyntaxKind.MinusToken,
      factory.createIdentifier("Infinity"),
    );
  }
  if (value < 0 || Object.is(value, -0)) {
    return factory.createPrefixUnaryExpression(
      ts.SyntaxKind.MinusToken,
      factory.createNumericLiteral(-value),
    );
  }
  return factory.createNumericLiteral(value);
}

function attachWriteAuthorizedByMarker(
  schema: boolean | Record<string, unknown>,
  identity: { file: string; path: string[] },
): boolean | Record<string, unknown> {
  if (typeof schema === "boolean") return schema;
  const ifc = schema.ifc && typeof schema.ifc === "object"
    ? schema.ifc as Record<string, unknown>
    : {};
  return {
    ...schema,
    ifc: {
      ...ifc,
      writeAuthorizedBy: {
        __ctWriterIdentityOf: identity,
      },
    },
  };
}

function attachUiContractFromSchemaHints(
  schema: unknown,
  sourceNode: ts.Node,
  typeNode: ts.TypeNode,
  schemaHints: WeakMap<
    ts.Node,
    {
      items?: unknown;
      cfcUiContract?: {
        helper: "UiAction" | "UiPromptSlot" | "UiDisclosure";
        action?: string;
        surface?: string;
        role?: string;
        kind?: string;
        trustedPattern?: string;
        requiredEventIntegrity?: readonly string[];
      };
    }
  >,
): unknown {
  const hint = schemaHints.get(sourceNode)?.cfcUiContract ??
    schemaHints.get(ts.getOriginalNode(sourceNode))?.cfcUiContract ??
    schemaHints.get(typeNode)?.cfcUiContract ??
    schemaHints.get(ts.getOriginalNode(typeNode))?.cfcUiContract;
  if (!hint) {
    return schema;
  }

  if (typeof schema === "boolean") {
    return schema === false ? { not: true, ifc: { uiContract: hint } } : {
      ifc: { uiContract: hint },
    };
  }
  if (typeof schema !== "object" || schema === null) {
    return schema;
  }

  const recordSchema = schema as Record<string, unknown>;
  const uiProperty = getUiPropertySchema(recordSchema);
  if (uiProperty) {
    return {
      ...recordSchema,
      properties: {
        ...(recordSchema.properties as Record<string, unknown>),
        $UI: attachUiContractToSchemaRecord(uiProperty, hint),
      },
    };
  }

  return attachUiContractToSchemaRecord(recordSchema, hint);
}

function getUiPropertySchema(
  schema: Record<string, unknown>,
): Record<string, unknown> | boolean | undefined {
  if (
    !schema.properties ||
    typeof schema.properties !== "object" ||
    schema.properties === null
  ) {
    return undefined;
  }

  const uiProperty = (schema.properties as Record<string, unknown>).$UI;
  if (typeof uiProperty === "boolean") {
    return uiProperty;
  }
  return typeof uiProperty === "object" && uiProperty !== null
    ? uiProperty as Record<string, unknown>
    : undefined;
}

function attachUiContractToSchemaRecord(
  schema: Record<string, unknown> | boolean,
  hint: {
    helper: "UiAction" | "UiPromptSlot" | "UiDisclosure";
    action?: string;
    surface?: string;
    role?: string;
    kind?: string;
    trustedPattern?: string;
    requiredEventIntegrity?: readonly string[];
  },
): Record<string, unknown> {
  if (typeof schema === "boolean") {
    return schema === false ? { not: true, ifc: { uiContract: hint } } : {
      ifc: { uiContract: hint },
    };
  }

  const existingIfc = schema.ifc && typeof schema.ifc === "object"
    ? schema.ifc as Record<string, unknown>
    : {};
  return {
    ...schema,
    ifc: {
      ...existingIfc,
      uiContract: hint,
    },
  };
}

function extractWriteAuthorizedByIdentity(
  typeNode: ts.TypeNode,
  sourceFileName: string,
): { file: string; path: string[] } | undefined {
  if (!isWriteAuthorizedByType(typeNode)) {
    return undefined;
  }
  const bindingNode = typeNode.typeArguments?.[1];
  if (!bindingNode || !ts.isTypeQueryNode(bindingNode)) {
    return undefined;
  }
  if (!ts.isIdentifier(bindingNode.exprName)) {
    return undefined;
  }
  return {
    file: normalizeSourceFilePath(sourceFileName),
    path: [bindingNode.exprName.text],
  };
}

function isWriteAuthorizedByType(
  typeNode: ts.TypeNode,
): typeNode is ts.TypeReferenceNode {
  return ts.isTypeReferenceNode(typeNode) &&
    ts.isIdentifier(typeNode.typeName) &&
    typeNode.typeName.text === "WriteAuthorizedBy" &&
    !!typeNode.typeArguments &&
    typeNode.typeArguments.length >= 2;
}

function isWriteAuthorizedByMarker(
  schema: unknown,
): schema is { __ctWriterIdentityOf: { file: string; path: string[] } } {
  return !!schema && typeof schema === "object" &&
    "__ctWriterIdentityOf" in schema &&
    Object.keys(schema as Record<string, unknown>).length === 1 &&
    isWriterIdentityPayload(
      (schema as Record<string, unknown>).__ctWriterIdentityOf,
    );
}

function isWriterIdentityPayload(
  value: unknown,
): value is { file: string; path: string[] } {
  return !!value && typeof value === "object" &&
    typeof (value as Record<string, unknown>).file === "string" &&
    Array.isArray((value as Record<string, unknown>).path) &&
    ((value as Record<string, unknown>).path as unknown[]).every((entry) =>
      typeof entry === "string"
    );
}

function createWriteAuthorizedByMarkerAst(
  schema: { __ctWriterIdentityOf: { file: string; path: string[] } },
  factory: ts.NodeFactory,
): ts.Expression {
  return factory.createObjectLiteralExpression([
    factory.createPropertyAssignment(
      createPropertyName("__ctWriterIdentityOf", factory),
      factory.createObjectLiteralExpression([
        factory.createPropertyAssignment(
          createPropertyName("file", factory),
          factory.createStringLiteral(schema.__ctWriterIdentityOf.file),
        ),
        factory.createPropertyAssignment(
          createPropertyName("path", factory),
          factory.createArrayLiteralExpression(
            schema.__ctWriterIdentityOf.path.map((segment) =>
              factory.createStringLiteral(segment)
            ),
          ),
        ),
      ], true),
    ),
  ], true);
}

function evaluateObjectLiteral(
  node: ts.ObjectLiteralExpression,
  checker: ts.TypeChecker,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const prop of node.properties) {
    if (ts.isPropertyAssignment(prop)) {
      // Handle both identifier and string literal property names
      let propName: string | undefined;
      if (ts.isIdentifier(prop.name)) {
        propName = prop.name.text;
      } else if (ts.isStringLiteral(prop.name)) {
        propName = prop.name.text;
      }

      if (propName !== undefined) {
        const value = evaluateExpression(prop.initializer, checker);
        if (value !== undefined) {
          result[propName] = value;
        }
      }
    }
  }
  return result;
}

function evaluateExpression(
  node: ts.Expression,
  checker: ts.TypeChecker,
): unknown {
  // Wrappers that do not change the value: parentheses, and the type-only
  // assertion forms. Without this every parenthesized option is dropped, of
  // whatever type -- `("text")` as surely as `(-1)`. The schema-generator side
  // of this pair has always unwrapped them.
  if (
    ts.isParenthesizedExpression(node) || ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node)
  ) {
    return evaluateExpression(node.expression, checker);
  }

  if (ts.isStringLiteral(node)) return node.text;
  const numeric = numberFromExpression(node, checker);
  if (numeric !== undefined) return numeric;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (node.kind === ts.SyntaxKind.UndefinedKeyword) return undefined;
  if (ts.isObjectLiteralExpression(node)) {
    return evaluateObjectLiteral(node, checker);
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.map((element) => evaluateExpression(element, checker));
  }
  const constantValue = checker.getConstantValue(
    node as ts.PropertyAccessExpression,
  );
  if (constantValue !== undefined) return constantValue;
  return undefined;
}

// Helper type extending CallExpression with
// truthy typeArguments.
interface ToSchemaNode extends ts.CallExpression {
  typeArguments: ts.NodeArray<ts.TypeNode>;
}

function containsAnyOrUnknownTypeNode(node: ts.TypeNode): boolean {
  let found = false;
  const visit = (current: ts.Node): void => {
    if (found) return;
    if (
      current.kind === ts.SyntaxKind.AnyKeyword ||
      current.kind === ts.SyntaxKind.UnknownKeyword
    ) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

function isToSchemaNode(node: ts.Node): node is ToSchemaNode {
  if (!ts.isCallExpression(node)) return false;
  const { typeArguments, expression } = node;
  if (!typeArguments || typeArguments.length !== 1) return false;

  // Raw identity expression `toSchema<T>()`
  if (
    ts.isIdentifier(expression) &&
    expression.text === "toSchema" &&
    typeArguments &&
    typeArguments.length === 1
  ) {
    return true;
  }
  // Raw property access expression `__cfHelpers.toSchema<T>()`
  if (
    ts.isPropertyAccessExpression(expression) &&
    getNodeText(expression.expression) === CF_HELPERS_IDENTIFIER &&
    expression.name.text === "toSchema"
  ) {
    return true;
  }
  return false;
}
