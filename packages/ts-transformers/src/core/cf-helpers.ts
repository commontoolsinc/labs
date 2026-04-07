import ts from "typescript";
import { TransformationContext } from "./mod.ts";

export const CF_HELPERS_IDENTIFIER = "__cfHelpers";
export const CT_HELPERS_IDENTIFIER = "__ctHelpers";
export const CT_DATA_HELPER_IDENTIFIER = "__cfDataHelper";
const CT_DATA_HELPER_KEEP_IDENTIFIER = "__cfDataHelperKeep";

const CF_HELPERS_SPECIFIER = "commonfabric";

const HELPERS_STMT =
  `import { ${CT_HELPERS_IDENTIFIER} as ${CF_HELPERS_IDENTIFIER} } from "${CF_HELPERS_SPECIFIER}";`;
const CT_DATA_HELPER_STMT =
  `import { __ct_data as ${CT_DATA_HELPER_IDENTIFIER} } from "${CF_HELPERS_SPECIFIER}";`;
const CT_DATA_HELPER_USED_STMT = `// @ts-ignore: Internals
const ${CT_DATA_HELPER_KEEP_IDENTIFIER} = ${CT_DATA_HELPER_IDENTIFIER};
`;

const HELPERS_USED_STMT = `// @ts-ignore: Internals
function h(...args: any[]) { return ${CF_HELPERS_IDENTIFIER}.h.apply(null, args); }
`;

export class CFHelpers {
  #sourceFile: ts.SourceFile;
  #factory: ts.NodeFactory;
  #helperIdent?: ts.Identifier;
  #dataHelperIdent?: ts.Identifier;

  constructor(params: Pick<TransformationContext, "sourceFile" | "factory">) {
    this.#sourceFile = params.sourceFile;
    this.#factory = params.factory;

    for (const stmt of this.#sourceFile.statements) {
      const helperSymbol = getCFHelpersIdentifier(stmt);
      if (helperSymbol) {
        this.#helperIdent = helperSymbol;
      }

      const dataHelperSymbol = getCTDataHelperIdentifier(stmt);
      if (dataHelperSymbol) {
        this.#dataHelperIdent = dataHelperSymbol;
      }
    }
  }

  sourceHasHelpers(): boolean {
    return !!this.#helperIdent;
  }

  sourceHasDataHelper(): boolean {
    return !!this.#dataHelperIdent;
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

  getDataHelperExpr(originalNode?: ts.Node): ts.Identifier {
    if (!this.sourceHasDataHelper()) {
      throw new Error("Source file does not contain __cfDataHelper.");
    }

    if (!originalNode) {
      return this.#factory.createIdentifier(this.#dataHelperIdent!.text);
    }

    return this.preserveNodeSourceMap(
      this.#factory.createIdentifier(this.#dataHelperIdent!.text),
      originalNode,
      this.#dataHelperIdent!,
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
  if (!lines[0] || !sourceUsesCfDirective(source)) {
    return source;
  }
  return [
    HELPERS_STMT,
    ...lines.slice(1),
    HELPERS_USED_STMT,
  ].join("\n");
}

export function injectCfHelpers(source: string): string {
  checkCFHelperVar(source);
  return [
    HELPERS_STMT,
    source,
    HELPERS_USED_STMT,
  ].join("\n");
}

export function injectCtDataHelper(source: string): string {
  checkReservedHelperVar(source, CT_DATA_HELPER_IDENTIFIER);
  checkReservedHelperVar(source, CT_DATA_HELPER_KEEP_IDENTIFIER);
  return [
    CT_DATA_HELPER_STMT,
    source,
    CT_DATA_HELPER_USED_STMT,
  ].join("\n");
}

export function sourceUsesCfDirective(source: string): boolean {
  const lines = source.split("\n");
  return !!lines[0] && isCTSEnabled(lines[0]);
}

function isCTSEnabled(line: string) {
  return /^\/\/\/\s*<cts-enable\s*\/>/m.test(line);
}

// Throws if `__cfHelpers` was found as an Identifier
// in the source code.
function checkCFHelperVar(source: string) {
  checkReservedHelperVar(source, CF_HELPERS_IDENTIFIER);
}

function checkReservedHelperVar(source: string, identifier: string) {
  const sourceFile = ts.createSourceFile(
    "source.tsx",
    source,
    ts.ScriptTarget.ES2023,
  );
  const visitor = (node: ts.Node): ts.Node => {
    if (ts.isIdentifier(node) && node.text === identifier) {
      throw new Error(
        `Source cannot contain reserved helper symbol '${identifier}'.`,
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

  // Check it imports a named `__ctHelpers` binding aliased to `__cfHelpers`.
  if (!importClause || !ts.isImportClause(importClause)) return;
  const { namedBindings } = importClause;
  if (!namedBindings || !ts.isNamedImports(namedBindings)) return;
  for (const element of namedBindings.elements) {
    const bindingName = element.propertyName ?? element.name;
    if (bindingName.text === CT_HELPERS_IDENTIFIER) {
      return element.name;
    }
  }
  return;
}

function getCTDataHelperIdentifier(
  statement: ts.Statement,
): ts.Identifier | undefined {
  if (!ts.isImportDeclaration(statement)) return;
  const { importClause, moduleSpecifier } = statement;

  if (!ts.isStringLiteral(moduleSpecifier)) return;
  if (moduleSpecifier.text !== CF_HELPERS_SPECIFIER) return;

  if (!importClause || !ts.isImportClause(importClause)) return;
  const { namedBindings } = importClause;
  if (!namedBindings || !ts.isNamedImports(namedBindings)) return;
  for (const element of namedBindings.elements) {
    if (element.name.text !== CT_DATA_HELPER_IDENTIFIER) {
      continue;
    }
    if ((element.propertyName ?? element.name).text !== "__ct_data") {
      continue;
    }
    return element.name;
  }
  return;
}
