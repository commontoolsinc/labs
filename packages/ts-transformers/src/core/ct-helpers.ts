import ts from "typescript";
import { TransformationContext } from "./mod.ts";

export const CT_HELPERS_IDENTIFIER = "__ctHelpers";

const CT_HELPERS_SPECIFIER = "commontools";

const HELPERS_STMT =
  `import * as ${CT_HELPERS_IDENTIFIER} from "${CT_HELPERS_SPECIFIER}";`;

const HELPERS_USED_STMT = `${CT_HELPERS_IDENTIFIER}.NAME; // <internals>`;

export class CTHelpers {
  #sourceFile: ts.SourceFile;
  #factory: ts.NodeFactory;
  #helperIdent?: ts.Identifier;

  constructor(params: Pick<TransformationContext, "sourceFile" | "factory">) {
    this.#sourceFile = params.sourceFile;
    this.#factory = params.factory;

    for (const stmt of this.#sourceFile.statements) {
      const symbol = getCTHelpersIdentifier(stmt);
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
  // helper name e.g. `(__ctHelpers.derive)`.
  getHelperExpr(
    name: string,
  ): ts.PropertyAccessExpression {
    if (!this.sourceHasHelpers()) {
      throw new Error("Source file does not contain helpers.");
    }
    return this.#factory.createPropertyAccessExpression(
      this.#helperIdent!,
      name,
    );
  }

  // Returns an QualifiedName of the requested
  // helper name e.g. `__ctHelpers.JSONSchema`.
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
// is not available in the compiled JS.
//
// Source maps are derived from this transformation.
// Take care in maintaining source lines from its input.
//
// This injected statement enables subsequent transformations.
export function transformCtDirective(
  source: string,
): string {
  checkCTHelperVar(source);

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

// Throws if `__ctHelpers` was found as an Identifier
// in the source code.
function checkCTHelperVar(source: string) {
  const sourceFile = ts.createSourceFile(
    "source.tsx",
    source,
    ts.ScriptTarget.ES2023,
  );
  const visitor = (node: ts.Node): ts.Node => {
    if (ts.isIdentifier(node)) {
      if (node.text === CT_HELPERS_IDENTIFIER) {
        throw new Error(
          `Source cannot contain reserved '${CT_HELPERS_IDENTIFIER}' symbol.`,
        );
      }
    }
    return ts.visitEachChild(node, visitor, undefined);
  };
  ts.visitNode(sourceFile, visitor);
}

function getCTHelpersIdentifier(
  statement: ts.Statement,
): ts.Identifier | undefined {
  if (!ts.isImportDeclaration(statement)) return;
  const { importClause, moduleSpecifier } = statement;

  // Check specifier is "commontools"
  if (!ts.isStringLiteral(moduleSpecifier)) return;
  if (moduleSpecifier.text !== CT_HELPERS_SPECIFIER) return;

  // Check it is a namespace import `* as __ctHelpers`
  if (!importClause || !ts.isImportClause(importClause)) return;
  const { namedBindings } = importClause;
  if (!namedBindings || !ts.isNamespaceImport(namedBindings)) return;
  if (namedBindings.name.getText() !== CT_HELPERS_IDENTIFIER) return;
  return namedBindings.name;
}
