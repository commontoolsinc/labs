import { BehaviorSubject, Subject } from "rxjs";
import {
  ReactiveGraph,
  RecipeTree,
  RecipeConnectionMap,
  RecipeNode,
  ReactiveNode
} from "./data.js";
import { describe, beforeEach, test, expect, it, vi } from "vitest";
import { aQ } from "vitest/dist/reporters-yx5ZTtEV.js";
import { CONTENT_TYPE_JAVASCRIPT } from "./contentType.js";

describe("ReactiveGraph", () => {
  let sampleRecipeTree: RecipeTree;
  let sampleConnectionMap: RecipeConnectionMap;

  beforeEach(() => {
    // Set up a sample RecipeTree
    sampleRecipeTree = {
      node: { id: "root", contentType: "text", body: "Root node" },
      content: [],
      children: [
        {
          node: { id: "child1", contentType: "text", body: "Child 1" },
          content: [],
          children: []
        },
        {
          node: { id: "child2", contentType: "text", body: "Child 2" },
          content: [],
          children: []
        }
      ]
    };

    // Set up a sample ConnectionMap
    sampleConnectionMap = {
      root: {
        input1: "child1",
        input2: "child2"
      }
    };
  });

  test("ReactiveGraph builds without errors", () => {
    const graph = new ReactiveGraph(sampleRecipeTree, sampleConnectionMap);
    expect(() => graph.build()).not.toThrow();
  });

  test("ReactiveGraph creates correct number of nodes", () => {
    const graph = new ReactiveGraph(sampleRecipeTree, sampleConnectionMap);
    graph.build();
    expect(graph["nodes"].size).toBe(3); // Access private property for testing
  });

  test("ReactiveGraph connects nodes correctly", () => {
    const graph = new ReactiveGraph(sampleRecipeTree, sampleConnectionMap);
    graph.build();

    const rootNode = graph["nodes"].get("root");
    expect(rootNode).toBeDefined();
    expect(Object.keys(rootNode!["inputs"]).length).toBe(2);
    expect(rootNode!["inputs"]["input1"]).toBeDefined();
    expect(rootNode!["inputs"]["input2"]).toBeDefined();
  });
});

describe("ReactiveGraph", () => {
  it("should create nodes from a recipe tree", () => {
    const recipeTree = {
      node: { id: "root", contentType: "text", body: "Root" },
      content: [],
      children: [
        {
          node: { id: "child1", contentType: "text", body: "Child 1" },
          content: [],
          children: []
        },
        {
          node: { id: "child2", contentType: "text", body: "Child 2" },
          content: [],
          children: []
        }
      ]
    };
    const connectionMap = {};

    const graph = new ReactiveGraph(recipeTree, connectionMap);
    graph.build();

    expect(graph["nodes"].size).toBe(3);
    expect(graph["nodes"].has("root")).toBe(true);
    expect(graph["nodes"].has("child1")).toBe(true);
    expect(graph["nodes"].has("child2")).toBe(true);
  });

  it("should connect nodes based on the connection map", () => {
    const recipeTree = {
      node: {
        id: "root",
        contentType: CONTENT_TYPE_JAVASCRIPT,
        body: "(a, b) => a + b"
      },
      content: [],
      children: [
        {
          node: { id: "child1", contentType: "text", body: "5" },
          content: [],
          children: []
        },
        {
          node: { id: "child2", contentType: "text", body: "3" },
          content: [],
          children: []
        }
      ]
    };
    const connectionMap = {
      root: { a: "child1", b: "child2" }
    };

    const graph = new ReactiveGraph(recipeTree, connectionMap);
    graph.build();

    const rootNode = graph["nodes"].get("root") as ReactiveNode;
    expect(Object.keys(rootNode["inputs"])).toEqual(["a", "b"]);
  });

  it("should calculate the correct execution order", () => {
    const recipeTree = {
      node: {
        id: "root",
        contentType: CONTENT_TYPE_JAVASCRIPT,
        body: "(a, b) => a + b"
      },
      content: [],
      children: [
        {
          node: { id: "child1", contentType: "text", body: "5" },
          content: [],
          children: []
        },
        {
          node: { id: "child2", contentType: "text", body: "3" },
          content: [],
          children: []
        }
      ]
    };
    const connectionMap = {
      root: { a: "child1", b: "child2" }
    };

    const graph = new ReactiveGraph(recipeTree, connectionMap);
    graph.build();

    expect(graph["executionOrder"]).toEqual(["child1", "child2", "root"]);
  });

  it("should detect circular dependencies", () => {
    const recipeTree = {
      node: {
        id: "node1",
        contentType: CONTENT_TYPE_JAVASCRIPT,
        body: "a => a + 1"
      },
      content: [],
      children: [
        {
          node: {
            id: "node2",
            contentType: CONTENT_TYPE_JAVASCRIPT,
            body: "b => b + 2"
          },
          content: [],
          children: []
        }
      ]
    };
    const connectionMap = {
      node1: { a: "node2" },
      node2: { b: "node1" }
    };

    const graph = new ReactiveGraph(recipeTree, connectionMap);
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

  const createRecipeTree = (nodes: RecipeNode[]): RecipeTree => ({
    node: nodes[0],
    content: [],
    children: nodes
      .slice(1)
      .map((node) => ({ node, content: [], children: [] }))
  });

  beforeEach(async () => {
    const initialNodes = [
      createNode("1", "() => 1"),
      createNode("2", "(a) => a + 1"),
      createNode("3", "(a, b) => a + b")
    ];

    const initialTree = createRecipeTree(initialNodes);
    const initialConnections: RecipeConnectionMap = {
      "2": { a: "1" },
      "3": { a: "1", b: "2" }
    };

    vi.useFakeTimers();

    graph = new ReactiveGraph(initialTree, initialConnections);
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
    graph.updateGraph(newTree, graph["connectionMap"]);
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

    const newTree = createRecipeTree(newNodes);
    const newConnections: RecipeConnectionMap = {
      ...graph["connectionMap"],
      "4": { a: "3" }
    };

    graph.updateGraph(newTree, newConnections);

    await vi.runAllTimersAsync();

    expect(graph["nodes"].get("4")!.value).toBe(6);
  });

  test("Remove node", async () => {
    const newNodes = [
      createNode("1", "() => 1"),
      createNode("3", "(a) => a * 2") // Changed to depend only on node 1
    ];
    vi.useFakeTimers();

    const newTree = createRecipeTree(newNodes);
    const newConnections: RecipeConnectionMap = {
      "3": { a: "1" }
    };

    graph.updateGraph(newTree, newConnections);

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

    graph.updateGraph(graph["recipeTree"], newConnections);

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

    const newTree = createRecipeTree(newNodes);
    const newConnections: RecipeConnectionMap = {
      "2": { a: "1" },
      "3": { a: "2", b: "1" },
      "4": { a: "2", b: "3" }
    };

    graph.updateGraph(newTree, newConnections);

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

    const newTree = createRecipeTree(newNodes);
    const newConnections: RecipeConnectionMap = {
      "2": { a: "1" },
      "3": { a: "2" }
    };

    graph.updateGraph(newTree, newConnections);

    await vi.runAllTimersAsync();

    const newNewNodes = [
      createNode("1", "() => 'Hello'"),
      createNode("3", "(a) => `${a} world!`"),
      createNode("2", "(a) => a.split('').reverse().join('')")
    ];
    const newNewTree = createRecipeTree(newNewNodes);
    const newNewConnections: RecipeConnectionMap = {
      "2": { a: "1" },
      "3": { a: "2" }
    };

    graph.updateGraph(newNewTree, newNewConnections);

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
