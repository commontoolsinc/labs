import { beforeEach, describe, expect, test, vi } from "vitest";
import { ReactiveGraph, Graph } from "./nested.js";
import { firstValueFrom } from "rxjs";

describe("ReactiveGraph", () => {
  let serializedGraph: Graph;

  beforeEach(() => {
    serializedGraph = {
      id: "root",
      type: "scope",
      nodes: [
        { id: "input1", type: "variable", default: 0 },
        { id: "input2", type: "variable", default: 0 },
        {
          id: "process1",
          type: "function",
          inputs: {
            a: { type: "number" },
            b: { type: "number" }
          },
          body: "(a, b) => a + b"
        },
        {
          id: "subgraph",
          type: "scope",
          nodes: [
            { id: "subInput", type: "variable", default: 0 },
            {
              id: "subProcess",
              type: "function",
              inputs: { x: { type: "number" } },
              body: "x => x * 2"
            }
          ],
          connections: [
            {
              bind: "subInput",
              toNode: {
                node: "subProcess",
                port: "x"
              }
            }
          ]
        }
      ],
      connections: [
        { bind: "input1", toNode: { node: "process1", port: "a" } },
        { bind: "input2", toVariable: "subgraph.subInput" },
        { bind: "subgraph.subProcess", toNode: { node: "process1", port: "b" } }
      ]
    };
  });

  test("Graph construction", () => {
    const graph = new ReactiveGraph(serializedGraph);
    expect(graph).toBeDefined();
  });

  function dumpDebugDataForGraph(graph: ReactiveGraph) {
    console.log("graph._nodes", graph["nodes"]);
  }

  test("Input propagation", async () => {
    const graph = new ReactiveGraph(serializedGraph);
    graph.logGraphState();

    vi.useFakeTimers();

    const output = graph.getNodeOutput("root.output1");
    output?.subscribe({
      next: (value) => {
        console.log("output", value);
        // expect(value).toBe(11); // 5 + (2 * 2)
      }
    });

    graph.setNodeInput("root", "input1", 5);
    graph.setNodeInput("root", "input2", 2);
    // graph.setNodeInput("root.subgraph.subInput", 3);

    await vi.runAllTimersAsync();

    graph.logGraphState();

    // dumpDebugDataForGraph(graph);
  });

  test("Subgraph execution", async () => {
    const graph = new ReactiveGraph(serializedGraph);

    graph.setNodeInput("root.subgraph.subInput", 4);

    const subgraphOutput = await firstValueFrom(
      graph.getNodeOutput("root.subgraph.subOutput")!
    );
    expect(subgraphOutput).toBe(8); // 4 * 2
  });

  test("Multiple input updates", async () => {
    const graph = new ReactiveGraph(serializedGraph);

    graph.setNodeInput("root.input1", 10);
    graph.setNodeInput("root.subgraph.subInput", 5);

    let output = await firstValueFrom(graph.getNodeOutput("root.output1")!);
    expect(output).toBe(20); // 10 + (5 * 2)

    graph.setNodeInput("root.input1", 7);

    output = await firstValueFrom(graph.getNodeOutput("root.output1")!);
    expect(output).toBe(17); // 7 + (5 * 2)
  });

  test("Non-existent node handling", () => {
    const graph = new ReactiveGraph(serializedGraph);

    expect(graph.getNodeOutput("non.existent.node")).toBeUndefined();
    expect(() => graph.setNodeInput("non.existent.node", 10)).not.toThrow();
  });

  test("Cyclic dependency handling", async () => {
    const cyclicGraph: SerializedGraph = {
      root: {
        id: "root",
        type: "namespace",
        ports: [],
        nodes: [
          {
            id: "node1",
            type: "process",
            ports: [{ id: "x", contentType: "number" }],
            contentType: "javascript",
            body: "x => x + 1"
          },
          {
            id: "node2",
            type: "process",
            ports: [{ id: "x", contentType: "number" }],
            contentType: "javascript",
            body: "x => x * 2"
          }
        ],
        connections: [
          { from: "node1", to: "node2", port: "x" },
          { from: "node2", to: "node1", port: "x" }
        ]
      }
    };

    const graph = new ReactiveGraph(cyclicGraph);

    // This should not cause an infinite loop
    graph.setNodeInput("root.node1", 1);

    const output = await firstValueFrom(graph.getNodeOutput("root.node2")!);
    expect(output).toBeDefined();
  });
});
