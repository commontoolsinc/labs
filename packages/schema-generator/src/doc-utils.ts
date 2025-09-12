import ts from "typescript";

/**
 * Extract plain-text JSDoc from a symbol. Filters out tag lines starting with
 * '@'. Returns undefined when no useful text is present.
 */
export function getSymbolDoc(
  symbol: ts.Symbol | undefined,
  checker: ts.TypeChecker,
): string | undefined {
  if (!symbol) return undefined;
  const parts = symbol.getDocumentationComment(checker);
  // @ts-ignore - displayPartsToString exists on the TS namespace
  const text = ts.displayPartsToString(parts) || "";
  if (!text) return undefined;
  const lines = text.split(/\r?\n/).filter((l) => !l.trim().startsWith("@"));
  const cleaned = lines.join("\n").trim();
  return cleaned || undefined;
}

/**
 * Extract JSDoc comments from a declaration node (if available), filtering out
 * lines starting with '@'. Returns all distinct comment texts.
 */
export function getDeclDocs(decl: ts.Declaration): string[] {
  const docs: string[] = [];
  const jsDocs = (decl as any).jsDoc as Array<ts.JSDoc> | undefined;
  if (jsDocs && jsDocs.length > 0) {
    for (const d of jsDocs) {
      const comment = (d as any).comment as unknown;
      let text = "";
      if (typeof comment === "string") {
        text = comment;
      } else if (Array.isArray(comment)) {
        text = comment
          .map((c) => (typeof c === "string" ? c : (c as any).text ?? ""))
          .join("");
      }
      if (!text) continue;
      const lines = String(text).split(/\r?\n/).filter((l) =>
        !l.trim().startsWith("@")
      );
      const cleaned = lines.join("\n").trim();
      if (cleaned && !docs.includes(cleaned)) docs.push(cleaned);
    }
  }
  return docs;
}

/**
 * Extract merged doc from symbol declarations and the symbol itself, preferring
 * declaration-attached comments from non-declaration files. Returns the first
 * doc text (if any) and the set of all distinct docs discovered.
 */
export function extractDocFromSymbolAndDecls(
  symbol: ts.Symbol | undefined,
  checker: ts.TypeChecker,
): { text?: string; all: string[] } {
  const all: string[] = [];
  if (symbol) {
    const decls = symbol.declarations ?? [];
    for (const decl of decls) {
      const sf = decl.getSourceFile();
      if (!sf.isDeclarationFile) {
        for (const s of getDeclDocs(decl)) if (!all.includes(s)) all.push(s);
      }
    }
  }

  // Only include symbol-level docs if there is a non-declaration-file declaration
  const hasUserDecl = (symbol?.declarations ?? []).some((d) =>
    !d.getSourceFile().isDeclarationFile
  );
  if (hasUserDecl) {
    const symText = getSymbolDoc(symbol, checker);
    if (symText && !all.includes(symText)) all.push(symText);
  }

  const result: { text?: string; all: string[] } = { all };
  if (all[0]) result.text = all[0];
  return result;
}
