import ts from "typescript";

/**
 * Information about exports in a TypeScript source file
 */
export interface ExportInfo {
  /**
   * Names of all named exports in the file
   * e.g., for `export { foo, bar }` returns ["foo", "bar"]
   */
  namedExports: string[];

  /**
   * Whether the file has a default export
   * Detects: export default <expr>, export default function/class, export { x as default }
   */
  hasDefaultExport: boolean;
}

/**
 * Analyzes a TypeScript source file to determine what it exports.
 *
 * @param sourceCode - The TypeScript source code as a string
 * @param fileName - Optional filename for better error messages
 * @returns Object with namedExports array and hasDefaultExport boolean
 *
 * @example
 * ```ts
 * const info = getExportInfo(`
 *   export const foo = 1;
 *   export function bar() {}
 *   export default class Baz {}
 * `);
 * // info = { namedExports: ["foo", "bar"], hasDefaultExport: true }
 * ```
 */
export function getExportInfo(
  sourceCode: string,
  fileName = "source.ts",
): ExportInfo {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceCode,
    ts.ScriptTarget.Latest,
    true,
  );

  const namedExports: string[] = [];
  let hasDefaultExport = false;

  for (const statement of sourceFile.statements) {
    // Check for: export default <expression>
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      hasDefaultExport = true;
      continue;
    }

    // Check for: export default function/class
    if (
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement)
    ) {
      const mods = ts.canHaveModifiers(statement)
        ? ts.getModifiers(statement)
        : undefined;
      if (mods?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) {
        hasDefaultExport = true;
        continue;
      }
    }

    // Check for export declarations: export { ... }, export const/function/etc
    if (ts.isExportDeclaration(statement)) {
      const exportClause = statement.exportClause;
      if (exportClause && ts.isNamedExports(exportClause)) {
        for (const element of exportClause.elements) {
          const exportedName = element.name.text;
          // Check if this is: export { x as default }
          if (exportedName === "default") {
            hasDefaultExport = true;
          } else {
            namedExports.push(exportedName);
          }
        }
      }
      continue;
    }

    // Check for: export const/let/var/function/class/type/interface/enum
    const modifiers = ts.canHaveModifiers(statement)
      ? ts.getModifiers(statement)
      : undefined;
    if (modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
      // Variable declarations: export const foo = 1, bar = 2;
      if (ts.isVariableStatement(statement)) {
        for (const decl of statement.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) {
            namedExports.push(decl.name.text);
          }
        }
      } // Function declarations: export function foo() {}
      else if (ts.isFunctionDeclaration(statement) && statement.name) {
        namedExports.push(statement.name.text);
      } // Class declarations: export class Foo {}
      else if (ts.isClassDeclaration(statement) && statement.name) {
        namedExports.push(statement.name.text);
      } // Type alias: export type Foo = ...
      else if (ts.isTypeAliasDeclaration(statement)) {
        namedExports.push(statement.name.text);
      } // Interface: export interface Foo {}
      else if (ts.isInterfaceDeclaration(statement)) {
        namedExports.push(statement.name.text);
      } // Enum: export enum Foo {}
      else if (ts.isEnumDeclaration(statement)) {
        namedExports.push(statement.name.text);
      }
    }
  }

  return { namedExports, hasDefaultExport };
}
