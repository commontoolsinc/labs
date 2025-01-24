import { afterEach, beforeEach, describe, it } from "jsr:@std/testing/bdd";
import { expect } from "jsr:@std/expect";
import {
  type Frame,
  isModule,
  isOpaqueRef,
  type JSONSchema,
  type Module,
  type OpaqueRef,
} from "../src/types.ts";
import { handler, lift } from "../src/module.ts";
import { opaqueRef } from "../src/opaque-ref.ts";
import { pushFrame } from "../src/recipe.ts";
import { popFrame } from "../src/recipe.ts";
import { z } from "zod";

type MouseEvent = {
  clientX: number;
  clientY: number;
};

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
});
