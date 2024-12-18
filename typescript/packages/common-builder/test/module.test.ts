import { describe, it, expect, afterEach, beforeEach } from "vitest";
import {
  isOpaqueRef,
  isModule,
  OpaqueRef,
  Module,
  Frame,
} from "../src/types.js";
import { lift, handler, isolated } from "../src/module.js";
import { opaqueRef } from "../src/opaque-ref.js";
import { JavaScriptModuleDefinition } from "@commontools/common-runtime";
import { pushFrame } from "../src/recipe.js";
import { popFrame } from "../src/recipe.js";

describe("module", () => {
  let frame: Frame;

  beforeEach(() => {
    frame = pushFrame();
  });

  afterEach(() => {
    popFrame(frame);
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
  });

  describe("handler function", () => {
    it("creates a node factory for event handlers", () => {
      const clickHandler = handler<MouseEvent, { x: number; y: number }>(
        (event, props) => {
          props.x = event.clientX;
          props.y = event.clientY;
        }
      );
      expect(typeof clickHandler).toBe("function");
      expect(isModule(clickHandler)).toBe(true);
    });

    it("creates a opaque ref with stream when called", () => {
      const clickHandler = handler<MouseEvent, { x: number; y: number }>(
        (event, props) => {
          props.x = event.clientX;
          props.y = event.clientY;
        }
      );
      const stream = clickHandler({ x: opaqueRef(10), y: opaqueRef(20) });
      expect(isOpaqueRef(stream)).toBe(true);
      const { value, nodes } = (
        stream as unknown as OpaqueRef<{ $stream: true }>
      ).export();
      expect(value).toEqual({ $stream: true });
      expect(nodes.size).toBe(1);
      expect([...nodes][0].module).toMatchObject({ wrapper: "handler" });
      expect([...nodes][0].inputs.$event).toBe(stream);
    });
  });

  describe("isolated function", () => {
    it("creates a node factory for isolated modules", () => {
      const add = isolated<{ a: number; b: number }, number>(
        { a: { tag: "number", val: 0 }, b: { tag: "number", val: 0 } },
        { result: "number" },
        ({ a, b }) => a + b
      );
      expect(typeof add).toBe("function");
      const result = add({ a: 1, b: 2 });
      expect(isOpaqueRef(result)).toBe(true);
      expect(result.export().nodes.size).toBe(1);
      const module = [...result.export().nodes][0].module as Module;
      expect(module.type).toBe("isolated");
      const definition = module.implementation as JavaScriptModuleDefinition;
      expect(definition.body).toContain("export const run = () => {");
      expect(definition.body).toContain(
        'inputs["a"] = read("a")?.deref()?.val;'
      );
      expect(definition.body).toContain(
        'inputs["b"] = read("b")?.deref()?.val;'
      );
      expect(definition.body).toContain('write("result", {');
      expect(definition.inputs).toMatchObject({
        a: { tag: "number", val: 0 },
        b: { tag: "number", val: 0 },
      });
      expect(definition.outputs).toMatchObject({
        result: "number",
      });
    });
  });
});
