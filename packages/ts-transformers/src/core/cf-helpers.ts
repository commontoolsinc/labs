import ts from "typescript";
import { TransformationContext } from "./mod.ts";

export const CF_HELPERS_IDENTIFIER = "__cfHelpers";

const CF_HELPERS_SPECIFIER = "commonfabric";

const HELPERS_STMT =
  `import * as ${CF_HELPERS_IDENTIFIER} from "${CF_HELPERS_SPECIFIER}";`;

const HELPERS_USED_STMT = `// @ts-ignore: Internals
function h(...args: any[]) { return ${CF_HELPERS_IDENTIFIER}.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = ${CF_HELPERS_IDENTIFIER}.h.fragment`;

export class CFHelpers {
  #sourceFile: ts.SourceFile;
  #factory: ts.NodeFactory;
  #helperIdent?: ts.Identifier;

  constructor(params: Pick<TransformationContext, "sourceFile" | "factory">) {
    this.#sourceFile = params.sourceFile;
    this.#factory = params.factory;

    for (const stmt of this.#sourceFile.statements) {
      const symbol = getCFHelpersIdentifier(stmt);
      if (symbol) {
        this.#helperIdent = symbol;
        break;
      }
    }
  }

  sourceHasHelpers(): boolean {
    return !!this.#helperIdent;
  }

  // Returns an PropertyAccessExpression of the requested
  // helper name e.g. `(__cfHelpers.derive)`.
  preserveNodeSourceMap<T extends ts.Node>(
    node: T,
    originalNode: ts.Node,
    identityNode?: ts.Node,
  ): T {
    const sourceMapRange = ts.getSourceMapRange(originalNode) ?? originalNode;
    const preserved = ts.setSourceMapRange(node, sourceMapRange);
    return identityNode
      ? ts.setOriginalNode(preserved, identityNode) as T
      : preserved as T;
  }
  getHelperExpr(
    name: string,
    originalNode?: ts.Node,
  ): ts.PropertyAccessExpression {
    if (!this.sourceHasHelpers()) {
      throw new Error("Source file does not contain helpers.");
    }

    if (!originalNode) {
      return this.#factory.createPropertyAccessExpression(
        this.#helperIdent!,
        name,
      );
    }

    const helperIdent = this.preserveNodeSourceMap(
      this.#factory.createIdentifier(this.#helperIdent!.text),
      originalNode,
      this.#helperIdent!,
    );
    const helperName = this.preserveNodeSourceMap(
      this.#factory.createIdentifier(name),
      originalNode,
    );
    return this.preserveNodeSourceMap(
      this.#factory.createPropertyAccessExpression(
        helperIdent,
        helperName,
      ),
      originalNode,
    );
  }

  createHelperCall(
    name: string,
    originalNode: ts.Node,
    typeArguments: readonly ts.TypeNode[] | undefined,
    argumentsArray: readonly ts.Expression[],
  ): ts.CallExpression {
    return this.preserveNodeSourceMap(
      this.#factory.createCallExpression(
        this.getHelperExpr(name, originalNode),
        typeArguments,
        argumentsArray,
      ),
      originalNode,
    );
  }

  // Returns an QualifiedName of the requested
  // helper name e.g. `__cfHelpers.JSONSchema`.
  getHelperQualified(
    name: string,
  ): ts.QualifiedName {
    if (!this.sourceHasHelpers()) {
      throw new Error("Source file does not contain helpers.");
    }
    return this.#factory.createQualifiedName(
      this.#helperIdent!,
      name,
    );
  }
}

// Replace a `/// <cts-enable />` directive line with an
// internal import statement for use by the AST transformer
// to provide access to helpers like `derive`, etc.
// This operates on strings, and to be used outside of
// the TypeScript transformer pipeline, since symbol binding
// occurs before transformers run.
//
// We must also inject usage of the module before the AST transformer
// pipeline, otherwise the binding fails, and the helper module
// is not available in the compiled JS. We repropagate the jsx `h`
// function, which allows authors to not manually specify the import,
// as well as "use" the helper to avoid treeshaking/binding failure.
//
// Source maps are derived from this transformation.
// Take care in maintaining source lines from its input.
//
// This injected statement enables subsequent transformations.
export function transformCfDirective(
  source: string,
): string {
  checkCFHelperVar(source);

  const lines = source.split("\n");
  if (!lines[0] || !isCTSEnabled(lines[0])) {
    return source;
  }
  return [
    HELPERS_STMT,
    ...lines.slice(1),
    HELPERS_USED_STMT,
  ].join("\n");
}

function isCTSEnabled(line: string) {
  return /^\/\/\/\s*<cts-enable\s*\/>/m.test(line);
}

// Throws if `__cfHelpers` was found as an Identifier
// in the source code.
function checkCFHelperVar(source: string) {
  const sourceFile = ts.createSourceFile(
    "source.tsx",
    source,
    ts.ScriptTarget.ES2023,
  );
  const visitor = (node: ts.Node): ts.Node => {
    if (ts.isIdentifier(node) && node.text === CF_HELPERS_IDENTIFIER) {
      throw new Error(
        `Source cannot contain reserved '${CF_HELPERS_IDENTIFIER}' symbol.`,
      );
    }
    return ts.visitEachChild(node, visitor, undefined);
  };
  ts.visitNode(sourceFile, visitor);
}

function getCFHelpersIdentifier(
  statement: ts.Statement,
): ts.Identifier | undefined {
  if (!ts.isImportDeclaration(statement)) return;
  const { importClause, moduleSpecifier } = statement;

  // Check specifier is "commonfabric"
  if (!ts.isStringLiteral(moduleSpecifier)) return;
  if (moduleSpecifier.text !== CF_HELPERS_SPECIFIER) return;

  // Check it is a namespace import `* as __cfHelpers`
  if (!importClause || !ts.isImportClause(importClause)) return;
  const { namedBindings } = importClause;
  if (!namedBindings || !ts.isNamespaceImport(namedBindings)) return;
  if (namedBindings.name.text !== CF_HELPERS_IDENTIFIER) return;
  return namedBindings.name;
}
