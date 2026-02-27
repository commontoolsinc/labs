import ts from "typescript";
import { assert, assertEquals } from "@std/assert";
import { analyzeFunctionCapabilities } from "../../src/policy/mod.ts";

function parseFirstCallback(
  source: string,
): ts.ArrowFunction | ts.FunctionExpression {
  const file = ts.createSourceFile(
    "/test.ts",
    source,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  );

  let callback: ts.ArrowFunction | ts.FunctionExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (callback) return;
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      callback = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);

  if (!callback) {
    throw new Error("Expected a callback expression in test source.");
  }

  return callback;
}

function createProgramWithSource(source: string): {
  program: ts.Program;
  sourceFile: ts.SourceFile;
} {
  const fileName = "/test.ts";
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    strict: true,
    noLib: true,
  };

  const host: ts.CompilerHost = {
    fileExists: (name) => name === fileName,
    readFile: (name) => (name === fileName ? source : undefined),
    directoryExists: () => true,
    getDirectories: () => [],
    getCanonicalFileName: (name) => name,
    getCurrentDirectory: () => "/",
    getNewLine: () => "\n",
    getDefaultLibFileName: () => "lib.d.ts",
    useCaseSensitiveFileNames: () => true,
    writeFile: () => {},
    getSourceFile: (name, languageVersion) =>
      name === fileName
        ? ts.createSourceFile(
          fileName,
          source,
          languageVersion,
          true,
          ts.ScriptKind.TS,
        )
        : undefined,
  };

  const program = ts.createProgram([fileName], options, host);
  const sourceFile = program.getSourceFile(fileName);
  if (!sourceFile) {
    throw new Error("Expected source file in program.");
  }
  return { program, sourceFile };
}

function findArrowByVariableName(
  sourceFile: ts.SourceFile,
  variableName: string,
): ts.ArrowFunction {
  let callback: ts.ArrowFunction | undefined;
  const visit = (node: ts.Node): void => {
    if (callback) return;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === variableName &&
      node.initializer &&
      ts.isArrowFunction(node.initializer)
    ) {
      callback = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  if (!callback) {
    throw new Error(`Expected arrow function variable '${variableName}'.`);
  }
  return callback;
}

function getPaths(
  summary: ReturnType<typeof analyzeFunctionCapabilities>,
  name: string,
): {
  capability: string;
  readPaths: string[];
  writePaths: string[];
  wildcard: boolean;
  passthrough: boolean;
} {
  const param = summary.params.find((entry) => entry.name === name);
  if (!param) {
    throw new Error(`Missing parameter summary for '${name}'.`);
  }
  return {
    capability: param.capability,
    readPaths: param.readPaths.map((path) => path.join(".")),
    writePaths: param.writePaths.map((path) => path.join(".")),
    wildcard: param.wildcard,
    passthrough: param.passthrough,
  };
}

Deno.test("Capability analysis tracks alias assignment chains", () => {
  const fn = parseFirstCallback(
    `const fn = (input) => {
      const alias = input;
      const user = alias.user;
      return user.name;
    };`,
  );
  const summary = analyzeFunctionCapabilities(fn);
  const input = getPaths(summary, "input");

  assertEquals(input.capability, "readonly");
  assert(input.readPaths.includes("user"));
  assert(input.readPaths.includes("user.name"));
});

Deno.test("Capability analysis tracks object destructure aliases", () => {
  const fn = parseFirstCallback(
    `const fn = (input) => {
      const { foo, bar: b, user: { name } } = input;
      return [foo, b, name].join("-");
    };`,
  );
  const summary = analyzeFunctionCapabilities(fn);
  const input = getPaths(summary, "input");

  assertEquals(input.capability, "readonly");
  assert(input.readPaths.includes("foo"));
  assert(input.readPaths.includes("bar"));
  assert(input.readPaths.includes("user.name"));
});

Deno.test("Capability analysis tracks reassignment aliases", () => {
  const fn = parseFirstCallback(
    `const fn = (input) => {
      let current = input;
      current = current.user;
      return current.name;
    };`,
  );
  const summary = analyzeFunctionCapabilities(fn);
  const input = getPaths(summary, "input");

  assertEquals(input.capability, "readonly");
  assert(input.readPaths.includes("user"));
  assert(input.readPaths.includes("user.name"));
});

Deno.test("Capability analysis treats dynamic alias keys as wildcard", () => {
  const fn = parseFirstCallback(
    `const fn = (input, key) => {
      const alias = input;
      return alias[key];
    };`,
  );
  const summary = analyzeFunctionCapabilities(fn);
  const input = getPaths(summary, "input");

  assertEquals(input.wildcard, true);
});

Deno.test("Capability analysis does not record method names as read paths", () => {
  const fn = parseFirstCallback(
    `const fn = (input) => input.get().foo;`,
  );
  const summary = analyzeFunctionCapabilities(fn);
  const input = getPaths(summary, "input");

  assert(input.readPaths.includes(""));
  assert(!input.readPaths.includes("get"));
});

Deno.test("Capability analysis tracks destructured parameter paths", () => {
  const fn = parseFirstCallback(
    `const fn = (_, { input }) => input.key("foo").get();`,
  );
  const summary = analyzeFunctionCapabilities(fn);
  const params = getPaths(summary, "__param1");

  assertEquals(params.capability, "readonly");
  assert(params.readPaths.includes("input.foo"));
  assertEquals(params.wildcard, false);
});

Deno.test("Capability analysis classifies write-only usage", () => {
  const fn = parseFirstCallback(
    `const fn = (input) => {
      input.key("count").set(1);
    };`,
  );
  const summary = analyzeFunctionCapabilities(fn);
  const input = getPaths(summary, "input");

  assertEquals(input.capability, "writeonly");
  assert(input.writePaths.includes("count"));
  assertEquals(input.readPaths.length, 0);
});

Deno.test("Capability analysis classifies read+write usage as writable", () => {
  const fn = parseFirstCallback(
    `const fn = (input) => {
      input.key("count").set(input.key("count").get() + 1);
      return input.key("count").get();
    };`,
  );
  const summary = analyzeFunctionCapabilities(fn);
  const input = getPaths(summary, "input");

  assertEquals(input.capability, "writable");
  assert(input.readPaths.includes("count"));
  assert(input.writePaths.includes("count"));
});

Deno.test("Capability analysis classifies pure passthrough as opaque", () => {
  const fn = parseFirstCallback(
    `const fn = (input) => {
      const alias = input;
      return alias;
    };`,
  );
  const summary = analyzeFunctionCapabilities(fn);
  const input = getPaths(summary, "input");

  assertEquals(input.capability, "opaque");
  assertEquals(input.readPaths.length, 0);
  assertEquals(input.writePaths.length, 0);
  assertEquals(input.passthrough, true);
});

Deno.test("Capability analysis marks root call arguments as wildcard", () => {
  const fn = parseFirstCallback(
    `const fn = (input) => {
      consume(input);
    };`,
  );
  const summary = analyzeFunctionCapabilities(fn);
  const input = getPaths(summary, "input");

  assertEquals(input.capability, "opaque");
  assertEquals(input.passthrough, true);
  assertEquals(input.wildcard, true);
  assertEquals(input.readPaths.length, 0);
  assertEquals(input.writePaths.length, 0);
});

Deno.test(
  "Capability analysis treats new-expression root arguments as passthrough",
  () => {
    const fn = parseFirstCallback(
      `const fn = (input) => {
        return new Wrapper(input);
      };`,
    );
    const summary = analyzeFunctionCapabilities(fn);
    const input = getPaths(summary, "input");

    assertEquals(input.capability, "opaque");
    assertEquals(input.passthrough, true);
    assertEquals(input.wildcard, false);
    assertEquals(input.readPaths.length, 0);
    assertEquals(input.writePaths.length, 0);
  },
);

Deno.test(
  "Capability analysis interprocedural propagation tracks callee reads in compute mode",
  () => {
    const source = `const helper = (value) => value.foo;
const fn = (input) => helper(input);`;
    const { program, sourceFile } = createProgramWithSource(source);
    const checker = program.getTypeChecker();
    const fn = findArrowByVariableName(sourceFile, "fn");

    const summary = analyzeFunctionCapabilities(fn, {
      checker,
      interprocedural: true,
    });
    const input = getPaths(summary, "input");

    assertEquals(input.capability, "readonly");
    assertEquals(input.wildcard, false);
    assert(input.readPaths.includes("foo"));
  },
);

Deno.test(
  "Capability analysis without interprocedural propagation keeps conservative wildcard",
  () => {
    const source = `const helper = (value) => value.foo;
const fn = (input) => helper(input);`;
    const { sourceFile } = createProgramWithSource(source);
    const fn = findArrowByVariableName(sourceFile, "fn");

    const summary = analyzeFunctionCapabilities(fn);
    const input = getPaths(summary, "input");

    assertEquals(input.capability, "opaque");
    assertEquals(input.passthrough, true);
    assertEquals(input.wildcard, true);
    assertEquals(input.readPaths.length, 0);
  },
);
