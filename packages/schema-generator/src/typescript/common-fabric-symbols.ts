import ts from "typescript";

const COMMONFABRIC_DECLARATION = "commonfabric.d.ts";
const COMMONFABRIC_MODULE_NAME = "commonfabric";
const COMMONFABRIC_PACKAGE_PREFIX = "@commonfabric/";

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

export function isCommonFabricDeclaration(
  declaration: ts.Declaration,
): boolean {
  if (
    isCommonFabricDeclarationSourceFile(
      declaration.getSourceFile().fileName,
    )
  ) {
    return true;
  }

  let current: ts.Node | undefined = declaration;
  while (current) {
    if (
      ts.isModuleDeclaration(current) &&
      ts.isStringLiteral(current.name) &&
      isCommonFabricModuleName(current.name.text)
    ) {
      return true;
    }
    current = current.parent;
  }

  return false;
}

function isCommonFabricDeclarationSourceFile(fileName: string): boolean {
  const normalized = fileName.replace(/\\/g, "/");
  return normalized === COMMONFABRIC_DECLARATION ||
    normalized.endsWith(`/${COMMONFABRIC_DECLARATION}`) ||
    normalized.endsWith("/packages/api/index.ts") ||
    normalized.includes("/@commonfabric/api/") ||
    normalized.includes("/packages/runner/src/");
}

/** Checks whether a TypeScript symbol is declared by Common Fabric itself. */
export function isCommonFabricSymbol(symbol: ts.Symbol): boolean {
  return (symbol.getDeclarations() ?? []).some(isCommonFabricDeclaration);
}
