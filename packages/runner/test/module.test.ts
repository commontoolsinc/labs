import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { JSONSchemaObj } from "@commonfabric/api";
import { Identity } from "@commonfabric/identity";
import {
  type Frame,
  isModule,
  isOpaqueRef,
  isPattern,
  type JSONSchema,
  type Module,
  type OpaqueRef as _OpaqueRef,
  type Pattern,
  type Stream,
} from "../src/builder/types.ts";
import {
  action,
  derive,
  handler,
  lift,
  parseStackFrame,
  resolveSourceLocationFromStack,
} from "../src/builder/module.ts";
import { opaqueRef } from "../src/builder/opaque-ref.ts";
import { popFrame, pushFrame } from "../src/builder/pattern.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

type MouseEvent = {
  clientX: number;
  clientY: number;
};

type TestNode = Pattern["nodes"][number];
type SourceTrackedImplementation = ((...args: any[]) => any) & {
  preview?: string;
  src?: string;
};

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("module", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  let frame: Frame;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });

    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    frame = pushFrame({
      space,
      generatedIdCounter: 0,
      opaqueRefs: new Set(),
      runtime,
    });
  });

  afterEach(async () => {
    popFrame(frame);
    await runtime?.dispose();
  });

  describe("lift function", () => {
    it("creates a node factory", () => {
      const add = lift<{ a: number; b: number }, number>(({ a, b }) => a + b);
      expect(typeof add).toBe("function");
      expect(isModule(add)).toBe(true);
    });

    it("creates a opaque ref when called", () => {
      const add = lift<{ a: number; b: number }, number>(({ a, b }) => a + b);
      const result = add({ a: opaqueRef(1), b: opaqueRef(2) });
      expect(isOpaqueRef(result)).toBe(true);
    });

    it("supports JSON Schema validation", () => {
      const schema = {
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "number" },
        },
        required: ["name"],
      } as const satisfies JSONSchema;

      const greet = lift(
        schema,
        { type: "string" } as const satisfies JSONSchema,
        ({ name, age }) => `Hello ${name}${age ? `, age ${age}` : ""}!`,
      );

      expect(isModule(greet)).toBe(true);
      const module = greet as unknown as Module;
      expect(module.argumentSchema).toEqual(schema);
    });

    it("supports schema validation with description", () => {
      const inputSchema = {
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "number" },
        },
        required: ["name"],
        description: "Person information",
      } as const satisfies JSONSchema;

      const outputSchema = {
        type: "string",
        description: "Greeting message",
      } as const satisfies JSONSchema;

      const greet = lift(
        inputSchema,
        outputSchema,
        ({ name, age }) => `Hello ${name}${age ? `, age ${age}` : ""}!`,
      );

      expect(isModule(greet)).toBe(true);
      const module = greet as unknown as Module;
      expect(module.argumentSchema).toBeDefined();
      expect(module.resultSchema).toBeDefined();
      expect((module.argumentSchema as JSONSchemaObj).description).toBe(
        "Person information",
      );
      expect((module.resultSchema as JSONSchemaObj).description).toBe(
        "Greeting message",
      );
    });
  });

  describe("handler function", () => {
    it("creates a node factory for event handlers", () => {
      const clickHandler = handler<MouseEvent, { x: number; y: number }>(
        (event, props) => {
          props.x = event.clientX;
          props.y = event.clientY;
        },
        { proxy: true },
      );
      expect(typeof clickHandler).toBe("function");
      expect(isModule(clickHandler)).toBe(true);
    });

    it("creates a opaque ref with stream when called", () => {
      const clickHandler = handler<MouseEvent, { x: number; y: number }>(
        (event, props) => {
          props.x = event.clientX;
          props.y = event.clientY;
        },
        { proxy: true },
      );
      const stream = clickHandler({ x: opaqueRef(10), y: opaqueRef(20) });
      expect(isOpaqueRef(stream)).toBe(true);
      const { value, nodes } = (stream as any).export();
      expect(value).toEqual({ $stream: true });
      expect(nodes.size).toBe(1);
      expect([...nodes][0].module).toMatchObject({ wrapper: "handler" });
      expect([...nodes][0].inputs.$event).toBe(stream);
    });

    it("supports event and state schema validation", () => {
      const eventSchema = {
        type: "object",
        properties: {
          type: { type: "string", enum: ["click", "hover"] },
          x: { type: "number" },
          y: { type: "number" },
        },
        required: ["type", "x", "y"],
      } as const satisfies JSONSchema;

      const stateSchema = {
        type: "object",
        properties: {
          lastX: { type: "number" },
          lastY: { type: "number" },
        },
      } as const satisfies JSONSchema;

      const mouseHandler = handler(
        eventSchema,
        stateSchema,
        (event: any, state: any) => {
          state.lastX = event.x;
          state.lastY = event.y;
        },
      );

      expect(isModule(mouseHandler)).toBe(true);
      const module = mouseHandler as unknown as Module;
      expect(module.argumentSchema).toBeDefined();
      expect((module.argumentSchema as JSONSchemaObj).properties?.$event)
        .toEqual(eventSchema);
    });

    it("supports schema validation for events and state with enums", () => {
      const eventSchema = {
        type: "object",
        properties: {
          type: { type: "string", enum: ["click", "hover"] },
          target: { type: "string" },
        },
        required: ["type", "target"],
      } as const satisfies JSONSchema;

      const stateSchema = {
        type: "object",
        properties: {
          elements: {
            type: "object",
            additionalProperties: { type: "boolean" },
          },
        },
      } as const satisfies JSONSchema;

      const toggleHandler = handler(
        eventSchema,
        stateSchema,
        (event: any, state: any) => {
          state.elements[event.target] = !state.elements[event.target];
        },
      );

      const elements = opaqueRef({ button1: true, button2: false });
      const result = toggleHandler({ elements } as any);

      expect(isOpaqueRef(result)).toBe(true);
      const { nodes } = result.export();
      expect(nodes.size).toBe(1);
      const handlerNode = [...nodes][0];
      expect((handlerNode.module as Module).wrapper).toBe("handler");
      expect(handlerNode.inputs.$ctx.elements).toBe(elements);
    });

    it("creates a opaque ref with stream when with is called", () => {
      const clickHandler = handler<MouseEvent, { x: number; y: number }>(
        (event, props) => {
          props.x = event.clientX;
          props.y = event.clientY;
        },
        { proxy: true },
      );
      const stream = clickHandler.with({ x: opaqueRef(10), y: opaqueRef(20) });
      expect(isOpaqueRef(stream)).toBe(true);
      const { value, nodes } = (stream as any).export();
      expect(value).toEqual({ $stream: true });
      expect(nodes.size).toBe(1);
      expect([...nodes][0].module).toMatchObject({ wrapper: "handler" });
      expect([...nodes][0].inputs.$event).toBe(stream);
    });
  });

  describe("action function", () => {
    it("throws error when called directly without CTS transforms", () => {
      // action() is only valid once CTS transforms rewrite it to handler().
      // A direct runtime call should still fail and point callers at the opt-out flag.
      expect(() => {
        action<{ data: string }>(({ data }) => {
          void data;
        });
      }).toThrow(
        "action() must be used with CTS transforms enabled - remove /// <cf-disable-transform /> from your file",
      );
    });

    it("infers Stream<void> for zero-parameter callbacks (type test)", () => {
      // This test verifies that TypeScript correctly infers Stream<void> for
      // zero-parameter action callbacks, rather than Stream<unknown>.
      //
      // The test passes if it compiles. Previously, action(() => {...}) would
      // infer Stream<unknown>, causing type errors when assigned to Stream<void>.
      //
      // action() throws at runtime (requires CTS transformer), so we wrap calls
      // in a never-executed block. TypeScript still type-checks dead code.

      // This function is never called - it exists only for type checking
      function _typeTest(): void {
        // These would throw at runtime, but this function is never called.
        // If the overloads are wrong, these lines fail to compile.

        // Zero-parameter callback should infer Stream<void>, not Stream<unknown>
        const _voidAction: Stream<void> = action(() => {
          console.log("side effect");
        });

        // Parameterized callback should infer Stream<string>
        const _stringAction: Stream<string> = action((_e: string) => {
          console.log("side effect");
        });

        // Complex type parameter
        const _complexAction: Stream<{ id: number; name: string }> = action(
          (_e: { id: number; name: string }) => {
            console.log("side effect");
          },
        );

        // Suppress unused variable warnings
        void _voidAction;
        void _stringAction;
        void _complexAction;
      }

      // Suppress unused function warning - the function exists only for type checking
      void _typeTest;

      // If we reach here, the types compiled correctly
      expect(true).toBe(true);
    });
  });

  describe("source location tracking", () => {
    const compileMain = async (source: string) => {
      const program = {
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents: source }],
      };

      const { id, jsScript } = await runtime.harness.compile(program);
      return await runtime.harness.evaluate(id, jsScript, program.files);
    };

    const findNodeByPreview = (
      patternFn: unknown,
      previewSubstring: string,
    ): TestNode | undefined => {
      if (!isPattern(patternFn)) return undefined;
      return patternFn.nodes.find((node) =>
        (() => {
          const trackedNode = hasTrackedImplementation(node) ? node : undefined;
          const impl = trackedNode?.module.implementation;
          return typeof impl?.preview === "string" &&
            impl.preview.includes(previewSubstring);
        })()
      );
    };

    const hasTrackedImplementation = (
      node: TestNode | undefined,
    ): node is TestNode & {
      module: TestNode["module"] & {
        implementation: SourceTrackedImplementation;
      };
    } =>
      !!node &&
      typeof node.module.implementation === "function";

    const expectTrackedNode = (
      node: TestNode | undefined,
      label?: string,
    ) => {
      expect(node, label).toBeDefined();
      if (!hasTrackedImplementation(node)) {
        throw new Error(
          `Expected tracked implementation${label ? ` for ${label}` : ""}`,
        );
      }
      expect(node.module.implementation.src, label).toBeDefined();
      return node;
    };

    it("attaches source location to function implementation via .name", () => {
      const fn = (x: number) => x * 2;
      lift(fn);

      // The implementation's .name should now be the source location
      expect(fn.name).toMatch(/module\.test\.ts:\d+:\d+$/);
    });

    it("attaches source location to handler implementations", () => {
      const fn = (event: MouseEvent, props: { x: number }) => {
        props.x = event.clientX;
      };
      handler(fn, { proxy: true });

      expect(fn.name).toMatch(/module\.test\.ts:\d+:\d+$/);
    });

    it("attaches source location through derive", () => {
      const fn = (x: number) => x * 2;
      derive(opaqueRef(5), fn);

      // derive calls lift internally, should still track the original function
      expect(fn.name).toMatch(/module\.test\.ts:\d+:\d+$/);
    });

    it("maps computed callsites through the CTS pipeline", async () => {
      const source = [
        "/// <cts-enable />",
        'import { computed, pattern } from "commonfabric";',
        "export default pattern<{ items: boolean[] }>(({ items }) => {",
        "  const visible = computed(() => items.filter(Boolean));",
        "  return { visible };",
        "});",
      ].join("\n");

      const { main } = await compileMain(source);
      const patternFn = main?.default;

      const computedNode = expectTrackedNode(
        findNodeByPreview(patternFn, ".filter(Boolean)"),
      );
      expect(computedNode.module.implementation.src).toMatch(
        /main\.tsx:4:\d+$/,
      );
      expect(computedNode.module.implementation.src).not.toContain(
        "main.tsx:1:23",
      );
    });

    it("maps action callsites through the CTS pipeline", async () => {
      const source = [
        "/// <cts-enable />",
        'import { action, pattern } from "commonfabric";',
        "export default pattern<{ value: number }>(({ value }) => {",
        "  const inc = action(() => value + 1);",
        "  return { inc };",
        "});",
      ].join("\n");

      const { main } = await compileMain(source);
      const actionNode = expectTrackedNode(
        findNodeByPreview(main?.default, "value + 1"),
      );
      expect(actionNode.module.wrapper).toBe("handler");
      expect(actionNode.module.implementation.src).toMatch(/main\.tsx:4:\d+$/);
      expect(actionNode.module.implementation.src).not.toContain(
        "main.tsx:1:23",
      );
    });

    it("maps synthetic JSX compute callsites through the CTS pipeline", async () => {
      const source = [
        "/// <cts-enable />",
        'import { pattern, UI } from "commonfabric";',
        "export default pattern<{ value: number }>(({ value }) => ({",
        "  [UI]: <div>{value + 1}</div>,",
        "}));",
      ].join("\n");

      const { main } = await compileMain(source);
      const jsxNode = expectTrackedNode(
        findNodeByPreview(main?.default, "value + 1"),
      );
      expect(jsxNode.module.implementation.src).toMatch(/main\.tsx:4:\d+$/);
      expect(jsxNode.module.implementation.src).not.toContain("main.tsx:1:23");
    });

    it("preserves source locations for explicit lift, handler, and nested pattern calls", async () => {
      const cases = [
        {
          label: "lift",
          source: [
            "/// <cts-enable />",
            'import { lift, pattern } from "commonfabric";',
            "const doubler = lift((value: number) => value * 2);",
            "export default pattern<{ value: number }>(({ value }) => ({ doubled: doubler(value) }));",
          ].join("\n"),
          exportName: "default",
          preview: "value * 2",
          line: 3,
        },
        {
          label: "handler",
          source: [
            "/// <cts-enable />",
            'import { handler, pattern } from "commonfabric";',
            "const click = handler((event: { delta: number }, state: { value: number }) => state.value + event.delta);",
            "export default pattern<{ value: number }>(({ value }) => ({ click: click({ value }) }));",
          ].join("\n"),
          exportName: "default",
          preview: "state.value + event.delta",
          line: 3,
          wrapper: "handler",
        },
        {
          label: "pattern",
          source: [
            "/// <cts-enable />",
            'import { computed, pattern } from "commonfabric";',
            "export const Child = pattern<{ value: number }>(({ value }) => ({ doubled: computed(() => value * 2) }));",
            "export default pattern<{ value: number }>(({ value }) => ({ child: Child({ value }) }));",
          ].join("\n"),
          exportName: "Child",
          preview: "value * 2",
          line: 3,
        },
      ];

      for (const testCase of cases) {
        const { main } = await compileMain(testCase.source);
        const node = expectTrackedNode(
          findNodeByPreview(main?.[testCase.exportName], testCase.preview),
          testCase.label,
        );
        if (testCase.wrapper) {
          expect(node.module.wrapper, testCase.label).toBe(testCase.wrapper);
        }
        expect(
          node.module.implementation.src,
          testCase.label,
        ).toMatch(new RegExp(`main\\.tsx:${testCase.line}:\\d+$`));
        expect(
          node.module.implementation.src,
          testCase.label,
        ).not.toContain("main.tsx:1:23");
      }
    });
  });

  describe("parseStackFrame", () => {
    it("parses Deno file:// stack frames with function name", () => {
      const line =
        "    at functionName (file:///Users/test/project/src/file.ts:42:15)";
      const result = parseStackFrame(line);
      expect(result).toEqual({
        file: "/Users/test/project/src/file.ts",
        line: 42,
        col: 15,
      });
    });

    it("parses Deno file:// stack frames without function name", () => {
      const line = "    at file:///Users/test/project/src/file.ts:42:15";
      const result = parseStackFrame(line);
      expect(result).toEqual({
        file: "/Users/test/project/src/file.ts",
        line: 42,
        col: 15,
      });
    });

    it("parses absolute path stack frames", () => {
      const line = "    at functionName (/path/to/file.ts:100:5)";
      const result = parseStackFrame(line);
      expect(result).toEqual({
        file: "/path/to/file.ts",
        line: 100,
        col: 5,
      });
    });

    it("parses browser http:// stack frames", () => {
      const line =
        "    at getExternalSourceLocation (http://localhost:8000/scripts/index.js:250239:17)";
      const result = parseStackFrame(line);
      expect(result).toEqual({
        file: "http://localhost:8000/scripts/index.js",
        line: 250239,
        col: 17,
      });
    });

    it("parses browser https:// stack frames", () => {
      const line =
        "    at functionName (https://example.com/scripts/bundle.js:100:20)";
      const result = parseStackFrame(line);
      expect(result).toEqual({
        file: "https://example.com/scripts/bundle.js",
        line: 100,
        col: 20,
      });
    });

    it("parses browser stack frames with [as name] syntax", () => {
      const line =
        "    at Object.eval [as factory] (ba4jcbcoh3wqzgaq3x6v36c625ycvssvqewtr563cg2osp66t4jzls7cb.js:52:52)";
      const result = parseStackFrame(line);
      expect(result).toEqual({
        file: "ba4jcbcoh3wqzgaq3x6v36c625ycvssvqewtr563cg2osp66t4jzls7cb.js",
        line: 52,
        col: 52,
      });
    });

    it("parses Deno eval stack frames with anonymous suffix", () => {
      const line =
        "    at Object.eval [as factory] (recipe-abc.js, <anonymous>:4:52)";
      const result = parseStackFrame(line);
      expect(result).toEqual({
        file: "recipe-abc.js",
        line: 4,
        col: 52,
      });
    });

    it("parses relative path stack frames", () => {
      const line = "    at eval (somefile.js:10:5)";
      const result = parseStackFrame(line);
      expect(result).toEqual({
        file: "somefile.js",
        line: 10,
        col: 5,
      });
    });

    it("returns null for invalid stack frames", () => {
      expect(parseStackFrame("Error")).toBeNull();
      expect(parseStackFrame("    at <anonymous>")).toBeNull();
      expect(parseStackFrame("")).toBeNull();
    });

    it("skips internal CTS bundle frames and synthetic 1:23 mappings", () => {
      const stack = [
        "Error",
        "    at getExternalSourceLocation (bundle.js:10:5)",
        "    at annotateFunctionDebugMetadata (bundle.js:11:5)",
        "    at createNodeFactory (bundle.js:12:5)",
        "    at lift (bundle.js:13:5)",
        "    at Object.eval [as factory] (bundle.js:52:52)",
      ].join("\n");

      const result = resolveSourceLocationFromStack(
        stack,
        (_file, line, _col) => {
          if (line < 52) {
            return { source: "/main.tsx", line: 1, column: 23 };
          }
          return { source: "/main.tsx", line: 4, column: 26 };
        },
      );

      expect(result.location).toBe("/main.tsx:4:26");
    });
  });
});
