/**
 * Unit tests for symbolDeclaresCommonFabricDefault.
 *
 * The function is meant to return true ONLY for properties whose declared type
 * is the Common Fabric Default<T,V> from `@commonfabric/api` (identified by the
 * source file being named "commonfabric.d.ts").  A user who happens to name
 * their own generic type "Default" must NOT trigger the same special handling.
 */
import ts from "typescript";
import { describe, it } from "@std/testing/bdd";
import { assert, assertFalse } from "@std/assert";
import { symbolDeclaresCommonFabricDefault } from "../../src/core/common-fabric-symbols.ts";

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

/**
 * Build a minimal TypeScript program from an in-memory file map.
 * Files named "commonfabric.d.ts" are included as root files so their global
 * declarations are visible without imports.
 */
function createProgram(sources: Record<string, string>): {
  program: ts.Program;
  checker: ts.TypeChecker;
} {
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    strict: true,
    noLib: true,
    skipLibCheck: true,
  };

  const host: ts.CompilerHost = {
    getSourceFile: (name) => {
      const text = sources[name];
      if (text !== undefined) {
        return ts.createSourceFile(name, text, compilerOptions.target!, true);
      }
      return undefined;
    },
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getDirectories: () => [],
    fileExists: (name) => sources[name] !== undefined,
    readFile: (name) => sources[name],
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    getDefaultLibFileName: () => "lib.d.ts",
  };

  const program = ts.createProgram(Object.keys(sources), compilerOptions, host);
  return { program, checker: program.getTypeChecker() };
}

/**
 * Return the ts.Symbol for a named property on a named interface in the
 * given source file.
 */
function getPropertySymbol(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  interfaceName: string,
  propName: string,
): ts.Symbol | undefined {
  let found: ts.Symbol | undefined;
  ts.forEachChild(sourceFile, (node) => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === interfaceName) {
      const ifaceSymbol = checker.getSymbolAtLocation(node.name);
      if (ifaceSymbol) {
        const ifaceType = checker.getDeclaredTypeOfSymbol(ifaceSymbol);
        found = ifaceType.getProperty(propName);
      }
    }
  });
  return found;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("symbolDeclaresCommonFabricDefault", () => {
  describe("user-defined Default type (should return false)", () => {
    it("returns false when the property type references a user-defined Default alias in the same file", () => {
      // Default is declared in /test.ts — NOT in commonfabric.d.ts.
      const { program, checker } = createProgram({
        "/test.ts": `
          type Default<T, V = T> = T;

          interface MyArgs {
            title: Default<string, "Untitled">;
          }
        `,
      });

      const sf = program.getSourceFile("/test.ts")!;
      const titleSymbol = getPropertySymbol(checker, sf, "MyArgs", "title");

      assertFalse(
        symbolDeclaresCommonFabricDefault(titleSymbol, checker),
        "User-defined Default (same file) must NOT be treated as Common Fabric Default",
      );
    });

    it("returns false when Default is imported from a non-commonfabric file", () => {
      // Even if the alias chain eventually looks like Default, the source file
      // check should disqualify it when it doesn't come from commonfabric.d.ts.
      const { program, checker } = createProgram({
        "/lib/defaults.ts": `
          export type Default<T, V = T> = T;
        `,
        "/test.ts": `
          import type { Default } from "/lib/defaults";

          interface MyArgs {
            count: Default<number, 0>;
          }
        `,
      });

      const sf = program.getSourceFile("/test.ts")!;
      const countSymbol = getPropertySymbol(checker, sf, "MyArgs", "count");

      assertFalse(
        symbolDeclaresCommonFabricDefault(countSymbol, checker),
        "Default from a non-commonfabric file must NOT be treated as Common Fabric Default",
      );
    });

    it("returns false for a user Default used as an optional property", () => {
      const { program, checker } = createProgram({
        "/test.ts": `
          type Default<T, V = T> = T;

          interface Config {
            theme?: Default<string, "dark">;
          }
        `,
      });

      const sf = program.getSourceFile("/test.ts")!;
      const themeSymbol = getPropertySymbol(checker, sf, "Config", "theme");

      assertFalse(
        symbolDeclaresCommonFabricDefault(themeSymbol, checker),
        "Optional property with user-defined Default must NOT be treated as Common Fabric Default",
      );
    });
  });

  describe("Common Fabric Default from commonfabric.d.ts (should return true)", () => {
    it("returns true when the property type references Default declared in commonfabric.d.ts", () => {
      // isCommonFabricSymbol checks fileName.endsWith("commonfabric.d.ts").
      // Declaring Default globally in commonfabric.d.ts and including it as a
      // root file makes it the canonical Common Fabric Default.
      const { program, checker } = createProgram({
        "commonfabric.d.ts": `
          declare const DEFAULT_MARKER: unique symbol;
          declare type Default<T, V = T> = T | (T & { readonly [DEFAULT_MARKER]: T });
        `,
        "/test.ts": `
          interface MyArgs {
            title: Default<string, "Untitled">;
          }
        `,
      });

      const sf = program.getSourceFile("/test.ts")!;
      const titleSymbol = getPropertySymbol(checker, sf, "MyArgs", "title");

      assert(
        symbolDeclaresCommonFabricDefault(titleSymbol, checker),
        "Property typed with Common Fabric Default (from commonfabric.d.ts) must return true",
      );
    });

    it("returns true for an optional property typed with Common Fabric Default", () => {
      const { program, checker } = createProgram({
        "commonfabric.d.ts": `
          declare const DEFAULT_MARKER: unique symbol;
          declare type Default<T, V = T> = T | (T & { readonly [DEFAULT_MARKER]: T });
        `,
        "/test.ts": `
          interface Config {
            theme?: Default<string, "dark">;
          }
        `,
      });

      const sf = program.getSourceFile("/test.ts")!;
      const themeSymbol = getPropertySymbol(checker, sf, "Config", "theme");

      assert(
        symbolDeclaresCommonFabricDefault(themeSymbol, checker),
        "Optional property typed with Common Fabric Default must return true",
      );
    });
  });
});
