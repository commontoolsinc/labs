import { assertEquals } from "@std/assert";
import ts from "typescript";
import {
  isEventHandlerJsxAttribute,
  isEventHandlerType,
} from "../../src/ast/event-handlers.ts";

/**
 * Creates a TypeScript program from JSX source and returns utilities for testing.
 */
function createJsxTestProgram(jsxSource: string) {
  const fileName = "/test.tsx";
  const programSource = `
// Type definitions for testing
declare function handler<E, S>(fn: (event: E, state: S) => void): (state: S) => void;
declare const state: { count: number };

// Promise type declaration (needed for noLib: true environment)
interface Promise<T> {
  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | undefined | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null
  ): Promise<TResult1 | TResult2>;
}
interface PromiseLike<T> {
  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | undefined | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null
  ): PromiseLike<TResult1 | TResult2>;
}

// Custom component with typed callback prop
interface CustomButtonProps {
  callback: () => void;
  asyncCallback: () => Promise<void>;
  label: string;
  mapper: (item: number) => string; // Non-handler: returns value
  predicate: (item: number) => boolean; // Non-handler: returns value
}
declare function CustomButton(props: CustomButtonProps): JSX.Element;

// JSX intrinsic elements
declare namespace JSX {
  interface Element {}
  interface IntrinsicElements {
    button: {
      onClick?: (event: MouseEvent) => void;
      onSubmit?: (event: Event) => void;
      type?: string;
      children?: any;
    };
    div: {
      onClick?: (event: MouseEvent) => void;
      children?: any;
    };
    span: {
      children?: any;
    };
  }
}

declare class MouseEvent {}
declare class Event {}

// Test JSX
const element = ${jsxSource};
`;

  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    jsx: ts.JsxEmit.Preserve,
    noLib: true,
  };

  const sourceFile = ts.createSourceFile(
    fileName,
    programSource,
    compilerOptions.target!,
    true,
    ts.ScriptKind.TSX,
  );

  const host = ts.createCompilerHost(compilerOptions, true);
  host.getSourceFile = (name) => name === fileName ? sourceFile : undefined;
  host.getCurrentDirectory = () => "/";
  host.getDirectories = () => [];
  host.fileExists = (name) => name === fileName;
  host.readFile = (name) => name === fileName ? programSource : undefined;
  host.writeFile = () => {};
  host.useCaseSensitiveFileNames = () => true;
  host.getCanonicalFileName = (name) => name;
  host.getNewLine = () => "\n";

  const program = ts.createProgram([fileName], compilerOptions, host);
  const checker = program.getTypeChecker();

  return { sourceFile, checker, program };
}

/**
 * Find a JSX attribute by name in the source file.
 */
function findJsxAttribute(
  sourceFile: ts.SourceFile,
  attrName: string,
): ts.JsxAttribute | undefined {
  let found: ts.JsxAttribute | undefined;

  function visit(node: ts.Node) {
    if (ts.isJsxAttribute(node) && node.name.getText() === attrName) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return found;
}

// =============================================================================
// Tests for isEventHandlerType
// =============================================================================

Deno.test("isEventHandlerType - void return type is handler", () => {
  const { checker, sourceFile } = createJsxTestProgram(
    `<CustomButton callback={() => {}} asyncCallback={async () => {}} label="test" mapper={(n) => String(n)} predicate={(n) => n > 0} />`,
  );

  const callbackAttr = findJsxAttribute(sourceFile, "callback");
  if (
    !callbackAttr?.initializer || !ts.isJsxExpression(callbackAttr.initializer)
  ) {
    throw new Error("callback attribute not found");
  }

  const expr = callbackAttr.initializer.expression!;
  const contextualType = checker.getContextualType(expr);

  if (!contextualType) {
    throw new Error("No contextual type for callback");
  }

  assertEquals(
    isEventHandlerType(contextualType, checker),
    true,
    "() => void should be detected as handler type",
  );
});

Deno.test("isEventHandlerType - Promise<void> return type is handler", () => {
  const { checker, sourceFile } = createJsxTestProgram(
    `<CustomButton callback={() => {}} asyncCallback={async () => {}} label="test" mapper={(n) => String(n)} predicate={(n) => n > 0} />`,
  );

  const asyncCallbackAttr = findJsxAttribute(sourceFile, "asyncCallback");
  if (
    !asyncCallbackAttr?.initializer ||
    !ts.isJsxExpression(asyncCallbackAttr.initializer)
  ) {
    throw new Error("asyncCallback attribute not found");
  }

  const expr = asyncCallbackAttr.initializer.expression!;
  const contextualType = checker.getContextualType(expr);

  if (!contextualType) {
    throw new Error("No contextual type for asyncCallback");
  }

  assertEquals(
    isEventHandlerType(contextualType, checker),
    true,
    "() => Promise<void> should be detected as handler type",
  );
});

Deno.test("isEventHandlerType - non-void return type is NOT handler", () => {
  const { checker, sourceFile } = createJsxTestProgram(
    `<CustomButton callback={() => {}} asyncCallback={async () => {}} label="test" mapper={(n) => String(n)} predicate={(n) => n > 0} />`,
  );

  const mapperAttr = findJsxAttribute(sourceFile, "mapper");
  if (!mapperAttr?.initializer || !ts.isJsxExpression(mapperAttr.initializer)) {
    throw new Error("mapper attribute not found");
  }

  const expr = mapperAttr.initializer.expression!;
  const contextualType = checker.getContextualType(expr);

  if (!contextualType) {
    throw new Error("No contextual type for mapper");
  }

  assertEquals(
    isEventHandlerType(contextualType, checker),
    false,
    "(n: number) => string should NOT be detected as handler type",
  );
});

Deno.test("isEventHandlerType - boolean return type is NOT handler", () => {
  const { checker, sourceFile } = createJsxTestProgram(
    `<CustomButton callback={() => {}} asyncCallback={async () => {}} label="test" mapper={(n) => String(n)} predicate={(n) => n > 0} />`,
  );

  const predicateAttr = findJsxAttribute(sourceFile, "predicate");
  if (
    !predicateAttr?.initializer ||
    !ts.isJsxExpression(predicateAttr.initializer)
  ) {
    throw new Error("predicate attribute not found");
  }

  const expr = predicateAttr.initializer.expression!;
  const contextualType = checker.getContextualType(expr);

  if (!contextualType) {
    throw new Error("No contextual type for predicate");
  }

  assertEquals(
    isEventHandlerType(contextualType, checker),
    false,
    "(n: number) => boolean should NOT be detected as handler type",
  );
});

// =============================================================================
// Tests for isEventHandlerJsxAttribute - name-based detection
// =============================================================================

Deno.test("isEventHandlerJsxAttribute - onClick detected by name (without checker)", () => {
  const { sourceFile } = createJsxTestProgram(
    `<button onClick={() => console.log("clicked")}>Click</button>`,
  );

  const onClickAttr = findJsxAttribute(sourceFile, "onClick");
  if (!onClickAttr) {
    throw new Error("onClick attribute not found");
  }

  assertEquals(
    isEventHandlerJsxAttribute(onClickAttr),
    true,
    "onClick should be detected by name without checker",
  );
});

Deno.test("isEventHandlerJsxAttribute - onSubmit detected by name (without checker)", () => {
  const { sourceFile } = createJsxTestProgram(
    `<button onSubmit={() => console.log("submitted")}>Submit</button>`,
  );

  const onSubmitAttr = findJsxAttribute(sourceFile, "onSubmit");
  if (!onSubmitAttr) {
    throw new Error("onSubmit attribute not found");
  }

  assertEquals(
    isEventHandlerJsxAttribute(onSubmitAttr),
    true,
    "onSubmit should be detected by name without checker",
  );
});

Deno.test("isEventHandlerJsxAttribute - non-on attribute not detected (without checker)", () => {
  const { sourceFile } = createJsxTestProgram(
    `<button type="button">Click</button>`,
  );

  const typeAttr = findJsxAttribute(sourceFile, "type");
  if (!typeAttr) {
    throw new Error("type attribute not found");
  }

  assertEquals(
    isEventHandlerJsxAttribute(typeAttr),
    false,
    "type attribute should NOT be detected as handler",
  );
});

// =============================================================================
// Tests for isEventHandlerJsxAttribute - type-based detection
// =============================================================================

Deno.test("isEventHandlerJsxAttribute - callback detected by type (with checker)", () => {
  const { sourceFile, checker } = createJsxTestProgram(
    `<CustomButton callback={() => {}} asyncCallback={async () => {}} label="test" mapper={(n) => String(n)} predicate={(n) => n > 0} />`,
  );

  const callbackAttr = findJsxAttribute(sourceFile, "callback");
  if (!callbackAttr) {
    throw new Error("callback attribute not found");
  }

  assertEquals(
    isEventHandlerJsxAttribute(callbackAttr, checker),
    true,
    "callback with () => void type should be detected as handler with checker",
  );
});

Deno.test("isEventHandlerJsxAttribute - asyncCallback detected by type (with checker)", () => {
  const { sourceFile, checker } = createJsxTestProgram(
    `<CustomButton callback={() => {}} asyncCallback={async () => {}} label="test" mapper={(n) => String(n)} predicate={(n) => n > 0} />`,
  );

  const asyncCallbackAttr = findJsxAttribute(sourceFile, "asyncCallback");
  if (!asyncCallbackAttr) {
    throw new Error("asyncCallback attribute not found");
  }

  assertEquals(
    isEventHandlerJsxAttribute(asyncCallbackAttr, checker),
    true,
    "asyncCallback with () => Promise<void> type should be detected as handler with checker",
  );
});

Deno.test("isEventHandlerJsxAttribute - mapper NOT detected as handler (with checker)", () => {
  const { sourceFile, checker } = createJsxTestProgram(
    `<CustomButton callback={() => {}} asyncCallback={async () => {}} label="test" mapper={(n) => String(n)} predicate={(n) => n > 0} />`,
  );

  const mapperAttr = findJsxAttribute(sourceFile, "mapper");
  if (!mapperAttr) {
    throw new Error("mapper attribute not found");
  }

  assertEquals(
    isEventHandlerJsxAttribute(mapperAttr, checker),
    false,
    "mapper with (item: number) => string type should NOT be detected as handler",
  );
});

Deno.test("isEventHandlerJsxAttribute - label (string prop) NOT detected as handler", () => {
  const { sourceFile, checker } = createJsxTestProgram(
    `<CustomButton callback={() => {}} asyncCallback={async () => {}} label="test" mapper={(n) => String(n)} predicate={(n) => n > 0} />`,
  );

  const labelAttr = findJsxAttribute(sourceFile, "label");
  if (!labelAttr) {
    throw new Error("label attribute not found");
  }

  assertEquals(
    isEventHandlerJsxAttribute(labelAttr, checker),
    false,
    "label (string prop) should NOT be detected as handler",
  );
});
