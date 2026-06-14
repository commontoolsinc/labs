import ts from "typescript";
import {
  type FabricRef,
  formatFabricRef,
  parseFabricRef,
  pinnedIdentity,
  withPin,
} from "./sandbox/fabric-import-specifier.ts";

const REWRITE_TARGET = ts.ScriptTarget.ES2023;

export interface PinRewrite {
  specifier: string;
  pinned: string;
  line: number;
}

interface RewriteSpan {
  start: number;
  end: number;
  specifier: string;
  pinned: string;
  line: number;
}

/**
 * Rewrite fabric import/export/import-type specifiers in one source text.
 * Only the inside of string-literal spans is replaced; all surrounding bytes,
 * including the original quote character, are preserved.
 */
export async function rewriteFabricPins(
  contents: string,
  resolvePin: (
    ref: FabricRef,
    specifier: string,
  ) => Promise<string | null>,
): Promise<{ contents: string; rewrites: PinRewrite[] }> {
  const sourceFile = ts.createSourceFile(
    "fabric-pin-rewrite.tsx",
    contents,
    REWRITE_TARGET,
    true,
  );
  const literals = collectImportSpecifierLiterals(sourceFile);
  const replacements: RewriteSpan[] = [];

  for (const literal of literals) {
    const specifier = literal.text;
    const ref = parseFabricRef(specifier);
    if (ref === undefined) continue;

    const pin = await resolvePin(ref, specifier);
    if (pin === null || pinnedIdentity(ref) === pin) continue;

    const pinned = formatFabricRef(withPin(ref, pin));
    const literalStart = literal.getStart(sourceFile);
    const { line } = sourceFile.getLineAndCharacterOfPosition(literalStart);
    replacements.push({
      start: literalStart + 1,
      end: literal.end - 1,
      specifier,
      pinned,
      line: line + 1,
    });
  }

  let rewritten = contents;
  for (
    const replacement of [...replacements].sort((a, b) => b.start - a.start)
  ) {
    rewritten = rewritten.slice(0, replacement.start) + replacement.pinned +
      rewritten.slice(replacement.end);
  }

  return {
    contents: rewritten,
    rewrites: replacements.map(({ specifier, pinned, line }) => ({
      specifier,
      pinned,
      line,
    })),
  };
}

function collectImportSpecifierLiterals(
  sourceFile: ts.SourceFile,
): ts.StringLiteral[] {
  const literals: ts.StringLiteral[] = [];

  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node)) {
      const moduleSpecifier = node.moduleSpecifier;
      if (ts.isStringLiteral(moduleSpecifier)) {
        literals.push(moduleSpecifier);
      }
    }

    if (ts.isExportDeclaration(node)) {
      const moduleSpecifier = node.moduleSpecifier;
      if (moduleSpecifier && ts.isStringLiteral(moduleSpecifier)) {
        literals.push(moduleSpecifier);
      }
    }

    if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      if (
        ts.isLiteralTypeNode(argument) && ts.isStringLiteral(argument.literal)
      ) {
        literals.push(argument.literal);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return literals;
}
