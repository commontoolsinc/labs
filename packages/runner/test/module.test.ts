import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  type Frame,
  isModule,
  isOpaqueRef,
  type JSONSchema,
  type Module,
  type OpaqueRef,
} from "../src/builder/types.ts";
import { handler, lift } from "../src/builder/module.ts";
import { opaqueRef } from "../src/builder/opaque-ref.ts";
import { popFrame, pushFrame } from "../src/builder/recipe.ts";

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
      expect(module.argumentSchema?.description).toBe("Person information");
      expect(module.resultSchema?.description).toBe("Greeting message");
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
      const { value, nodes } =
        (stream as unknown as OpaqueRef<{ $stream: true }>).export();
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
      expect(module.argumentSchema?.properties?.$event).toEqual(eventSchema);
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
      const { value, nodes } =
        (stream as unknown as OpaqueRef<{ $stream: true }>).export();
      expect(value).toEqual({ $stream: true });
      expect(nodes.size).toBe(1);
      expect([...nodes][0].module).toMatchObject({ wrapper: "handler" });
      expect([...nodes][0].inputs.$event).toBe(stream);
    });
  });
});
