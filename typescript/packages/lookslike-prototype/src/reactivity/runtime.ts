import {
  CONTENT_TYPE_CLOCK,
  CONTENT_TYPE_DATA,
  CONTENT_TYPE_FETCH,
  CONTENT_TYPE_IMAGE,
  CONTENT_TYPE_JAVASCRIPT,
  CONTENT_TYPE_LLM,
  CONTENT_TYPE_SCENE,
  CONTENT_TYPE_UI
} from "../contentType.js";
import { Recipe, RecipeConnectionMap, RecipeNode } from "../data.js";

import {
  reactive,
  computed,
  ref,
  effect,
  ReactiveEffectRunner,
  stop,
  pauseTracking,
  pauseScheduling,
  enableTracking,
  resetScheduling,
  resetTracking
} from "@vue/reactivity";
import { run } from "../eval.js";
import { createElement } from "../ui.js";
import { generateImage, streamLlm } from "../agent/llm.js";

const intervals = {} as { [key: string]: NodeJS.Timeout };

async function executeNode(
  graph: Graph,
  node: Node,
  inputs: { [key: string]: any }
): Promise<any> {
  console.log("executing", node.id);
  switch (node.definition.contentType) {
    case CONTENT_TYPE_JAVASCRIPT:
      const result = await run(
        node.id,
        node.definition.body,
        inputs,
        node.definition.evalMode
      );
      return result;
    case CONTENT_TYPE_UI: {
      const template = createElement(node.definition.body, inputs, graph);
      return template;
    }
    case CONTENT_TYPE_SCENE: {
      return inputs.data;
    }
    case CONTENT_TYPE_FETCH: {
      if (typeof node.definition.body !== "string") {
        throw new Error("Expected a string");
      }
      const url = node.definition.body;
      const response = await fetch(url);
      const data = await response.json();
      return data;
    }
    case CONTENT_TYPE_LLM: {
      const response = await streamLlm(
        JSON.stringify(inputs.prompt),
        "",
        (preview) => {}
      );
      return response;
    }
    case CONTENT_TYPE_IMAGE: {
      const response = await generateImage(JSON.stringify(inputs.prompt));
      return response;
    }
    case CONTENT_TYPE_DATA:
      return node.read();
    // try {
    //   // Execute JavaScript code
    //   const func = new Function(
    //     ...Object.keys(inputs),
    //     `return ((${node.body})(...arguments))`
    //   );
    //   return func(...Object.values(inputs));
    // } catch (e) {
    //   console.error(`Error executing node ${node.id}: ${e}`);
    //   return null;
    // }
    // Add more content types as needed
    default:
      console.warn(`Unsupported content type: ${node.definition.contentType}`);
    // throw new Error(`Unsupported content type: ${node.contentType}`);
  }
}

export class Graph {
  public nodes: Map<string, Node> = new Map();
  public history: any[] = [];
  public version = ref(0);

  constructor(public db: Db) {}

  load(recipe: Recipe) {
    this.log("load recipe");
    recipe.nodes.forEach((node) => {
      this.add(node.id, node);
    });

    Object.entries(recipe.connections).forEach(([targetId, connections]) => {
      Object.entries(connections).forEach(([argument, fromId]) => {
        this.connect(fromId, targetId, argument);
      });
    });

    // remove any leftover nodes not present in the recipe
    for (const id of this.nodes.keys()) {
      if (!recipe.nodes.find((node) => node.id === id)) {
        this.delete(id);
      }
    }

    // remove any leftover connections between nodes or to non-existent nodes
    for (const [targetId, connections] of Object.entries(recipe.connections)) {
      for (const [argument, fromId] of Object.entries(connections)) {
        if (!this.nodes.has(fromId) || !this.nodes.has(targetId)) {
          this.disconnect(targetId, argument);
        }
      }
    }
  }

  save(): Recipe {
    const nodes = Array.from(this.nodes.values()).map(
      (node) => node.definition
    );
    const connections: RecipeConnectionMap = {};
    for (const [targetId, node] of this.nodes) {
      for (const [argument, fromId] of node.inputs) {
        if (!connections[targetId]) {
          connections[targetId] = {};
        }
        connections[targetId][argument] = fromId;
      }
    }

    return {
      nodes,
      connections,
      spec: { history: this.history, steps: [] },
      outputs: [],
      inputs: []
    };
  }

  add(id: string, definition: RecipeNode) {
    // does node exist already?
    // update it instead
    let node = this.nodes.get(id);
    if (node) {
      node.definition = definition;
    } else {
      node = new Node(this.db, id, definition);
    }

    this.log("adding", id);
    this.nodes.set(node.id, node);
    if (definition.contentType === CONTENT_TYPE_DATA) {
      node.write(definition.body);
    }
    node.graph = this;
  }

  delete(id: string) {
    const node = this.nodes.get(id);
    if (!node) return;

    this.log("deleting", id);
    node.dispose();
    this.nodes.delete(id);
  }

  connect(fromId: string, toId: string, toArgument: string) {
    this.log("connect", fromId, toId, toArgument);
    this.nodes.get(toId)?.inputs.set(toArgument, fromId);
  }

  disconnect(id: string, argumentName: string) {
    this.log("disconnect", id, argumentName);
    this.nodes.get(id)?.inputs.delete(argumentName);
  }

  write(id: string, value: any) {
    this.nodes.get(id)?.write(value);
  }

  read(id: string) {
    return this.nodes.get(id)?.read();
  }

  log(...args: any[]) {
    console.log(...args);
    this.history.push(args);
  }

  async update() {
    this.log("update graph");
    this.version.value++;

    pauseTracking();
    pauseScheduling();

    for (const node of this.nodes.values()) {
      await node.update();
    }

    resetTracking();
    resetScheduling();
  }
}

export class Node {
  private runner?: ReactiveEffectRunner;
  public inputs: Map<string, string> = new Map();
  public graph: Graph | undefined;

  constructor(
    public db: Db,
    public id: string,
    public definition: RecipeNode
  ) {}

  write(value: any) {
    this.log("write", this.id, value);
    this.db[this.id] = value;
  }

  read() {
    return this.db[this.id];
  }

  dispose() {
    if (this.runner) {
      stop(this.runner);
      this.runner = undefined;
    }
  }

  log(...args: any[]) {
    console.log(...args);
    this.graph?.history.push(args);
  }

  // marked as async to force awaiting, the effect may be async but return instantly so we want to push back a frame
  async update() {
    this.dispose();

    this.runner = effect(async () => {
      if (!this.graph) {
        throw new Error("Node has no graph");
      }
      this.log("effect ran", this.id, this.inputs);

      if (this.inputs.size > 0) {
        const args = Array.from(this.inputs.entries()).map(([key, value]) => {
          return [key, this.db[value]];
        });

        if (args.some(([name, value]) => value === undefined)) {
          this.log("skip", this.id, args);
          return;
        }

        this.log("recomputing...", this.id, args);

        const result = await executeNode(
          this.graph,
          this,
          Object.fromEntries(args)
        );
        this.log("result", this.id, result);
        this.db[this.id] = result;
      } else {
        this.log("recomputing (no args)...", this.id);
        const result = await executeNode(this.graph, this, {});
        this.log("result", this.id, result);
        this.db[this.id] = result;
      }
    });
  }
}
