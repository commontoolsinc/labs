import ts from "typescript";
import type { JSONSchema } from "@commonfabric/api";
import { factorySchemasEqual } from "@commonfabric/data-model/schema-utils";
import {
  createSchemaTransformerV2,
  type FactoryTypeInfo,
  type FactoryTypeKind,
} from "@commonfabric/schema-generator";
import { findFrameworkProvidedPaths } from "../policy/framework-provided.ts";

import {
  classifyFactoryCallee,
  classifyFactoryCallExposure,
  type FactoryCalleeClassification,
} from "../ast/factory-callee.ts";
import {
  factoryContractDeclaredTypeNode,
  type FactoryContractProvenance,
  factoryContractProvenanceFromTypeNode,
} from "../ast/factory-contract-hints.ts";
import { HelpersOnlyTransformer, TransformationContext } from "../core/mod.ts";
import { unwrapExpression } from "../utils/expression.ts";
import { createSchemaAst } from "./schema-generator.ts";

interface EmittedFactoryContract {
  readonly kind: FactoryTypeKind;
  readonly inputSchema: JSONSchema;
  readonly outputSchema: JSONSchema;
  readonly frameworkProvidedPaths: readonly (readonly string[])[];
}

/** Lower eager symbolic factory proxy calls before closure conversion. */
export class SymbolicFactoryCallTransformer extends HelpersOnlyTransformer {
  transform(context: TransformationContext): ts.SourceFile {
    const schemaGenerator = createSchemaTransformerV2();

    const visit: ts.Visitor = (node) => {
      if (!ts.isCallExpression(node)) {
        return ts.visitEachChild(node, visit, context.tsContext);
      }

      const factoryValue = classifyFactoryCallee(node, context.checker);
      if (
        factoryValue?.origin === "live" &&
        !factoryValue.hasNonFactoryMember &&
        isFactoryModifierDerivation(node)
      ) {
        context.markLiveFactoryDerivation(node);
      }

      const classification = classifyFactoryCallee(
        node.expression,
        context.checker,
      );
      const visited = ts.visitEachChild(
        node,
        visit,
        context.tsContext,
      ) as ts.CallExpression;
      if (!classification) return visited;

      const exposure = classifyFactoryCallExposure(node, context.checker);
      if (
        classification.origin === "live" ||
        exposure === "runtime-materialized"
      ) {
        return visited;
      }

      const effectiveOrigin = exposure === "symbolic" &&
          classification.origin === "runtime-materialized"
        ? "symbolic"
        : classification.origin;
      if (
        effectiveOrigin !== "symbolic" ||
        classification.hasNonFactoryMember
      ) {
        context.reportDiagnosticOnce({
          type: "factory-call:untransformable-symbolic-proxy",
          message:
            "This factory call cannot be proven live or tied to an eager pattern input. Call a live module-scoped factory directly, or pass the factory through a typed pattern/lift/handler boundary.",
          node: node.expression,
        });
        return visited;
      }

      const spreadArgument = node.arguments.find(ts.isSpreadElement);
      if (spreadArgument) {
        context.reportDiagnosticOnce({
          type: "factory-call:spread-argument",
          message:
            "A symbolic factory call takes exactly one explicit argument; tuple/rest spread would require synchronously reading reactive input during graph construction.",
          node: spreadArgument,
        });
        return visited;
      }

      const contract = buildCompatibleContract(
        classification,
        node.expression,
        context,
        schemaGenerator,
        node,
      );
      if (!contract) return visited;

      const input = visited.arguments[0] ??
        context.factory.createIdentifier("undefined");
      const replacement = context.cfHelpers.createHelperCall(
        "invokeFactory",
        node,
        undefined,
        [
          visited.expression,
          input,
          createContractAst(contract, context.factory),
        ],
      );

      try {
        const resultType = context.checker.getTypeAtLocation(node);
        context.options.state?.typeRegistry.set(replacement, resultType);
      } catch {
        // Later passes can still classify invokeFactory through the runtime
        // registry even if the checker cannot recover this call's result type.
      }
      return replacement;
    };

    return ts.visitNode(context.sourceFile, visit) as ts.SourceFile;
  }
}

function isFactoryModifierDerivation(node: ts.CallExpression): boolean {
  const callee = node.expression;
  return ts.isPropertyAccessExpression(callee) &&
    (callee.name.text === "asScope" || callee.name.text === "inSpace");
}

function buildCompatibleContract(
  classification: FactoryCalleeClassification,
  expression: ts.Expression,
  context: TransformationContext,
  schemaGenerator: ReturnType<typeof createSchemaTransformerV2>,
  diagnosticNode: ts.Node,
): EmittedFactoryContract | undefined {
  const { members } = classification;
  const [first, ...rest] = members;
  if (!first) return undefined;

  const provenance = collectCompilerOwnedFactoryContracts(
    expression,
    context,
    new Set(),
  );
  if (provenance.contracts.length > 0 && !provenance.complete) {
    context.reportDiagnosticOnce({
      type: "factory-call:framework-provided-mismatch-union",
      message:
        "Every callable factory in a union must carry its own compiler-owned FrameworkProvided provenance; one provenanced arm cannot authorize another.",
      node: diagnosticNode,
    });
    return undefined;
  }
  if (provenance.contracts.length > 0) {
    const generated = generateMemberSchemas(first, context, schemaGenerator);
    const contracts = provenance.contracts.map(
      (contract): EmittedFactoryContract => ({
        kind: contract.kind,
        inputSchema: contract.inputSchema as JSONSchema | undefined ??
          generated.inputSchema,
        outputSchema: contract.outputSchema as JSONSchema | undefined ??
          generated.outputSchema,
        frameworkProvidedPaths: contract.frameworkProvidedPaths ?? [],
      }),
    );
    return requireCompatibleContracts(contracts, context, diagnosticNode);
  }

  const firstSchemas = generateMemberSchemas(first, context, schemaGenerator);
  const firstContract: EmittedFactoryContract = {
    kind: first.kind,
    ...firstSchemas,
    frameworkProvidedPaths: findFrameworkProvidedPaths(
      first.inputType,
      context.checker,
    ),
  };
  const contracts = [firstContract];
  for (const member of rest) {
    const schemas = generateMemberSchemas(member, context, schemaGenerator);
    contracts.push({
      kind: member.kind,
      ...schemas,
      frameworkProvidedPaths: findFrameworkProvidedPaths(
        member.inputType,
        context.checker,
      ),
    });
  }
  return requireCompatibleContracts(contracts, context, diagnosticNode);
}

function requireCompatibleContracts(
  contracts: readonly EmittedFactoryContract[],
  context: TransformationContext,
  diagnosticNode: ts.Node,
): EmittedFactoryContract | undefined {
  const [first, ...rest] = contracts;
  if (!first) return undefined;
  for (const contract of rest) {
    if (contract.kind !== first.kind) {
      context.reportDiagnosticOnce({
        type: "factory-call:cross-kind-union",
        message:
          "A callable factory union must contain one factory kind; pattern/module factories return Reactive values while handlers return Streams.",
        node: diagnosticNode,
      });
      return undefined;
    }
    if (
      !factorySchemasEqual(first.inputSchema, contract.inputSchema) ||
      !factorySchemasEqual(first.outputSchema, contract.outputSchema)
    ) {
      context.reportDiagnosticOnce({
        type: "factory-call:schema-mismatch-union",
        message:
          "Every callable factory in a same-kind union must have exactly equal normalized public input and output schemas.",
        node: diagnosticNode,
      });
      return undefined;
    }
    if (
      JSON.stringify(contract.frameworkProvidedPaths) !==
        JSON.stringify(first.frameworkProvidedPaths)
    ) {
      context.reportDiagnosticOnce({
        type: "factory-call:framework-provided-mismatch-union",
        message:
          "Every callable factory in a same-kind union must have exactly equal FrameworkProvided input paths.",
        node: diagnosticNode,
      });
      return undefined;
    }
  }
  return first;
}

function collectCompilerOwnedFactoryContracts(
  expression: ts.Expression,
  context: TransformationContext,
  seen: Set<ts.Node>,
): FactoryContractProvenance {
  const current = unwrapExpression(expression);
  const original = ts.getOriginalNode(current);
  if (seen.has(current) || seen.has(original)) {
    return { contracts: [], complete: false };
  }
  seen.add(current);
  seen.add(original);

  const direct = context.lookupSchemaHint(current)?.factoryContracts;
  if (direct?.length) return { contracts: direct, complete: true };

  const declaration = factoryValueDeclaration(current, context.checker);
  const declaredType = declaration && factoryContractDeclaredTypeNode(
    declaration,
    context.checker,
  );
  const fromType = declaredType
    ? factoryContractProvenanceFromTypeNode(declaredType, context, seen)
    : undefined;
  if (fromType?.contracts.length) return fromType;

  if (declaration && ts.isVariableDeclaration(declaration)) {
    const initializer = declaration.initializer;
    if (initializer) {
      return collectCompilerOwnedFactoryContracts(initializer, context, seen);
    }
  }
  return { contracts: [], complete: false };
}

function factoryValueDeclaration(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): ts.Declaration | undefined {
  let symbol: ts.Symbol | undefined;
  if (ts.isIdentifier(expression)) {
    symbol = checker.getSymbolAtLocation(expression) ?? undefined;
  } else if (ts.isPropertyAccessExpression(expression)) {
    symbol = checker.getSymbolAtLocation(expression.name) ?? undefined;
  } else if (ts.isElementAccessExpression(expression)) {
    const key = expression.argumentExpression &&
        (ts.isStringLiteralLike(expression.argumentExpression) ||
          ts.isNumericLiteral(expression.argumentExpression))
      ? expression.argumentExpression.text
      : undefined;
    if (key !== undefined) {
      try {
        symbol = checker.getTypeAtLocation(expression.expression).getProperty(
          key,
        );
      } catch {
        // Leave the element access unresolved when the receiver type is not
        // available; structural factory validation still fails closed.
      }
    }
  }
  if (!symbol) return undefined;
  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    try {
      symbol = checker.getAliasedSymbol(symbol);
    } catch {
      // Keep the local alias declaration when the checker cannot resolve it.
    }
  }
  return symbol.valueDeclaration ?? symbol.declarations?.[0];
}

function generateMemberSchemas(
  member: FactoryTypeInfo,
  context: TransformationContext,
  schemaGenerator: ReturnType<typeof createSchemaTransformerV2>,
): { inputSchema: JSONSchema; outputSchema: JSONSchema } {
  return {
    inputSchema: schemaGenerator.generateSchema(
      member.inputType,
      context.checker,
      undefined,
      undefined,
      context.options.state?.schemaHints,
      context.sourceFile,
    ),
    outputSchema: schemaGenerator.generateSchema(
      member.outputType,
      context.checker,
      undefined,
      undefined,
      context.options.state?.schemaHints,
      context.sourceFile,
    ),
  };
}

function createContractAst(
  contract: EmittedFactoryContract,
  factory: ts.NodeFactory,
): ts.ObjectLiteralExpression {
  const schemaFields = contract.kind === "handler"
    ? {
      contextSchema: contract.inputSchema,
      eventSchema: contract.outputSchema,
    }
    : {
      argumentSchema: contract.inputSchema,
      resultSchema: contract.outputSchema,
    };
  return createSchemaAst(
    {
      kind: contract.kind,
      ...schemaFields,
      frameworkProvidedPaths: contract.frameworkProvidedPaths,
    },
    factory,
  ) as ts.ObjectLiteralExpression;
}
