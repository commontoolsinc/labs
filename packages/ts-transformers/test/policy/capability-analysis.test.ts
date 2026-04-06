import ts from "typescript";
import { assert, assertEquals } from "@std/assert";
import { analyzeFunctionCapabilities } from "../../src/policy/mod.ts";
import { COMMONFABRIC_TYPES } from "../commonfabric-test-types.ts";

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
  return createProgramWithFiles({
    "/test.ts": source,
  });
}

function createProgramWithFiles(
  files: Record<string, string>,
  entryFileName = "/test.ts",
): {
  program: ts.Program;
  sourceFile: ts.SourceFile;
} {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    strict: true,
    noLib: true,
  };

  const host: ts.CompilerHost = {
    fileExists: (name) => files[name] !== undefined,
    readFile: (name) => files[name],
    directoryExists: () => true,
    getDirectories: () => [],
    getCanonicalFileName: (name) => name,
    getCurrentDirectory: () => "/",
    getNewLine: () => "\n",
    getDefaultLibFileName: () => "lib.d.ts",
    useCaseSensitiveFileNames: () => true,
    writeFile: () => {},
    getSourceFile: (name, languageVersion) =>
      files[name] !== undefined
        ? ts.createSourceFile(
          name,
          files[name]!,
          languageVersion,
          true,
          name.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
        )
        : undefined,
    resolveModuleNames: (moduleNames) =>
      moduleNames.map((name) => {
        const directMatch = Object.keys(files).find((fileName) =>
          fileName === `/${name}.d.ts` ||
          fileName.endsWith(`/${name}.d.ts`)
        );
        if (!directMatch) {
          return undefined;
        }
        return {
          resolvedFileName: directMatch,
          extension: ts.Extension.Dts,
          isExternalLibraryImport: false,
        };
      }),
  };

  const program = ts.createProgram([entryFileName], options, host);
  const sourceFile = program.getSourceFile(entryFileName);
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
  identityOnly: boolean;
  identityPaths: string[];
  identityCellPaths: string[];
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
    identityOnly: !!param.identityOnly,
    identityPaths: (param.identityPaths ?? []).map((path) => path.join(".")),
    identityCellPaths: (param.identityCellPaths ?? []).map((path) =>
      path.join(".")
    ),
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

Deno.test("TypeScript exposes accessor fields as property declarations", () => {
  const file = ts.createSourceFile(
    "/test.ts",
    `
function tracked(
  _value: undefined,
  _context: ClassAccessorDecoratorContext<Example, number>,
) {}

class Example {
  @tracked accessor count = 1;
}
`,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  );

  let property: ts.PropertyDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (property) return;
    if (ts.isPropertyDeclaration(node)) {
      property = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);

  assert(property);
  assertEquals(property.name.getText(file), "count");
  assert(
    property.modifiers?.some((modifier) =>
      modifier.kind === ts.SyntaxKind.AccessorKeyword
    ),
  );
  assert(
    property.modifiers?.some((modifier) =>
      modifier.kind === ts.SyntaxKind.Decorator
    ),
  );
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

Deno.test("Capability analysis does not descend into nested callbacks", () => {
  const fn = parseFirstCallback(
    `const fn = (input) => {
      const local = () => input.hidden;
      return input.visible;
    };`,
  );
  const summary = analyzeFunctionCapabilities(fn);
  const input = getPaths(summary, "input");

  assertEquals(input.capability, "readonly");
  assert(input.readPaths.includes("visible"));
  assert(!input.readPaths.includes("hidden"));
});

Deno.test(
  "Capability analysis counts outer captures used inside inline array callbacks",
  () => {
    const { program, sourceFile } = createProgramWithSource(
      `
      interface Array<T> {
        filter(predicate: (value: T) => boolean): Array<T>;
        map<U>(mapper: (value: T) => U): Array<U>;
      }

      const fn = (input: {
        items: number[];
        threshold: number;
        factor: number;
      }) => input.items
        .filter((value) => value > input.threshold)
        .map((value) => value * input.factor);
      `,
    );
    const summary = analyzeFunctionCapabilities(
      findArrowByVariableName(sourceFile, "fn"),
      { checker: program.getTypeChecker() },
    );
    const input = getPaths(summary, "input");

    assertEquals(input.capability, "readonly");
    assert(input.readPaths.includes("items"));
    assert(input.readPaths.includes("threshold"));
    assert(input.readPaths.includes("factor"));
  },
);

Deno.test(
  "Capability analysis counts outer captures used inside other eager array callbacks",
  () => {
    const { program, sourceFile } = createProgramWithSource(
      `
      interface Array<T> {
        find(
          predicate: (value: T) => boolean,
        ): T | undefined;
        findIndex(
          predicate: (value: T) => boolean,
        ): number;
        reduce<U>(
          reducer: (accumulator: U, value: T) => U,
          initialValue: U,
        ): U;
      }

      const fn = (input: {
        names: string[];
        searchTerm: string;
        prices: number[];
        discount: number;
        items: { id: string }[];
        selectedId: string;
      }) => ({
        match: input.names.find((name) => name.includes(input.searchTerm)),
        total: input.prices.reduce(
          (sum, price) => sum + price * (1 - input.discount),
          0,
        ),
        index: input.items.findIndex((item) => item.id === input.selectedId),
      });
      `,
    );
    const summary = analyzeFunctionCapabilities(
      findArrowByVariableName(sourceFile, "fn"),
      { checker: program.getTypeChecker() },
    );
    const input = getPaths(summary, "input");

    assertEquals(input.capability, "readonly");
    assert(input.readPaths.includes("names"));
    assert(input.readPaths.includes("searchTerm"));
    assert(input.readPaths.includes("prices"));
    assert(input.readPaths.includes("discount"));
    assert(input.readPaths.includes("items"));
    assert(input.readPaths.includes("selectedId"));
  },
);

Deno.test(
  "Capability analysis keeps opaque helper callbacks out of outer summaries",
  () => {
    const { program, sourceFile } = createProgramWithSource(
      `
      declare function later(callback: () => void): void;

      const fn = (input: {
        visible: number;
        hidden: number;
      }) => {
        later(() => input.hidden);
        return input.visible;
      };
      `,
    );
    const summary = analyzeFunctionCapabilities(
      findArrowByVariableName(sourceFile, "fn"),
      { checker: program.getTypeChecker() },
    );
    const input = getPaths(summary, "input");

    assertEquals(input.capability, "readonly");
    assert(input.readPaths.includes("visible"));
    assert(!input.readPaths.includes("hidden"));
  },
);

Deno.test(
  "Capability analysis keeps dotted literal keys distinct from nested member paths",
  () => {
    const fn = parseFirstCallback(
      `const fn = (input) => {
      const direct = input["a.b"];
      const nested = input.a.b;
      return direct ?? nested;
    };`,
    );
    const summary = analyzeFunctionCapabilities(fn);
    const input = summary.params.find((entry) => entry.name === "input");
    if (!input) {
      throw new Error("Missing parameter summary for 'input'.");
    }

    const readPathKeys = input.readPaths.map((path) => JSON.stringify(path));
    assert(readPathKeys.includes('["a.b"]'));
    assert(readPathKeys.includes('["a","b"]'));
  },
);

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

  // .get() is transparent — input.get().foo resolves to path ["foo"]
  assert(input.readPaths.includes("foo"));
  assert(!input.readPaths.includes("get"));
  assert(!input.readPaths.includes(""));
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
  assertEquals(input.identityOnly, false);
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

Deno.test("Capability analysis marks for...in over tracked source as wildcard", () => {
  const fn = parseFirstCallback(
    `const fn = (input) => {
      for (const key in input) {
        console.log(key);
      }
    };`,
  );
  const summary = analyzeFunctionCapabilities(fn);
  const input = getPaths(summary, "input");

  assertEquals(input.wildcard, true);
});

Deno.test("Capability analysis marks for...of over tracked source as wildcard", () => {
  const fn = parseFirstCallback(
    `const fn = (input) => {
      for (const item of input) {
        console.log(item);
      }
    };`,
  );
  const summary = analyzeFunctionCapabilities(fn);
  const input = getPaths(summary, "input");

  assertEquals(input.wildcard, true);
});

Deno.test(
  "Capability analysis keeps ?? fallback aliases path-specific through for...of item reads",
  () => {
    const fn = parseFirstCallback(
      `const fn = (input) => {
        const items = input.items ?? [];
        for (const item of items) {
          item.notes?.length;
        }
      };`,
    );
    const summary = analyzeFunctionCapabilities(fn);
    const input = getPaths(summary, "input");

    assertEquals(input.wildcard, false);
    assert(input.readPaths.includes("items"));
    assert(input.readPaths.includes("items.notes.length"));
  },
);

Deno.test(
  "Capability analysis treats equals() arguments as identity-only",
  () => {
    const fn = parseFirstCallback(
      `const fn = (input, other) => {
        return equals(input, other);
      };`,
    );
    const summary = analyzeFunctionCapabilities(fn);
    const input = getPaths(summary, "input");
    const other = getPaths(summary, "other");

    assertEquals(input.capability, "opaque");
    assertEquals(input.passthrough, true);
    assertEquals(input.wildcard, false);
    assertEquals(input.identityOnly, true);
    assertEquals(input.readPaths.length, 0);

    assertEquals(other.capability, "opaque");
    assertEquals(other.passthrough, true);
    assertEquals(other.wildcard, false);
    assertEquals(other.identityOnly, true);
    assertEquals(other.readPaths.length, 0);
  },
);

Deno.test(
  "Capability analysis treats .equals() receiver and argument as identity-only",
  () => {
    const fn = parseFirstCallback(
      `const fn = (input, other) => {
        return input.equals(other);
      };`,
    );
    const summary = analyzeFunctionCapabilities(fn);
    const input = getPaths(summary, "input");
    const other = getPaths(summary, "other");

    assertEquals(input.capability, "opaque");
    assertEquals(input.passthrough, true);
    assertEquals(input.wildcard, false);
    assertEquals(input.identityOnly, true);
    assertEquals(input.readPaths.length, 0);

    assertEquals(other.capability, "opaque");
    assertEquals(other.passthrough, true);
    assertEquals(other.wildcard, false);
    assertEquals(other.identityOnly, true);
    assertEquals(other.readPaths.length, 0);
  },
);

Deno.test(
  "Capability analysis marks destructured cell equals paths as identity-cell paths",
  () => {
    const { program, sourceFile } = createProgramWithSource(
      `
      declare const CELL_BRAND: unique symbol;

      type Writable<T> = {
        readonly [CELL_BRAND]: "cell";
        equals(other: Writable<T>): boolean;
      };

      const fn = ({ left, right }: {
        left: Writable<{ name: string }>;
        right: Writable<{ name: string }>;
      }) => left.equals(right);
      `,
    );
    const summary = analyzeFunctionCapabilities(
      findArrowByVariableName(sourceFile, "fn"),
      { checker: program.getTypeChecker() },
    );
    const input = getPaths(summary, "__param0");

    assertEquals(input.identityOnly, false);
    assert(input.identityPaths.includes("left"));
    assert(input.identityPaths.includes("right"));
    assert(input.identityCellPaths.includes("left"));
    assert(input.identityCellPaths.includes("right"));
  },
);

Deno.test(
  "Capability analysis marks inferred derive cell equals paths as identity-cell paths",
  () => {
    const { program, sourceFile } = createProgramWithFiles({
      "/test.ts": `
        import { derive, type Writable } from "commonfabric";

        type Piece = Writable<{ name: string }>;
        const left = {} as Piece;
        const right = {} as Piece;
        const same = derive({ left, right }, ({ left, right }) =>
          left.equals(right)
        );
      `,
      "/commonfabric.d.ts": COMMONFABRIC_TYPES["commonfabric.d.ts"]!,
    });
    const checker = program.getTypeChecker();
    const callback = (() => {
      let found: ts.ArrowFunction | undefined;
      const visit = (node: ts.Node): void => {
        if (found) return;
        if (ts.isArrowFunction(node) && node.parameters.length === 1) {
          found = node;
          return;
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
      if (!found) {
        throw new Error("Expected derive callback.");
      }
      return found;
    })();
    const summary = analyzeFunctionCapabilities(callback, { checker });
    const input = getPaths(summary, "__param0");

    assert(input.identityPaths.includes("left"));
    assert(input.identityPaths.includes("right"));
    assert(input.identityCellPaths.includes("left"));
    assert(input.identityCellPaths.includes("right"));
  },
);

Deno.test(
  "Capability analysis tracks known fixed-symbol element access without wildcard",
  () => {
    const { program, sourceFile } = createProgramWithSource(
      `
      declare const NAME: unique symbol;
      declare const UI: unique symbol;
      declare const SELF: unique symbol;

      const fn = (input: {
        [NAME]?: string;
        [UI]?: { node: string };
        [SELF]?: { id: string };
        extra: number;
      }) => [input[NAME], input[UI], input[SELF]];
      `,
    );
    const summary = analyzeFunctionCapabilities(
      findArrowByVariableName(sourceFile, "fn"),
      { checker: program.getTypeChecker() },
    );
    const input = getPaths(summary, "input");

    assertEquals(input.wildcard, false);
    assert(input.readPaths.includes("$NAME"));
    assert(input.readPaths.includes("$UI"));
    assert(input.readPaths.includes("$SELF"));
    assertEquals(input.readPaths.includes("extra"), false);
  },
);

Deno.test(
  "Capability analysis tracks known fixed-symbol destructuring without wildcard",
  () => {
    const { program, sourceFile } = createProgramWithSource(
      `
      declare const SELF: unique symbol;

      const fn = (
        { [SELF]: self, value }: { [SELF]?: { id: string }; value: string },
      ) => self?.id ?? value;
      `,
    );
    const summary = analyzeFunctionCapabilities(
      findArrowByVariableName(sourceFile, "fn"),
      { checker: program.getTypeChecker() },
    );
    const input = getPaths(summary, "__param0");

    assertEquals(input.wildcard, false);
    assert(input.readPaths.includes("$SELF.id"));
    assert(input.readPaths.includes("value"));
  },
);

Deno.test(
  "Capability analysis keeps for...of over tracked sub-path path-specific",
  () => {
    const fn = parseFirstCallback(
      `const fn = (input) => {
      for (const item of input.items) {
        item.name;
      }
    };`,
    );
    const summary = analyzeFunctionCapabilities(fn);
    const input = getPaths(summary, "input");

    assertEquals(input.wildcard, false);
    assert(input.readPaths.includes("items"));
    assert(input.readPaths.includes("items.name"));
  },
);

Deno.test(
  "Capability analysis handles deeply nested mutual recursion without hanging",
  () => {
    const source = `
const f = (a) => g(a);
const g = (b) => h(b);
const h = (c) => f(c);
const main = (input) => f(input);`;
    const { program, sourceFile } = createProgramWithSource(source);
    const checker = program.getTypeChecker();
    const main = findArrowByVariableName(sourceFile, "main");

    const summary = analyzeFunctionCapabilities(main, {
      checker,
      interprocedural: true,
    });

    // The cycle should be detected — `f` is recursive, so the interprocedural
    // analysis bails out with { recursive: true } for `f`, which means
    // `main`'s argument falls through to the conservative wildcard path.
    const input = getPaths(summary, "input");
    assertEquals(input.wildcard, true);
  },
);

Deno.test(
  "Capability analysis interprocedural with default parameters does not corrupt paths",
  () => {
    const source = `
const callee = (x, y = 0) => x.foo;
const caller = (input) => callee(input);`;
    const { program, sourceFile } = createProgramWithSource(source);
    const checker = program.getTypeChecker();
    const caller = findArrowByVariableName(sourceFile, "caller");

    const summary = analyzeFunctionCapabilities(caller, {
      checker,
      interprocedural: true,
    });
    const input = getPaths(summary, "input");

    assertEquals(input.capability, "readonly");
    assert(input.readPaths.includes("foo"));
    assertEquals(input.wildcard, false);
  },
);

Deno.test(
  "Capability analysis interprocedural propagation stays conservative across source-file boundaries",
  () => {
    const { program, sourceFile } = createProgramWithFiles({
      "/helper.ts": `const helper = (value) => value.foo;`,
      "/test.ts": `const fn = (input) => helper(input);`,
    });
    const checker = program.getTypeChecker();
    const fn = findArrowByVariableName(sourceFile, "fn");

    const summary = analyzeFunctionCapabilities(fn, {
      checker,
      interprocedural: true,
    });
    const input = getPaths(summary, "input");

    assertEquals(input.capability, "opaque");
    assertEquals(input.passthrough, true);
    assertEquals(input.wildcard, true);
    assertEquals(input.readPaths.length, 0);
  },
);
