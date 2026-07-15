import ts from "typescript";

const COMMONFABRIC_MODULE_NAME = "commonfabric";
const COMMONFABRIC_PACKAGE_PREFIX = "@commonfabric/";

/** Exact compiler-owned declaration sources trusted by each checker. */
const TRUSTED_SOURCES = new WeakMap<
  ts.TypeChecker,
  WeakSet<ts.SourceFile>
>();

export function isCommonFabricModuleName(moduleName: string): boolean {
  return moduleName === COMMONFABRIC_MODULE_NAME ||
    moduleName.startsWith(COMMONFABRIC_PACKAGE_PREFIX);
}

export function getImportTypeModuleName(
  typeNode: ts.ImportTypeNode,
): string | undefined {
  const argument = typeNode.argument;
  if (!ts.isLiteralTypeNode(argument)) return undefined;
  return ts.isStringLiteral(argument.literal)
    ? argument.literal.text
    : undefined;
}

/**
 * Register declaration sources selected by a trusted compiler/module resolver.
 * File names and module strings are lookup inputs only; SourceFile object
 * identity is the authority checked below.
 */
export function registerCommonFabricDeclarationSources(
  checker: ts.TypeChecker,
  sources: Iterable<ts.SourceFile>,
): void {
  let trusted = TRUSTED_SOURCES.get(checker);
  if (!trusted) {
    trusted = new WeakSet();
    TRUSTED_SOURCES.set(checker, trusted);
  }
  for (const source of sources) trusted.add(source);
}

export function isCommonFabricDeclaration(
  declaration: ts.Declaration,
  checker: ts.TypeChecker,
): boolean {
  return TRUSTED_SOURCES.get(checker)?.has(declaration.getSourceFile()) ??
    false;
}

/** Checks whether a symbol is declared by a compiler-trusted Common Fabric source. */
export function isCommonFabricSymbol(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
): boolean {
  return (symbol.getDeclarations() ?? []).some((declaration) =>
    isCommonFabricDeclaration(declaration, checker)
  );
}
