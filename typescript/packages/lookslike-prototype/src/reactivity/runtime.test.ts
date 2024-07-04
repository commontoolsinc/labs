import { expect, test } from "vitest";
import { Recipe, RecipeConnectionMap, RecipeNode } from "../data.js";
import { Graph, Node } from "./runtime.js";

import {
  reactive,
  computed,
  ref,
  effect,
  stop,
  pauseScheduling,
  pauseTracking,
  enableTracking,
  resetScheduling
} from "@vue/reactivity";
import { CONTENT_TYPE_DATA, CONTENT_TYPE_JAVASCRIPT } from "../contentType.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("sum effect", async () => {
  const state = reactive({
    inputA: 1,
    inputB: 2,
    sum: undefined,
    mult: undefined
  } as any);

  const sumFx = effect(async () => {
    console.log("sum effect", state.inputA, state.inputB);
    await sleep(100);
    state.sum = state.inputA + state.inputB;
  });

  const multFx = effect(async () => {
    console.log("mult effect", state.sum, state.inputB);
    await sleep(100);
    state.mult = state.sum * state.inputB;
  });

  expect(state.sum).toBe(undefined);

  await sleep(200);

  expect(state.sum).toBe(3);

  state.inputA = 5;

  await sleep(200);

  expect(state.sum).toBe(7);

  state.inputB = 3;

  await sleep(200);

  expect(state.sum).toBe(8);

  console.log(state);

  stop(multFx);
  const multFx2 = effect(async () => {
    console.log("mult2 effect", state.sum, state.inputA);
    state.mult = state.sum * state.inputA;
  });

  console.log(state);
});

test("Node test", () => {
  pauseScheduling();
  const state = reactive({});

  const a = new Node(state, "inputA", {
    id: "inputA",
    body: "1",
    contentType: CONTENT_TYPE_DATA
  });
  a.update();

  const b = new Node(state, "inputB", {
    id: "inputB",
    body: "2",
    contentType: CONTENT_TYPE_DATA
  });
  b.update();

  const sum = new Node(state, "sum", {
    id: "sum",
    body: "(a, b) => a + b",
    contentType: CONTENT_TYPE_JAVASCRIPT
  });
  sum.inputs.set("a", "inputA");
  sum.inputs.set("b", "inputB");
  sum.update();

  a.write(1);
  b.write(2);

  resetScheduling();
});

test("Graph edit API test", async () => {
  const state = reactive({});
  const graph = new Graph(state);

  graph.add("inputA", {
    id: "inputA",
    body: "1",
    contentType: CONTENT_TYPE_DATA
  });
  graph.add("inputB", {
    id: "inputB",
    body: "1",
    contentType: CONTENT_TYPE_DATA
  });

  graph.add("sum", {
    id: "sum",
    body: "(a, b) => a + b",
    contentType: CONTENT_TYPE_JAVASCRIPT
  });
  graph.connect("inputA", "sum", "a");
  graph.connect("inputB", "sum", "b");

  graph.write("inputA", 1);
  graph.write("inputB", 2);

  await graph.update();

  graph.delete("inputA");

  graph.add("inputA", {
    id: "inputA",
    body: "1",
    contentType: CONTENT_TYPE_DATA
  });
  graph.write("inputA", 2);
  await graph.update();

  expect(graph.read("sum")).toBe(4);
});

test("Load recipe JSON", async () => {
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

  const state = reactive({});
  const graph = new Graph(state);
  graph.load(addTree);

  expect(graph.nodes.size).toBe(3);

  await graph.update();

  expect(graph.read("add")).toBe(3);
});

test("Load then replace recipe JSON", async () => {
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

  const equationTree: Recipe = {
    spec: {
      history: [
        { role: "user", content: "Add two numbers" },
        { role: "user", content: "Multiply by 2" }
      ],
      steps: [
        {
          description: "Add two numbers",
          associatedNodes: ["firstNumber", "secondNumber", "add"]
        },
        {
          description: "Multiply the result of the addition by 2",
          associatedNodes: ["add", "multiply"]
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
        body: 3
      },
      {
        id: "add",
        contentType: CONTENT_TYPE_JAVASCRIPT,
        body: "(a, b) => a + b"
      },
      {
        id: "multiply",
        contentType: CONTENT_TYPE_JAVASCRIPT,
        body: "(a) => a * 2"
      }
    ],
    connections: {
      add: { a: "secondNumber", b: "firstNumber" },
      multiply: { a: "add" }
    },
    inputs: ["firstNumber", "secondNumber"],
    outputs: ["multiply"]
  };

  const state = reactive({});
  const graph = new Graph(state);
  graph.load(addTree);

  expect(graph.nodes.size).toBe(3);

  await graph.update();

  expect(graph.read("add")).toBe(3);

  graph.load(equationTree);

  expect(graph.nodes.size).toBe(4);

  await graph.update();

  expect(graph.read("multiply")).toBe(8);

  const output = graph.save();
  console.log(graph.history);
});
