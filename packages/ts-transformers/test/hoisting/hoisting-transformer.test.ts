import { assertEquals } from "@std/assert";
import ts from "typescript";
import { HoistingTransformer } from "../../src/hoisting/hoisting-transformer.ts";

/**
 * Helper to run the HoistingTransformer on source code.
 */
function transformWithHoisting(source: string): string {
  const fileName = "test.tsx";
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );

  // Create a program with commontools type stubs
  const commonToolsStub = `
    export function derive<I, O>(input: I, fn: (input: I) => O): O;
    export function derive<I, IS, O>(inputSchema: IS, outputSchema: any, input: I, fn: (input: I) => O): O;
    export function lift<I, O>(fn: (input: I) => O): (input: I) => O;
    export function handler<E, S>(fn: (event: E, state: S) => void): (state: S) => void;
    export function action<S>(fn: (state: S) => void): void;
    export function pattern<I, O>(fn: (input: I) => O): any;
    export function recipe<I, O>(schema: any, fn: (input: I) => O): any;
    export function computed<T>(fn: () => T): T;
    export function cell<T>(value: T, schema?: any): { get(): T; set(v: T): void };
  `;

  const host = ts.createCompilerHost({
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    jsx: ts.JsxEmit.ReactJSX,
    strict: false,
  });

  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion) => {
    if (name === fileName) return sourceFile;
    if (name === "commontools.d.ts" || name.includes("commontools")) {
      return ts.createSourceFile(
        "commontools.d.ts",
        commonToolsStub,
        languageVersion,
        true,
      );
    }
    return originalGetSourceFile(name, languageVersion);
  };

  host.fileExists = (name) =>
    name === fileName || name.includes("commontools") ||
    ts.sys.fileExists(name);
  host.readFile = (name) => {
    if (name === fileName) return source;
    if (name.includes("commontools")) return commonToolsStub;
    return ts.sys.readFile(name);
  };

  const program = ts.createProgram(
    [fileName],
    {
      target: ts.ScriptTarget.Latest,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.ReactJSX,
      strict: false,
      noEmit: true,
    },
    host,
  );

  const transformer = new HoistingTransformer({});
  const factory = transformer.toFactory(program);

  const result = ts.transform(sourceFile, [factory]);
  const printer = ts.createPrinter();
  const output = printer.printFile(result.transformed[0]!);
  result.dispose();

  return output;
}

Deno.test("HoistingTransformer", async (t) => {
  await t.step(
    "does not hoist self-contained callbacks (no module refs)",
    () => {
      const source = `
import { derive } from "commontools";

export default function MyPattern(props: any) {
  const doubled = derive(props.value, (x: number) => x * 2);
  return { doubled };
}
`;
      const output = transformWithHoisting(source);
      // Should NOT contain any __derive_ hoisted declarations
      assertEquals(output.includes("__derive_"), false);
      // Original derive call should still be there
      assertEquals(output.includes("derive("), true);
    },
  );

  await t.step("hoists callback that references module-scope import", () => {
    const source = `
import { derive } from "commontools";
import { someUtil } from "some-lib";

export default function MyPattern(props: any) {
  const result = derive(props.value, (x: number) => someUtil(x));
  return { result };
}
`;
    const output = transformWithHoisting(source);
    // Should contain a hoisted __lift_ declaration (derive → lift conversion)
    assertEquals(output.includes("__lift_"), true);
    // The hoisted declaration should wrap callback in lift()
    assertEquals(output.includes("lift("), true);
    // The hoisted declaration should be after the main body
    assertEquals(
      output.indexOf("const __lift_") > output.indexOf("export default"),
      true,
    );
  });

  await t.step("hoists callback that references module-scope const", () => {
    const source = `
import { derive } from "commontools";

const MULTIPLIER = 10;

export default function MyPattern(props: any) {
  const scaled = derive(props.value, (x: number) => x * MULTIPLIER);
  return { scaled };
}
`;
    const output = transformWithHoisting(source);
    // Should use __lift_ (derive → lift conversion)
    assertEquals(output.includes("__lift_"), true);
    assertEquals(output.includes("lift("), true);
  });

  await t.step("does not hoist calls already at module scope", () => {
    const source = `
import { lift } from "commontools";
import { someUtil } from "some-lib";

const myLift = lift((x: number) => someUtil(x));

export default function MyPattern(props: any) {
  return { result: myLift(props.value) };
}
`;
    const output = transformWithHoisting(source);
    // Should NOT hoist (already at module scope)
    assertEquals(output.includes("__lift_"), false);
  });

  await t.step("preserves schema args in derive → lift conversion", () => {
    const source = `
import { derive } from "commontools";
import { someUtil } from "some-lib";

const inputSchema = { type: "number" };
const outputSchema = { type: "string" };

export default function MyPattern(props: any) {
  const result = derive(inputSchema, outputSchema, props.value, (x: number) => someUtil(x));
  return { result };
}
`;
    const output = transformWithHoisting(source);
    // Should hoist with lift and include schema args
    assertEquals(output.includes("__lift_"), true);
    assertEquals(output.includes("lift("), true);
    // The hoisted lift call should include schema args before the callback
    // lift(inputSchema, outputSchema, (x) => someUtil(x))
    assertEquals(output.includes("inputSchema"), true);
    assertEquals(output.includes("outputSchema"), true);
  });

  await t.step("splits handler chain when hoisting", () => {
    const source = `
import { handler } from "commontools";
import { someUtil } from "some-lib";

export default function MyPattern(props: any) {
  const onClick = handler((event: any, {count}: any) => someUtil(count))({count: props.count});
  return { onClick };
}
`;
    const output = transformWithHoisting(source);
    // Should contain a hoisted __handler_ declaration
    assertEquals(output.includes("__handler_"), true);
    // The inner handler(fn) should be hoisted, outer call stays at call site
    assertEquals(
      output.indexOf("const __handler_") > output.indexOf("export default"),
      true,
    );
    // The call site should invoke the hoisted handler with captures
    assertEquals(output.includes("__handler_0("), true);
  });

  await t.step("transformer has filter method", () => {
    const transformer = new HoistingTransformer({});
    assertEquals(typeof transformer.filter, "function");
  });
});
