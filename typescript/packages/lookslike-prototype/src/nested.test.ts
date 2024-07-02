import { describe, it, expect, beforeEach, vi } from "vitest";
import { GraphRuntime } from "./nested.js";
import { firstValueFrom } from "rxjs";

describe("GraphRuntime", () => {
  let runtime: GraphRuntime;

  const basicGraph = {
    id: "root",
    type: "scope",
    nodes: [
      { id: "input", type: "variable", default: 1 },
      {
        id: "double",
        type: "function",
        inputs: { x: { type: "number" } },
        body: "x => x * 2"
      },
      {
        id: "render",
        type: "render",
        contentType: "text"
      }
    ],
    connections: [
      { bind: "input", toNode: { node: "double", port: "x" } },
      { bind: "double", toNode: { node: "render" } }
    ]
  };

  beforeEach(() => {
    runtime = new GraphRuntime(basicGraph);
  });

  it("should create a GraphRuntime instance", () => {
    expect(runtime).toBeInstanceOf(GraphRuntime);
  });

  it("should execute the graph", async () => {
    vi.useFakeTimers();
    const spy = vi.fn();

    runtime.subscribeToNode("render").subscribe((output) => {
      console.log("output", output);
      expect(output).toBe(0);
    });

    runtime.subscribeToNode("double").subscribe((double) => {
      console.log("double", double);
      spy(double);
    });

    runtime.subscribeToNode("input").subscribe((input) => {
      console.log("input", input);
    });

    expect(spy).toBeCalledTimes(0);

    runtime.execute();

    await vi.runAllTimersAsync();

    expect(spy).toHaveBeenCalledWith(2);
  });

  it("should update a variable value", async () => {
    vi.useFakeTimers();
    const spy = vi.fn();

    runtime.execute();
    runtime.setValue("input", 2);

    runtime.subscribeToNode("render").subscribe((render) => {
      console.log("render", render);
      spy(render);
    });
    expect(spy).toBeCalledTimes(0);

    runtime.setValue("input", 5);

    await vi.runAllTimersAsync();
    expect(spy).toHaveBeenCalledWith(10);
  });

  it("should handle nested scopes", async () => {
    const nestedGraph = {
      id: "root",
      type: "scope",
      nodes: [
        {
          id: "nested",
          type: "scope",
          nodes: [
            { id: "input", type: "variable", default: 2 },
            {
              id: "multiply",
              type: "function",
              inputs: { x: { type: "number" } },
              body: "x => x * 4"
            }
          ],
          connections: [
            { bind: "input", toNode: { node: "multiply", port: "x" } }
          ]
        },
        {
          id: "render",
          type: "render",
          contentType: "text"
        }
      ],
      connections: [{ bind: "nested.multiply", toNode: { node: "render" } }]
    };

    vi.useFakeTimers();
    const spy = vi.fn();

    const nestedRuntime = new GraphRuntime(nestedGraph);

    nestedRuntime.subscribeToNode("render").subscribe((render) => {
      console.log("render", render);
      spy(render);
    });
    expect(spy).toBeCalledTimes(0);

    await vi.runAllTimersAsync();
    nestedRuntime.execute();

    expect(spy).toHaveBeenCalledWith(8);
  });

  it("should handle nested scopes 2", async () => {
    const nestedGraph = {
      id: "root",
      type: "scope",
      nodes: [
        { id: "input", type: "variable", default: 2 },
        {
          id: "nested",
          type: "scope",
          nodes: [
            {
              id: "multiply",
              type: "function",
              inputs: { x: { type: "number" } },
              body: "x => x * 4"
            }
          ],
          connections: []
        },
        {
          id: "render",
          type: "render",
          contentType: "text"
        }
      ],
      connections: [
        { bind: "input", toNode: { node: "nested.multiply", port: "x" } },
        { bind: "nested.multiply", toNode: { node: "render" } }
      ]
    };

    vi.useFakeTimers();
    const spy = vi.fn();

    const nestedRuntime = new GraphRuntime(nestedGraph);

    nestedRuntime.subscribeToNode("render").subscribe((render) => {
      console.log("render", render);
      spy(render);
    });
    expect(spy).toBeCalledTimes(0);

    nestedRuntime.execute();
    await vi.runAllTimersAsync();

    nestedRuntime.setValue("input", 3);

    await vi.runAllTimersAsync();

    expect(spy).toHaveBeenCalledWith(12);
  });

  it("should handle deeply nested scopes", async () => {
    const deeplyNestedGraph = {
      id: "root",
      type: "scope",
      nodes: [
        { id: "input", type: "variable", default: 2 },
        {
          id: "level1",
          type: "scope",
          nodes: [
            {
              id: "level2",
              type: "scope",
              nodes: [
                {
                  id: "multiply",
                  type: "function",
                  inputs: { x: { type: "number" } },
                  body: "x => x * 3"
                }
              ],
              connections: []
            }
          ],
          connections: []
        },
        {
          id: "render",
          type: "render",
          contentType: "text"
        }
      ],
      connections: [
        {
          bind: "input",
          toNode: { node: "level1.level2.multiply", port: "x" }
        },
        { bind: "level1.level2.multiply", toNode: { node: "render" } }
      ]
    };

    vi.useFakeTimers();
    const spy = vi.fn();

    const deeplyNestedRuntime = new GraphRuntime(deeplyNestedGraph);

    deeplyNestedRuntime.subscribeToNode("render").subscribe((render) => {
      console.log("render", render);
      spy(render);
    });
    expect(spy).toBeCalledTimes(0);

    await vi.runAllTimersAsync();
    deeplyNestedRuntime.execute();

    deeplyNestedRuntime.setValue("input", 4);

    await vi.runAllTimersAsync();

    expect(spy).toHaveBeenCalledWith(12);
  });
});
