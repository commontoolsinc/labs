import { assertEquals, assertExists } from "@std/assert";
import ts from "typescript";
import {
  extractHoistedType,
  HoistingContext,
  isHoistedIdentifierPattern,
  isSelfContainedCallback,
  SourceMapTracker,
} from "../../src/hoisting/mod.ts";

function createTestSourceFile(code: string): ts.SourceFile {
  return ts.createSourceFile(
    "test.ts",
    code,
    ts.ScriptTarget.ES2020,
    true,
  );
}

function createTypeChecker(code: string): {
  program: ts.Program;
  checker: ts.TypeChecker;
  sourceFile: ts.SourceFile;
} {
  const fileName = "test.ts";
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.CommonJS,
    strict: true,
  };

  const host: ts.CompilerHost = {
    getSourceFile: (name) => {
      if (name === fileName) {
        return ts.createSourceFile(
          name,
          code,
          compilerOptions.target!,
          true,
        );
      }
      return undefined;
    },
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getDirectories: () => [],
    fileExists: (name) => name === fileName,
    readFile: (name) => (name === fileName ? code : undefined),
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    getDefaultLibFileName: () => "lib.d.ts",
  };

  const program = ts.createProgram([fileName], compilerOptions, host);
  const sourceFile = program.getSourceFile(fileName)!;
  const checker = program.getTypeChecker();

  return { program, checker, sourceFile };
}

Deno.test("HoistingContext - generateUniqueName", async (t) => {
  await t.step("generates unique names for lift", () => {
    const sourceFile = createTestSourceFile("const x = 1;");
    const ctx = new HoistingContext(sourceFile);

    assertEquals(ctx.generateUniqueName("lift"), "__lift_0");
    assertEquals(ctx.generateUniqueName("lift"), "__lift_1");
    assertEquals(ctx.generateUniqueName("lift"), "__lift_2");
  });

  await t.step("generates unique names for handler", () => {
    const sourceFile = createTestSourceFile("const x = 1;");
    const ctx = new HoistingContext(sourceFile);

    assertEquals(ctx.generateUniqueName("handler"), "__handler_0");
    assertEquals(ctx.generateUniqueName("handler"), "__handler_1");
  });

  await t.step("generates unique names for derive", () => {
    const sourceFile = createTestSourceFile("const x = 1;");
    const ctx = new HoistingContext(sourceFile);

    assertEquals(ctx.generateUniqueName("derive"), "__derive_0");
    assertEquals(ctx.generateUniqueName("derive"), "__derive_1");
  });

  await t.step("maintains separate counters for each type", () => {
    const sourceFile = createTestSourceFile("const x = 1;");
    const ctx = new HoistingContext(sourceFile);

    assertEquals(ctx.generateUniqueName("lift"), "__lift_0");
    assertEquals(ctx.generateUniqueName("handler"), "__handler_0");
    assertEquals(ctx.generateUniqueName("derive"), "__derive_0");
    assertEquals(ctx.generateUniqueName("lift"), "__lift_1");
    assertEquals(ctx.generateUniqueName("handler"), "__handler_1");
  });
});

Deno.test("HoistingContext - registerHoistedDeclaration", async (t) => {
  await t.step("registers a hoisted declaration", () => {
    const sourceFile = createTestSourceFile("const x = 1;");
    const ctx = new HoistingContext(sourceFile);

    const declaration = ts.factory.createVariableStatement(
      undefined,
      ts.factory.createVariableDeclarationList(
        [
          ts.factory.createVariableDeclaration(
            "__lift_0",
            undefined,
            undefined,
            ts.factory.createNumericLiteral("42"),
          ),
        ],
        ts.NodeFlags.Const,
      ),
    );

    const name = ctx.registerHoistedDeclaration(
      declaration,
      "lift",
      sourceFile.statements[0]!,
    );

    assertEquals(name, "__lift_0");
    assertEquals(ctx.hasHoistedDeclarations(), true);
    assertEquals(ctx.getHoistedDeclarations().length, 1);
  });

  await t.step("tracks original position", () => {
    const code = "const x = 1;\nconst y = 2;";
    const sourceFile = createTestSourceFile(code);
    const ctx = new HoistingContext(sourceFile);

    const declaration = ts.factory.createVariableStatement(
      undefined,
      ts.factory.createVariableDeclarationList(
        [
          ts.factory.createVariableDeclaration(
            "__lift_0",
            undefined,
            undefined,
            ts.factory.createNumericLiteral("42"),
          ),
        ],
        ts.NodeFlags.Const,
      ),
    );

    // Use the second statement as the original node
    ctx.registerHoistedDeclaration(
      declaration,
      "lift",
      sourceFile.statements[1]!,
    );

    const hoisted = ctx.getHoistedDeclarations()[0];
    assertExists(hoisted);
    assertEquals(hoisted.originalPosition.line, 2); // Second line
  });
});

Deno.test("SourceMapTracker", async (t) => {
  await t.step("tracks hoisted declarations", () => {
    const tracker = new SourceMapTracker();

    const sourceFile = createTestSourceFile("const x = 1;");
    const ctx = new HoistingContext(sourceFile);

    const declaration = ts.factory.createVariableStatement(
      undefined,
      ts.factory.createVariableDeclarationList(
        [
          ts.factory.createVariableDeclaration(
            "__lift_0",
            undefined,
            undefined,
            ts.factory.createNumericLiteral("42"),
          ),
        ],
        ts.NodeFlags.Const,
      ),
    );

    ctx.registerHoistedDeclaration(
      declaration,
      "lift",
      sourceFile.statements[0]!,
    );

    const hoisted = ctx.getHoistedDeclarations()[0]!;
    tracker.trackHoistedDeclaration(hoisted, {
      line: 1,
      column: 0,
      pos: 0,
    });

    const original = tracker.getOriginalPosition("__lift_0");
    assertExists(original);
    assertEquals(original.line, 1);
  });

  await t.step("serializes and deserializes", () => {
    const tracker = new SourceMapTracker();

    const sourceFile = createTestSourceFile("const x = 1;");
    const ctx = new HoistingContext(sourceFile);

    const declaration = ts.factory.createVariableStatement(
      undefined,
      ts.factory.createVariableDeclarationList(
        [
          ts.factory.createVariableDeclaration(
            "__lift_0",
            undefined,
            undefined,
            ts.factory.createNumericLiteral("42"),
          ),
        ],
        ts.NodeFlags.Const,
      ),
    );

    ctx.registerHoistedDeclaration(
      declaration,
      "lift",
      sourceFile.statements[0]!,
    );

    const hoisted = ctx.getHoistedDeclarations()[0]!;
    tracker.trackHoistedDeclaration(hoisted, {
      line: 1,
      column: 0,
      pos: 0,
    });

    const serialized = tracker.serialize();
    const restored = SourceMapTracker.deserialize(serialized);

    const original = restored.getOriginalPosition("__lift_0");
    assertExists(original);
    assertEquals(original.line, 1);
  });
});

Deno.test("isHoistedIdentifierPattern", async (t) => {
  await t.step("matches lift pattern", () => {
    assertEquals(isHoistedIdentifierPattern("__lift_0"), true);
    assertEquals(isHoistedIdentifierPattern("__lift_123"), true);
  });

  await t.step("matches handler pattern", () => {
    assertEquals(isHoistedIdentifierPattern("__handler_0"), true);
    assertEquals(isHoistedIdentifierPattern("__handler_99"), true);
  });

  await t.step("matches derive pattern", () => {
    assertEquals(isHoistedIdentifierPattern("__derive_0"), true);
    assertEquals(isHoistedIdentifierPattern("__derive_42"), true);
  });

  await t.step("rejects non-matching patterns", () => {
    assertEquals(isHoistedIdentifierPattern("lift_0"), false);
    assertEquals(isHoistedIdentifierPattern("__lift"), false);
    assertEquals(isHoistedIdentifierPattern("__lift_abc"), false);
    assertEquals(isHoistedIdentifierPattern("myVariable"), false);
    assertEquals(isHoistedIdentifierPattern("__other_0"), false);
  });
});

Deno.test("extractHoistedType", async (t) => {
  await t.step("extracts lift type", () => {
    assertEquals(extractHoistedType("__lift_0"), "lift");
    assertEquals(extractHoistedType("__lift_123"), "lift");
  });

  await t.step("extracts handler type", () => {
    assertEquals(extractHoistedType("__handler_0"), "handler");
  });

  await t.step("extracts derive type", () => {
    assertEquals(extractHoistedType("__derive_0"), "derive");
  });

  await t.step("returns undefined for non-matching", () => {
    assertEquals(extractHoistedType("other"), undefined);
    assertEquals(extractHoistedType("__lift"), undefined);
  });
});

Deno.test("isSelfContainedCallback", async (t) => {
  await t.step(
    "identifies callback with no external references as self-contained",
    () => {
      const code = `
      const fn = (x: number) => x * 2;
    `;
      const { checker, sourceFile } = createTypeChecker(code);

      // Find the arrow function
      let arrowFn: ts.ArrowFunction | undefined;
      const visit = (node: ts.Node) => {
        if (ts.isArrowFunction(node)) {
          arrowFn = node;
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);

      assertExists(arrowFn);
      assertEquals(isSelfContainedCallback(arrowFn, checker), true);
    },
  );

  await t.step(
    "identifies callback with external reference as not self-contained",
    () => {
      const code = `
      let counter = 0;
      const fn = () => counter++;
    `;
      const { checker, sourceFile } = createTypeChecker(code);

      // Find the arrow function
      let arrowFn: ts.ArrowFunction | undefined;
      const visit = (node: ts.Node) => {
        if (ts.isArrowFunction(node)) {
          arrowFn = node;
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);

      assertExists(arrowFn);
      assertEquals(isSelfContainedCallback(arrowFn, checker), false);
    },
  );

  await t.step(
    "allows callbacks that reference module-scope const",
    () => {
      const code = `
      const MULTIPLIER = 2;
      const fn = (x: number) => x * MULTIPLIER;
    `;
      const { checker, sourceFile } = createTypeChecker(code);

      // Find the arrow function
      let arrowFn: ts.ArrowFunction | undefined;
      const visit = (node: ts.Node) => {
        if (ts.isArrowFunction(node)) {
          arrowFn = node;
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);

      assertExists(arrowFn);
      assertEquals(isSelfContainedCallback(arrowFn, checker), true);
    },
  );

  await t.step(
    "identifies callback with local variables as self-contained",
    () => {
      const code = `
      const fn = (x: number) => {
        const doubled = x * 2;
        return doubled + 1;
      };
    `;
      const { checker, sourceFile } = createTypeChecker(code);

      // Find the arrow function
      let arrowFn: ts.ArrowFunction | undefined;
      const visit = (node: ts.Node) => {
        if (ts.isArrowFunction(node)) {
          arrowFn = node;
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);

      assertExists(arrowFn);
      assertEquals(isSelfContainedCallback(arrowFn, checker), true);
    },
  );
});
