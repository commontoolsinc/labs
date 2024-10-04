import { describe, it, expect } from "vitest";
import { isCellProxy, isModule, CellProxy, Module } from "../src/types.js";
import { lift, handler, isolated } from "../src/module.js";
import { cell } from "../src/cell-proxy.js";
import { JavaScriptModuleDefinition } from "@commontools/common-runtime";

describe("lift function", () => {
  it("creates a node factory", () => {
    const add = lift<{ a: number; b: number }, number>(({ a, b }) => a + b);
    expect(typeof add).toBe("function");
    expect(isModule(add)).toBe(true);
  });

  it("creates a cell proxy when called", () => {
    const add = lift<{ a: number; b: number }, number>(({ a, b }) => a + b);
    const result = add({ a: cell(1), b: cell(2) });
    expect(isCellProxy(result)).toBe(true);
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

  it("creates a cell proxy with stream when called", () => {
    const clickHandler = handler<MouseEvent, { x: number; y: number }>(
      (event, props) => {
        props.x = event.clientX;
        props.y = event.clientY;
      }
    );
    const stream = clickHandler({ x: cell(10), y: cell(20) });
    expect(isCellProxy(stream)).toBe(true);
    const { value, nodes } = (
      stream as unknown as CellProxy<{ $stream: true }>
    ).export();
    expect(value).toEqual({ $stream: true });
    expect(nodes.size).toBe(1);
    expect([...nodes][0].module).toMatchObject({ wrapper: "handler" });
    expect([...nodes][0].inputs).toMatchObject({ $event: stream });
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
    expect(isCellProxy(result)).toBe(true);
    expect(result.export().nodes.size).toBe(1);
    const module = [...result.export().nodes][0].module as Module;
    expect(module.type).toBe("isolated");
    const definition = module.implementation as JavaScriptModuleDefinition;
    expect(definition.body).toContain("export const run = () => {");
    expect(definition.body).toContain('inputs["a"] = read("a")?.deref()?.val;');
    expect(definition.body).toContain('inputs["b"] = read("b")?.deref()?.val;');
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
