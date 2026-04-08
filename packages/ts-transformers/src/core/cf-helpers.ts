import ts from "typescript";
import { TransformationContext } from "./mod.ts";

export const CF_HELPERS_IDENTIFIER = "__cfHelpers";
export const CF_DATA_HELPER_IDENTIFIER = "__cfDataHelper";
const CF_DATA_HELPER_KEEP_IDENTIFIER = "__cfDataHelperKeep";

const CF_HELPERS_SPECIFIER = "commonfabric";

const HELPERS_STMT =
  `import { ${CF_HELPERS_IDENTIFIER} } from "${CF_HELPERS_SPECIFIER}";`;
const CF_DATA_HELPER_STMT =
  `import { __cf_data as ${CF_DATA_HELPER_IDENTIFIER} } from "${CF_HELPERS_SPECIFIER}";`;
const CF_DATA_HELPER_USED_STMT = `// @ts-ignore: Internals
const ${CF_DATA_HELPER_KEEP_IDENTIFIER} = ${CF_DATA_HELPER_IDENTIFIER};
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

      const dataHelperSymbol = getCFDataHelperIdentifier(stmt);
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

const CTS_ENABLE_DIRECTIVE_RE = /^\/\/\/\s*<cts-enable\s*\/>/m;
const CF_DISABLE_TRANSFORM_DIRECTIVE_RE =
  /^\/\/\/\s*<cf-disable-transform\s*\/>/m;

// Rewrite a leading transform directive line, or inject helpers by default,
// so the AST transformer pipeline has access to helpers like `derive`.
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
  const firstContentLineIndex = findFirstContentLineIndex(lines);
  if (firstContentLineIndex === null) {
    return source;
  }

  if (sourceDisablesCfTransform(source)) {
    return [
      ...lines.slice(0, firstContentLineIndex),
      "",
      ...lines.slice(firstContentLineIndex + 1),
    ].join("\n");
  }

  if (sourceUsesCfDirective(source)) {
    return [
      ...lines.slice(0, firstContentLineIndex),
      HELPERS_STMT,
      ...lines.slice(firstContentLineIndex + 1),
      HELPERS_USED_STMT,
    ].join("\n");
  }

  return injectCfHelpers(source);
}

export function injectCfHelpers(source: string): string {
  checkCFHelperVar(source);
  return [
    HELPERS_STMT,
    source,
    HELPERS_USED_STMT,
  ].join("\n");
}

export function injectCfDataHelper(source: string): string {
  checkReservedHelperVar(source, CF_DATA_HELPER_IDENTIFIER);
  checkReservedHelperVar(source, CF_DATA_HELPER_KEEP_IDENTIFIER);
  return [
    CF_DATA_HELPER_STMT,
    source,
    CF_DATA_HELPER_USED_STMT,
  ].join("\n");
}

export function sourceUsesCfDirective(source: string): boolean {
  const lines = source.split("\n");
  const firstContentLineIndex = findFirstContentLineIndex(lines);
  return firstContentLineIndex !== null &&
    isCTSEnabled(lines[firstContentLineIndex]!);
}

export function sourceDisablesCfTransform(source: string): boolean {
  const lines = source.split("\n");
  const firstContentLineIndex = findFirstContentLineIndex(lines);
  return firstContentLineIndex !== null &&
    isCFTransformDisabled(lines[firstContentLineIndex]!);
}

function isCTSEnabled(line: string) {
  return CTS_ENABLE_DIRECTIVE_RE.test(line);
}

function isCFTransformDisabled(line: string) {
  return CF_DISABLE_TRANSFORM_DIRECTIVE_RE.test(line);
}

function findFirstContentLineIndex(lines: readonly string[]): number | null {
  for (const [index, line] of lines.entries()) {
    if (line.trim().length > 0) {
      return index;
    }
  }
  return null;
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

  // Check it imports the internal `__cfHelpers` binding from commonfabric.
  if (!importClause || !ts.isImportClause(importClause)) return;
  const { namedBindings } = importClause;
  if (!namedBindings || !ts.isNamedImports(namedBindings)) return;
  for (const element of namedBindings.elements) {
    const bindingName = element.propertyName ?? element.name;
    if (bindingName.text === CF_HELPERS_IDENTIFIER) {
      return element.name;
    }
  }
  return;
}

function getCFDataHelperIdentifier(
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
    if (element.name.text !== CF_DATA_HELPER_IDENTIFIER) {
      continue;
    }
    if ((element.propertyName ?? element.name).text !== "__cf_data") {
      continue;
    }
    return element.name;
  }
  return;
}
