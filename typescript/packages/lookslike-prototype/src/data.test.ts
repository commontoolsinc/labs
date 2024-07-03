import { BehaviorSubject, Subject } from "rxjs";
import {
  ReactiveGraph,
  Recipe,
  RecipeConnectionMap,
  RecipeNode,
  ReactiveNode
} from "./data.js";
import { describe, beforeEach, test, expect, it, vi } from "vitest";
import { CONTENT_TYPE_DATA, CONTENT_TYPE_JAVASCRIPT } from "./contentType.js";

const addTree: Recipe = {
  spec: {
    history: [{ role: "user", content: "Add two numbers" }],
    steps: [
      {
        description: "Add two numbers",
        associatedNodes: ["firstNumber", "secondNumber", "add"]
      }
    ]
  },
  nodes: [
    {
      id: "firstNumber",
      contentType: CONTENT_TYPE_DATA,
      body: 1
    },
    {
      id: "secondNumber",
      contentType: CONTENT_TYPE_DATA,
      body: 2
    },
    {
      id: "add",
      contentType: CONTENT_TYPE_JAVASCRIPT,
      body: "(a, b) => a + b"
    }
  ],
  connections: {
    add: { a: "firstNumber", b: "secondNumber" }
  },
  inputs: ["firstNumber", "secondNumber"],
  outputs: ["add"]
};

describe("ReactiveGraph", () => {
  let sampleRecipeTree: Recipe;

  beforeEach(() => {
    // Set up a sample RecipeTree
    sampleRecipeTree = addTree;
  });

  test("ReactiveGraph builds without errors", () => {
    const graph = new ReactiveGraph(sampleRecipeTree);
    expect(() => graph.build()).not.toThrow();
  });

  test("ReactiveGraph creates correct number of nodes", () => {
    const graph = new ReactiveGraph(sampleRecipeTree);
    graph.build();
    expect(graph["nodes"].size).toBe(3); // Access private property for testing
  });

  test("ReactiveGraph connects nodes correctly", () => {
    const graph = new ReactiveGraph(sampleRecipeTree);
    graph.build();

    expect(graph.nodes.size).toBe(3);
  });
});

describe("ReactiveGraph", () => {
  it("should connect nodes based on the connection map", () => {
    const graph = new ReactiveGraph(addTree);
    graph.build();

    const addNode = graph["nodes"].get("add") as ReactiveNode;
    const firstNumberNode = graph["nodes"].get("firstNumber") as ReactiveNode;
    const secondNumberNode = graph["nodes"].get("secondNumber") as ReactiveNode;
    expect(Object.keys(addNode["inputs"])).toEqual(["a", "b"]);
    expect(addNode["inputs"]["a"]).toEqual(firstNumberNode.getValue());
    expect(addNode["inputs"]["b"]).toEqual(secondNumberNode.getValue());
  });

  it("should calculate the correct execution order", () => {
    const graph = new ReactiveGraph(addTree);
    graph.build();

    expect(graph["executionOrder"]).toEqual([
      "firstNumber",
      "secondNumber",
      "add"
    ]);
  });

  it("should detect circular dependencies", () => {
    const recipeTree: Recipe = {
      nodes: [
        {
          id: "node1",
          contentType: CONTENT_TYPE_JAVASCRIPT,
          body: "a => a + 1"
        },
        {
          id: "node2",
          contentType: CONTENT_TYPE_JAVASCRIPT,
          body: "b => b + 2"
        }
      ],
      connections: {
        node1: { a: "node2" },
        node2: { b: "node1" }
      },
      inputs: [],
      outputs: [],
      spec: { history: [], steps: [] }
    };

    const graph = new ReactiveGraph(recipeTree);
    expect(() => graph.build()).toThrow("Circular dependency detected");
  });
});

describe("ReactiveNode", () => {
  it("should update its value when inputs change", async () => {
    vi.useFakeTimers();
    const node = new ReactiveNode("test", {
      id: "test",
      contentType: CONTENT_TYPE_JAVASCRIPT,
      body: "(a, b) => a + b"
    });
    const inputA = new BehaviorSubject<number>(0);
    const inputB = new BehaviorSubject<number>(0);

    node.addInput("a", inputA);
    node.addInput("b", inputB);

    inputA.next(5);
    inputB.next(3);
    const outputSpy = vi.fn();
    node.getValue().subscribe(outputSpy);

    await vi.runAllTimersAsync();

    expect(outputSpy).toHaveBeenLastCalledWith(8);
  });
});

function printCurrentStateOfGraph(graph: ReactiveGraph) {
  for (const node of graph["nodes"].values()) {
    console.log(node.id, node.value);

    for (const [key, input] of Object.entries(node["inputs"])) {
      console.log("  ", key);
    }
  }
}

describe("ReactiveGraph", () => {
  let graph: ReactiveGraph;

  const createNode = (id: string, body: string): RecipeNode => ({
    id,
    contentType: CONTENT_TYPE_JAVASCRIPT,
    body
  });

  const createRecipeTree = (
    nodes: RecipeNode[],
    connections: RecipeConnectionMap = {}
  ): Recipe => ({
    nodes,
    connections,
    inputs: [],
    outputs: [],
    spec: { history: [], steps: [] }
  });

  beforeEach(async () => {
    const initialNodes = [
      createNode("1", "() => 1"),
      createNode("2", "(a) => a + 1"),
      createNode("3", "(a, b) => a + b")
    ];

    const initialConnections: RecipeConnectionMap = {
      "2": { a: "1" },
      "3": { a: "1", b: "2" }
    };
    const initialTree = createRecipeTree(initialNodes, initialConnections);

    vi.useFakeTimers();

    graph = new ReactiveGraph(initialTree);
    graph.build();

    await vi.runAllTimersAsync();
  });

  test("Initial graph setup", async () => {
    printCurrentStateOfGraph(graph);

    expect(graph["nodes"].get("1")!.value).toBe(1);
    expect(graph["nodes"].get("2")!.value).toBe(2);
    expect(graph["nodes"].get("3")!.value).toBe(3);
  });

  test("Update node body", async () => {
    const newNodes = [
      createNode("1", "() => 10"), // Changed from 1 to 10
      createNode("2", "(a) => a + 1"),
      createNode("3", "(a, b) => a + b")
    ];

    vi.useFakeTimers();

    const newTree = createRecipeTree(newNodes);
    graph.updateGraph(newTree);
    printCurrentStateOfGraph(graph);

    await vi.runAllTimersAsync();

    expect(graph["nodes"].get("1")!.value).toBe(10);
    expect(graph["nodes"].get("2")!.value).toBe(11);
    expect(graph["nodes"].get("3")!.value).toBe(21);
  });

  test("Add new node", async () => {
    const newNodes = [
      createNode("1", "() => 1"),
      createNode("2", "(a) => a + 1"),
      createNode("3", "(a, b) => a + b"),
      createNode("4", "(a) => a * 2") // New node
    ];

    vi.useFakeTimers();

    const newTree = createRecipeTree(newNodes, { "4": { a: "3" } });

    graph.updateGraph(newTree);

    await vi.runAllTimersAsync();

    expect(graph["nodes"].get("4")!.value).toBe(6);
  });

  test("Remove node", async () => {
    const newNodes = [
      createNode("1", "() => 1"),
      createNode("3", "(a) => a * 2") // Changed to depend only on node 1
    ];
    vi.useFakeTimers();

    const newConnections: RecipeConnectionMap = {
      "3": { a: "1" }
    };
    const newTree = createRecipeTree(newNodes, newConnections);

    graph.updateGraph(newTree);

    await vi.runAllTimersAsync();

    expect(graph["nodes"].has("2")).toBeFalsy();
    expect(graph["nodes"].get("3")!.value).toBe(2);
  });

  test("Change connections", async () => {
    const newConnections: RecipeConnectionMap = {
      "2": { a: "1" },
      "3": { a: "2", b: "1" } // Changed from {'a': ['1'], 'b': ['2']}
    };

    vi.useFakeTimers();

    const newTree = createRecipeTree(
      graph["recipeTree"]["nodes"],
      newConnections
    );
    graph.updateGraph(newTree);

    await vi.runAllTimersAsync();

    expect(graph["nodes"].get("3")!.value).toBe(3); // 2 + 1 instead of 1 + 2
  });

  test("Complex update", async () => {
    const newNodes = [
      createNode("1", "() => 5"), // Changed from 1 to 5
      createNode("2", "(a) => a * 2"), // Changed from a + 1 to a * 2
      createNode("3", "(a, b) => a - b"), // Changed from a + b to a - b
      createNode("4", "(a, b) => a * b") // New node
    ];

    vi.useFakeTimers();

    const newConnections: RecipeConnectionMap = {
      "2": { a: "1" },
      "3": { a: "2", b: "1" },
      "4": { a: "2", b: "3" }
    };
    const newTree = createRecipeTree(newNodes, newConnections);

    graph.updateGraph(newTree);

    await vi.runAllTimersAsync();

    expect(graph["nodes"].get("1")!.value).toBe(5);
    expect(graph["nodes"].get("2")!.value).toBe(10);
    expect(graph["nodes"].get("3")!.value).toBe(5); // 10 - 5
    expect(graph["nodes"].get("4")!.value).toBe(50); // 10 * 5
  });

  test("Barely compatible update", async () => {
    const newNodes = [
      createNode("1", "() => 5"),
      createNode("2", "(a) => `${a} world!`"),
      createNode("3", "(a) => -3")
    ];

    vi.useFakeTimers();

    const newConnections: RecipeConnectionMap = {
      "2": { a: "1" },
      "3": { a: "2" }
    };
    const newTree = createRecipeTree(newNodes, newConnections);

    graph.updateGraph(newTree);

    await vi.runAllTimersAsync();

    const newNewNodes = [
      createNode("1", "() => 'Hello'"),
      createNode("3", "(a) => `${a} world!`"),
      createNode("2", "(a) => a.split('').reverse().join('')")
    ];
    const newNewConnections: RecipeConnectionMap = {
      "2": { a: "1" },
      "3": { a: "2" }
    };
    const newNewTree = createRecipeTree(newNewNodes, newNewConnections);

    graph.updateGraph(newNewTree);

    await vi.runAllTimersAsync();

    expect(graph["nodes"].get("1")!.value).toBe("Hello");
    expect(graph["nodes"].get("3")!.value).toBe("olleH world!"); // 10 - 5
    expect(graph["nodes"].get("2")!.value).toBe("olleH");
  });

  test("Higher level API", async () => {
    vi.useFakeTimers();

    graph.addNode(
      { id: "test", contentType: CONTENT_TYPE_JAVASCRIPT, body: "() => 'lol'" },
      [],
      "1"
    );

    graph.addNode(
      {
        id: "test2",
        contentType: CONTENT_TYPE_JAVASCRIPT,
        body: "() => 'lol'"
      },
      [],
      "1"
    );

    graph.addConnection("test", "3", "a");

    await vi.runAllTimersAsync();

    expect(graph["nodes"].get("test")!.value).toBe("lol");
    expect(graph["nodes"].get("3")!.value).toBe("lol2");
    expect(graph["nodes"].get("test2")!.value).toBe("lol");

    graph.removeNode("test2");

    await vi.runAllTimersAsync();

    expect(graph["nodes"].get("test2")).toBeUndefined();
  });
});
