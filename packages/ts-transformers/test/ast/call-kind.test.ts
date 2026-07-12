import { assertEquals } from "@std/assert";
import ts from "typescript";

import {
  classifyArrayCallbackContainerCall,
  classifyArrayMethodCall,
  classifyArrayMethodCallSite,
  detectCallKind,
  detectNewExpressionKind,
  getCapabilitySummaryCallbackArgument,
  getLiftAppliedInputAndCallback,
  getPatternBuilderCallbackArgument,
} from "../../src/ast/mod.ts";
import { getWithPatternHoistablePatternCall } from "../../src/ast/call-kind.ts";

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
    declare function computed<T>(callback: () => T): T;

    const value = computed(() => [1, 2, 3]).map((n: number) => n + 1);
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

Deno.test("classifyArrayCallbackContainerCall downgrades reactive array callbacks consumed by terminal chains", () => {
  const { sourceFile, checker } = createProgram(`
    declare function computed<T>(callback: () => T): T;

    const value = computed(() => ["a", "b", "c"])
      .map((n: string) => n.toUpperCase())
      .join(", ");
  `);

  const expression = findInitializer(sourceFile, "value");
  if (
    !ts.isCallExpression(expression) ||
    !ts.isPropertyAccessExpression(expression.expression)
  ) {
    throw new Error("Expected join call expression initializer");
  }

  const receiver = expression.expression.expression;
  if (!ts.isCallExpression(receiver)) {
    throw new Error("Expected join receiver to be a call expression");
  }

  assertEquals(classifyArrayMethodCallSite(receiver, checker), {
    family: "map",
    lowered: false,
    ownership: "reactive",
  });
  assertEquals(
    classifyArrayCallbackContainerCall(receiver, checker),
    "plain-array-value",
  );
});

Deno.test("classifyArrayMethodCallSite treats lowered *WithPattern methods as reactive when the receiver is reactive", () => {
  const { sourceFile, checker } = createProgram(`
    declare const CELL_BRAND: unique symbol;
    type BrandedCell<T, Brand extends string> = {
      readonly [CELL_BRAND]: Brand;
    };

    interface OpaqueCell<T> extends BrandedCell<T, "opaque"> {
      mapWithPattern<U>(callback: (value: any) => U): U[];
    }

    declare const items: OpaqueCell<number[]>;

    const value = items.mapWithPattern((n: number) => n + 1);
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

Deno.test("array method classification ignores prototype-key names", () => {
  const { sourceFile, checker } = createProgram(`
    declare function derive<T>(value: T): T;

    const propertyAccess = derive([1, 2, 3]).constructor((n: number) => n + 1);
    const elementAccess = derive([1, 2, 3])["constructor"]((n: number) => n + 1);
  `);

  const propertyAccess = findInitializer(sourceFile, "propertyAccess");
  const elementAccess = findInitializer(sourceFile, "elementAccess");
  if (
    !ts.isCallExpression(propertyAccess) ||
    !ts.isCallExpression(elementAccess)
  ) {
    throw new Error("Expected call expression initializers");
  }

  assertEquals(classifyArrayMethodCall(propertyAccess), undefined);
  assertEquals(classifyArrayMethodCall(elementAccess), undefined);
  assertEquals(detectCallKind(propertyAccess, checker), undefined);
  assertEquals(detectCallKind(elementAccess, checker), undefined);
});

Deno.test("constructor classification ignores non-Common-Fabric ambient classes", () => {
  const { sourceFile, checker } = createProgram(`
    declare class Stream {
      constructor(value?: unknown);
    }

    const value = new Stream("foreign");
  `);

  const expression = findInitializer(sourceFile, "value");
  if (!ts.isNewExpression(expression)) {
    throw new Error("Expected new expression initializer");
  }

  assertEquals(detectNewExpressionKind(expression, checker), undefined);
});

Deno.test("constructor classification follows local Common-Fabric constructor aliases", () => {
  const { sourceFile, checker } = createProgram(`
    import { Writable } from "commonfabric";

    const LocalWritable = Writable;
    const value = new LocalWritable("aliased");
  `);

  const expression = findInitializer(sourceFile, "value");
  if (!ts.isNewExpression(expression)) {
    throw new Error("Expected new expression initializer");
  }

  assertEquals(detectNewExpressionKind(expression, checker), {
    kind: "cell-factory",
    factoryName: "Writable",
  });
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

Deno.test("getCapabilitySummaryCallbackArgument recognizes builder callback families", () => {
  const { sourceFile, checker } = createProgram(`
    declare function computed<T>(callback: () => T): T;
    declare function action<T>(callback: () => T): T;

    const third = computed(() => 1);
    const fourth = action(() => 2);
  `);

  const third = findInitializer(sourceFile, "third");
  const fourth = findInitializer(sourceFile, "fourth");

  if (
    !ts.isCallExpression(third) || !ts.isCallExpression(fourth)
  ) {
    throw new Error("Expected call expression initializers");
  }

  assertEquals(!!getCapabilitySummaryCallbackArgument(third, checker), true);
  assertEquals(!!getCapabilitySummaryCallbackArgument(fourth, checker), true);
});

Deno.test("getLiftAppliedInputAndCallback recognizes lift-applied input positions", () => {
  const { sourceFile, checker } = createProgram(`
    declare function lift<T, U>(callback: (value: T) => U): (input: T) => U;

    const first = lift((value: number) => value + 1)(1);
    const second = lift((value: number) => value + 2)(1);
    const third = lift((value: number) => value + 3);
  `);

  const first = findInitializer(sourceFile, "first");
  const second = findInitializer(sourceFile, "second");
  const third = findInitializer(sourceFile, "third");

  if (
    !ts.isCallExpression(first) ||
    !ts.isCallExpression(second) ||
    !ts.isCallExpression(third)
  ) {
    throw new Error("Expected call expression initializers");
  }

  const firstArgs = getLiftAppliedInputAndCallback(first, checker);
  const secondArgs = getLiftAppliedInputAndCallback(second, checker);
  // `third` is just `lift(cb)` — NOT applied to an input — so it is not the
  // lift-applied shape and yields undefined.
  const thirdArgs = getLiftAppliedInputAndCallback(third, checker);

  assertEquals(firstArgs?.input.getText(), "1");
  assertEquals(firstArgs?.callback.parameters[0]?.name.getText(), "value");
  assertEquals(secondArgs?.input.getText(), "1");
  assertEquals(secondArgs?.callback.parameters[0]?.name.getText(), "value");
  assertEquals(thirdArgs, undefined);
});

Deno.test("getWithPatternHoistablePatternCall returns the capture-free bare pattern argument", () => {
  const { sourceFile, checker } = createProgram(`
    declare const items: any;
    declare const make: { pattern(body: () => number): number };

    const value = items.mapWithPattern(make.pattern(() => 1));
  `);

  const expression = findInitializer(sourceFile, "value");
  if (!ts.isCallExpression(expression)) {
    throw new Error("Expected call expression initializer");
  }

  const hoistable = getWithPatternHoistablePatternCall(expression, checker);
  assertEquals(hoistable?.getText(), "make.pattern(() => 1)");
});

Deno.test("getWithPatternHoistablePatternCall ignores a first argument that is not a pattern call", () => {
  const { sourceFile, checker } = createProgram(`
    declare const items: any;
    declare function plain(body: () => number): number;

    const value = items.mapWithPattern(plain(() => 1), { p: 1 });
  `);

  const expression = findInitializer(sourceFile, "value");
  if (!ts.isCallExpression(expression)) {
    throw new Error("Expected call expression initializer");
  }

  assertEquals(
    getWithPatternHoistablePatternCall(expression, checker),
    undefined,
  );
});

Deno.test("detectCallKind resolves a pattern builder imported from commonfabric", () => {
  const { sourceFile, checker } = createProgram(`
    import { pattern } from "commonfabric";

    const value = pattern(() => 1);
  `);

  const expression = findInitializer(sourceFile, "value");
  if (!ts.isCallExpression(expression)) {
    throw new Error("Expected call expression initializer");
  }

  const kind = detectCallKind(expression, checker);
  assertEquals(kind?.kind, "builder");
  assertEquals(
    kind?.kind === "builder" ? kind.builderName : undefined,
    "pattern",
  );
});

Deno.test("detectCallKind ignores a builder-named import from a foreign module", () => {
  const { sourceFile, checker } = createProgram(`
    import { pattern } from "other-module";

    const value = pattern(() => 1);
  `);

  const expression = findInitializer(sourceFile, "value");
  if (!ts.isCallExpression(expression)) {
    throw new Error("Expected call expression initializer");
  }

  assertEquals(detectCallKind(expression, checker), undefined);
});
