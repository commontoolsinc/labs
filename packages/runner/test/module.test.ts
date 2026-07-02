import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { JSONSchemaObj } from "@commonfabric/api";
import { Identity } from "@commonfabric/identity";
import {
  type Frame,
  isModule,
  isPattern,
  isReactive,
  type JSONSchema,
  type Module,
  type Pattern,
  type Reactive as _Reactive,
  type Stream,
} from "../src/builder/types.ts";
import {
  action,
  handler,
  lift,
  parseStackFrame,
  resolveSourceLocationFromStack,
  setEagerSourceAnnotation,
} from "../src/builder/module.ts";
import { reactive } from "../src/builder/reactive.ts";
import { pattern, popFrame, pushFrame } from "../src/builder/pattern.ts";
import { CellImpl } from "../src/cell.ts";
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
      reactives: new Set(),
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
      const result = add({ a: reactive(1), b: reactive(2) });
      expect(isReactive(result)).toBe(true);
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
        ({ name, age }: { name: string; age?: number }) =>
          `Hello ${name}${age ? `, age ${age}` : ""}!`,
        schema,
        { type: "string" } as const satisfies JSONSchema,
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
        ({ name, age }: { name: string; age?: number }) =>
          `Hello ${name}${age ? `, age ${age}` : ""}!`,
        inputSchema,
        outputSchema,
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
      const stream = clickHandler({ x: reactive(10), y: reactive(20) });
      expect(isReactive(stream)).toBe(true);
      const { value, nodes } = (stream as any).export();
      expect(value).toEqual({ $stream: true });
      expect(nodes.size).toBe(1);
      expect([...nodes][0].module).toMatchObject({ wrapper: "handler" });
      expect([...nodes][0].inputs.$event).toBe(stream);
    });

    it("serializes stream causes without losing the stream marker", () => {
      const clickHandler = handler(
        false,
        false,
        (_event: unknown, _state: unknown) => {},
      );

      const clickPattern = pattern(() => {
        const click = clickHandler({} as never).for(
          { stream: "click" },
          true,
        );
        return { click };
      });

      expect(clickPattern.result).toEqual({
        click: {
          $alias: {
            partialCause: { stream: "click" },
            path: [],
            schema: true,
            scope: "space",
          },
        },
      });
      expect(clickPattern.derivedInternalCells).toEqual([{
        partialCause: { stream: "click" },
        schema: { default: { $stream: true } },
      }]);
      const handlerInputs = clickPattern.nodes[0].inputs as {
        $event: unknown;
      };
      expect(handlerInputs.$event).toEqual({
        $alias: {
          partialCause: { stream: "click" },
          path: [],
          schema: true,
          scope: "space",
        },
      });
    });

    it("serializes anonymous stream roots with partial causes", () => {
      const clickHandler = handler(
        false,
        false,
        (_event: unknown, _state: unknown) => {},
      );

      const clickPattern = pattern(() => clickHandler({} as never));

      const generatedStreamCause = { $generated: 0, $kind: "stream" };
      expect(clickPattern.result).toEqual({
        $alias: {
          partialCause: generatedStreamCause,
          path: [],
          schema: true,
          scope: "space",
        },
      });
      expect(clickPattern.derivedInternalCells).toEqual([{
        partialCause: generatedStreamCause,
        schema: { default: { $stream: true } },
      }]);
      const handlerInputs = clickPattern.nodes[0].inputs as {
        $event: unknown;
      };
      expect(handlerInputs.$event).toEqual({
        $alias: {
          partialCause: generatedStreamCause,
          path: [],
          schema: true,
          scope: "space",
        },
      });
    });

    it("serializes array causes as stable internal path segments", () => {
      const arrayCausePattern = pattern(() => {
        const value = new CellImpl<number>(
          runtime,
          undefined,
          { path: [], space, schema: { default: 1 } },
          false,
        );
        return {
          value: value.for(["a", "b"], true),
        };
      });

      expect(arrayCausePattern.result).toEqual({
        value: {
          $alias: {
            partialCause: ["a", "b"],
            path: [],
            schema: { default: 1 },
            scope: "space",
          },
        },
      });
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

      const elements = reactive({ button1: true, button2: false });
      const result = toggleHandler({ elements } as any);

      expect(isReactive(result)).toBe(true);
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
      const stream = clickHandler.with({ x: reactive(10), y: reactive(20) });
      expect(isReactive(stream)).toBe(true);
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
    // Eager source-location resolution is off by default (debug-only; the boot
    // lever). This block tests that resolution, so enable it here.
    beforeEach(() => setEagerSourceAnnotation(true));
    afterEach(() => setEagerSourceAnnotation(false));

    const compileMain = async (source: string) => {
      const program = {
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents: source }],
      };

      return await runtime.harness.compileAndEvaluateModules(program);
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

    it("attaches source location through lift", () => {
      const fn = (x: number) => x * 2;
      lift(fn)(reactive(5));

      // lift should track the original function's source location
      expect(fn.name).toMatch(/module\.test\.ts:\d+:\d+$/);
    });

    it("maps computed callsites through the CTS pipeline", async () => {
      const source = [
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

    it("resolves an ESM-loader browser eval frame to the canonical cf:module source", () => {
      // Under the ESM module loader in a BROWSER, `new Error().stack` surfaces
      // the per-module eval frame whose file is the `//# sourceURL` the loader
      // tags each `compartment.evaluate` with (the prefixed per-module source
      // name). The engine registers a per-module source map under that exact
      // sourceURL (see engine.ts near `loadSourceMap`), and the production
      // resolver uses `canonicalizingMapPosition`, which maps the coordinate to
      // the authored source and then upgrades it to the reload-stable canonical
      // `cf:module/<hash>/<path>` form. Both source-location consumers (CFC
      // verified-source AND the scheduler implementation hash) require that
      // canonical output, so pin the browser resolution path here. (Deno's tamed
      // SES strips this frame, falling back to the indexOf-into-`script` path
      // exercised by esm-source-location.test.ts — the browser relies on THIS.)
      const ESM_SOURCE_URL = "/2b3c/main.tsx"; // per-module eval sourceURL
      const CANONICAL = "cf:module/2b3cZ9hashZ9/main.tsx";
      const stack = [
        "Error",
        "    at getExternalSourceLocation (bundle.js:10:5)",
        "    at annotateFunctionDebugMetadata (bundle.js:11:5)",
        "    at createNodeFactory (bundle.js:12:5)",
        "    at handler (bundle.js:13:5)",
        // The authored handler, as a browser eval frame keyed on the sourceURL.
        `    at inc (${ESM_SOURCE_URL}:2:33)`,
      ].join("\n");

      const result = resolveSourceLocationFromStack(
        stack,
        // Mimics `canonicalizingMapPosition`: only the per-module eval frame has
        // a registered map, and it resolves to the canonical cf:module form.
        (file, _line, _col) =>
          file === ESM_SOURCE_URL
            ? { source: CANONICAL, line: 2, column: 33 }
            : null,
      );

      expect(result.location).toBe(`${CANONICAL}:2:33`);
    });
  });
});
