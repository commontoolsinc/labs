import { describe, it, expect, afterEach, beforeEach } from "vitest";
import {
  isOpaqueRef,
  isModule,
  OpaqueRef,
  Module,
  Frame,
  JSONSchema,
} from "../src/types.js";
import { lift, handler, isolated } from "../src/module.js";
import { opaqueRef } from "../src/opaque-ref.js";
import { JavaScriptModuleDefinition } from "@commontools/common-runtime";
import { pushFrame } from "../src/recipe.js";
import { popFrame } from "../src/recipe.js";
import { z } from "zod";

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

    it("supports JSON Schema validation", () => {
      const schema = {
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "number" },
        },
        required: ["name"],
      } as JSONSchema;

      const greet = lift(
        schema,
        { type: "string" },
        ({ name, age }) => `Hello ${name}${age ? `, age ${age}` : ""}!`,
      );

      expect(isModule(greet)).toBe(true);
      const module = greet as unknown as Module;
      expect(module.argumentSchema).toEqual(schema);
    });

    it("supports Zod schema validation", () => {
      const inputSchema = z.object({
        name: z.string(),
        age: z.number().optional(),
      });
      const outputSchema = z.string();

      const greet = lift(
        inputSchema,
        outputSchema,
        ({ name, age }) => `Hello ${name}${age ? `, age ${age}` : ""}!`,
      );

      expect(isModule(greet)).toBe(true);
      const module = greet as unknown as Module;
      expect(module.argumentSchema).toBeDefined();
      expect(module.resultSchema).toBeDefined();
    });
  });

  describe("handler function", () => {
    it("creates a node factory for event handlers", () => {
      const clickHandler = handler<MouseEvent, { x: number; y: number }>(
        (event, props) => {
          props.x = event.clientX;
          props.y = event.clientY;
        },
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

    it("supports event and state schema validation", () => {
      const eventSchema = {
        type: "object",
        properties: {
          type: { type: "string", enum: ["click", "hover"] },
          x: { type: "number" },
          y: { type: "number" },
        },
        required: ["type", "x", "y"],
      } as JSONSchema;

      const stateSchema = {
        type: "object",
        properties: {
          lastX: { type: "number" },
          lastY: { type: "number" },
        },
      } as JSONSchema;

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
      expect(module.argumentSchema?.properties?.$event).toEqual(eventSchema);
    });

    it("supports Zod schema for events and state", () => {
      const eventSchema = z.object({
        type: z.enum(["click", "hover"]),
        x: z.number(),
        y: z.number(),
      });

      const stateSchema = z.object({
        lastX: z.number(),
        lastY: z.number(),
      });

      const mouseHandler = handler(eventSchema, stateSchema, (event, state) => {
        state.lastX = event.x;
        state.lastY = event.y;
      });

      expect(isModule(mouseHandler)).toBe(true);
      const module = mouseHandler as unknown as Module;
      expect(module.argumentSchema).toBeDefined();
      expect(module.argumentSchema?.properties?.$event).toBeDefined();
    });

    it("creates handler with proper type references", () => {
      const eventSchema = z.object({
        type: z.enum(["click", "hover"]),
        target: z.string(),
      });

      const stateSchema = z.object({
        elements: z.record(z.string(), z.boolean()),
      });

      const toggleHandler = handler(
        eventSchema,
        stateSchema,
        (event, state) => {
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
      expect(handlerNode.inputs.elements).toBe(elements);
    });
    
    it("creates a opaque ref with stream when with is called", () => {
      const clickHandler = handler<MouseEvent, { x: number; y: number }>(
        (event, props) => {
          props.x = event.clientX;
          props.y = event.clientY;
        },
      );
      const stream = clickHandler.with({ x: opaqueRef(10), y: opaqueRef(20) });
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
        ({ a, b }) => a + b,
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
        'inputs["a"] = read("a")?.deref()?.val;',
      );
      expect(definition.body).toContain(
        'inputs["b"] = read("b")?.deref()?.val;',
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
