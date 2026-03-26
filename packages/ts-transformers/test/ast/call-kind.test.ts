import { assertEquals } from "@std/assert";
import ts from "typescript";

import {
  classifyArrayCallbackContainerCall,
  classifyArrayMethodCallSite,
  detectCallKind,
  getCapabilitySummaryCallbackArgument,
  getPatternBuilderCallbackArgument,
} from "../../src/ast/mod.ts";

function createProgram(source: string): {
  sourceFile: ts.SourceFile;
  checker: ts.TypeChecker;
} {
  const fileName = "/test.ts";
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    strict: true,
    noLib: true,
    skipLibCheck: true,
  };

  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    compilerOptions.target!,
    true,
  );

  const host = ts.createCompilerHost(compilerOptions, true);
  host.getSourceFile = (name) => name === fileName ? sourceFile : undefined;
  host.getCurrentDirectory = () => "/";
  host.getDirectories = () => [];
  host.fileExists = (name) => name === fileName;
  host.readFile = (name) => name === fileName ? source : undefined;
  host.writeFile = () => {};
  host.useCaseSensitiveFileNames = () => true;
  host.getCanonicalFileName = (name) => name;
  host.getNewLine = () => "\n";

  const program = ts.createProgram([fileName], compilerOptions, host);
  return { sourceFile, checker: program.getTypeChecker() };
}

function findInitializer(
  sourceFile: ts.SourceFile,
  declarationName: string,
): ts.Expression {
  let found: ts.Expression | undefined;

  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === declarationName &&
      node.initializer
    ) {
      found = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  if (!found) {
    throw new Error(`Initializer for ${declarationName} not found`);
  }

  return found;
}

Deno.test("detectCallKind keeps array-method as a family classification while call-site ownership distinguishes plain arrays", () => {
  const { sourceFile, checker } = createProgram(`
    interface Array<T> {
      map<U>(callback: (value: T) => U): U[];
    }

    const value = [1, 2, 3].map((n: number) => n + 1);
  `);

  const expression = findInitializer(sourceFile, "value");
  if (!ts.isCallExpression(expression)) {
    throw new Error("Expected call expression initializer");
  }

  assertEquals(detectCallKind(expression, checker)?.kind, "array-method");
  assertEquals(classifyArrayMethodCallSite(expression, checker), {
    family: "map",
    lowered: false,
    ownership: "plain",
  });
  assertEquals(
    classifyArrayCallbackContainerCall(expression, checker),
    "plain-array-value",
  );
});

Deno.test("classifyArrayMethodCallSite reports reactive ownership for reactive receivers", () => {
  const { sourceFile, checker } = createProgram(`
    declare function derive<T>(value: T): T;

    const value = derive([1, 2, 3]).map((n: number) => n + 1);
  `);

  const expression = findInitializer(sourceFile, "value");
  if (!ts.isCallExpression(expression)) {
    throw new Error("Expected call expression initializer");
  }

  assertEquals(classifyArrayMethodCallSite(expression, checker), {
    family: "map",
    lowered: false,
    ownership: "reactive",
  });
  assertEquals(
    classifyArrayCallbackContainerCall(expression, checker),
    "reactive-array-method",
  );
});

Deno.test("classifyArrayMethodCallSite treats lowered *WithPattern methods as reactive when the receiver is reactive", () => {
  const { sourceFile, checker } = createProgram(`
    interface OpaqueRefMethods<T> {
      key(path: string): OpaqueRef<T>;
      mapWithPattern<U>(callback: (value: any) => U): U[];
    }

    type OpaqueRef<T> = T & OpaqueRefMethods<T>;

    declare const items: OpaqueRef<{ values: number[] }>;

    const value = items.key("values").mapWithPattern((n: number) => n + 1);
  `);

  const expression = findInitializer(sourceFile, "value");
  if (!ts.isCallExpression(expression)) {
    throw new Error("Expected call expression initializer");
  }

  assertEquals(classifyArrayMethodCallSite(expression, checker), {
    family: "map",
    lowered: true,
    ownership: "reactive",
  });
  assertEquals(
    classifyArrayCallbackContainerCall(expression, checker),
    "reactive-array-method",
  );
});

Deno.test("classifyArrayMethodCallSite does not mark custom lowered *WithPattern methods reactive by name alone", () => {
  const { sourceFile, checker } = createProgram(`
    declare const collection: {
      mapWithPattern<U>(callback: (value: number) => U): U[];
    };

    const value = collection.mapWithPattern((n: number) => n + 1);
  `);

  const expression = findInitializer(sourceFile, "value");
  if (!ts.isCallExpression(expression)) {
    throw new Error("Expected call expression initializer");
  }

  assertEquals(detectCallKind(expression, checker), undefined);
  assertEquals(classifyArrayMethodCallSite(expression, checker), {
    family: "map",
    lowered: true,
    ownership: "plain",
  });
  assertEquals(
    classifyArrayCallbackContainerCall(expression, checker),
    undefined,
  );
});

Deno.test("classifyArrayCallbackContainerCall recognizes plain value-returning non-map array callbacks", () => {
  const { sourceFile, checker } = createProgram(`
    interface Array<T> {
      find(
        callback: (value: T) => boolean,
      ): T | undefined;
    }

    const value = [1, 2, 3].find((n: number) => n > 1);
  `);

  const expression = findInitializer(sourceFile, "value");
  if (!ts.isCallExpression(expression)) {
    throw new Error("Expected call expression initializer");
  }

  assertEquals(
    classifyArrayCallbackContainerCall(expression, checker),
    "plain-array-value",
  );
});

Deno.test("classifyArrayCallbackContainerCall recognizes plain void array callbacks", () => {
  const { sourceFile, checker } = createProgram(`
    interface Array<T> {
      forEach(callback: (value: T) => void): void;
    }

    const value = [1, 2, 3].forEach((n: number) => console.log(n));
  `);

  const expression = findInitializer(sourceFile, "value");
  if (!ts.isCallExpression(expression)) {
    throw new Error("Expected call expression initializer");
  }

  assertEquals(
    classifyArrayCallbackContainerCall(expression, checker),
    "plain-array-void",
  );
});

Deno.test("getPatternBuilderCallbackArgument preserves unresolved property-access pattern fallback", () => {
  const { sourceFile, checker } = createProgram(`
    const builders = {} as any;
    const value = builders.pattern((input: unknown) => input);
  `);

  const expression = findInitializer(sourceFile, "value");
  if (!ts.isCallExpression(expression)) {
    throw new Error("Expected call expression initializer");
  }

  const callback = getPatternBuilderCallbackArgument(expression, checker);
  if (!callback) {
    throw new Error("Expected pattern callback argument");
  }

  assertEquals(ts.isArrowFunction(callback), true);
});

Deno.test("getCapabilitySummaryCallbackArgument recognizes derive and builder callback families", () => {
  const { sourceFile, checker } = createProgram(`
    declare function derive<T, U>(input: T, callback: (value: T) => U): U;
    declare function derive<T, U>(
      inputSchema: unknown,
      resultSchema: unknown,
      input: T,
      callback: (value: T) => U,
    ): U;
    declare function computed<T>(callback: () => T): T;
    declare function action<T>(callback: () => T): T;

    const first = derive(1, (value: number) => value + 1);
    const second = derive({}, {}, 1, (value: number) => value + 2);
    const third = computed(() => 1);
    const fourth = action(() => 2);
  `);

  const first = findInitializer(sourceFile, "first");
  const second = findInitializer(sourceFile, "second");
  const third = findInitializer(sourceFile, "third");
  const fourth = findInitializer(sourceFile, "fourth");

  if (
    !ts.isCallExpression(first) || !ts.isCallExpression(second) ||
    !ts.isCallExpression(third) || !ts.isCallExpression(fourth)
  ) {
    throw new Error("Expected call expression initializers");
  }

  assertEquals(!!getCapabilitySummaryCallbackArgument(first, checker), true);
  assertEquals(!!getCapabilitySummaryCallbackArgument(second, checker), true);
  assertEquals(!!getCapabilitySummaryCallbackArgument(third, checker), true);
  assertEquals(!!getCapabilitySummaryCallbackArgument(fourth, checker), true);
});
