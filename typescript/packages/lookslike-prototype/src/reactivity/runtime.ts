import {
  CONTENT_TYPE_CLOCK,
  CONTENT_TYPE_DATA,
  CONTENT_TYPE_EVENT_LISTENER,
  CONTENT_TYPE_FETCH,
  CONTENT_TYPE_GLSL,
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
import { truncatedJSON } from "../text.js";
import { Sendable } from "@commontools/common-frp";
import { gem } from "../state.js";

const intervals = {} as { [key: string]: NodeJS.Timeout };

async function executeNode(
  graph: Graph,
  node: RuntimeNode,
  inputs: { [key: string]: any }
): Promise<any> {
  console.log("executing", node.id);
  switch (node.definition.contentType) {
    case CONTENT_TYPE_JAVASCRIPT: {
      const result = await run(
        node.id,
        node.definition.body,
        inputs,
        node.definition.evalMode
      );
      return result;
    }
    case CONTENT_TYPE_EVENT_LISTENER: {
      const result = await run(
        node.id,
        node.definition.body.code,
        inputs,
        node.definition.evalMode
      );
      return result;
    }
    case CONTENT_TYPE_GLSL:
      return node.definition.body;
    case CONTENT_TYPE_DATA: {
      // read the value from any input key and use that as the new value, if no inputs use the old value
      const value = Object.values(inputs).filter(
        (i) => i != null && i != undefined
      )?.[0];
      if (value) {
        return value;
      }

      return graph.db[node.id];
    }
    case CONTENT_TYPE_UI: {
      const fns: { [name: string]: Sendable<any> } = {};

      const onEvent = {
        send: ({ name, event }) => {
          console.log("event", node.id, name, event);

          [...graph.nodes.values()]
            .filter((n) => {
              return (
                n.definition.contentType == CONTENT_TYPE_EVENT_LISTENER &&
                n.definition.body.event == name
              );
            })
            .forEach((n) => {
              console.log("executing handler", name, n.id, event);
              n.execute();
            });
        }
      };

      // for (const n of graph.nodes.values()) {
      //   if (n.definition.contentType == CONTENT_TYPE_JAVASCRIPT) {
      //     const sendable = {
      //       send: (_: any) => {
      //         // n.update();
      //         n.execute();
      //       }
      //     };
      //     fns[n.id] = sendable;
      //   }

      //   if (n.definition.contentType == CONTENT_TYPE_DATA) {
      //     const sendable = {
      //       send: (value: any) => {
      //         graph.db[n.id] = value;
      //       }
      //     };
      //     fns[n.id] = sendable;
      //   }
      // }

      const namespace = {
        // ...fns,
        ...inputs,
        onEvent
      };

      const template = createElement(node.definition.body, namespace);
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
  public nodes: Map<string, RuntimeNode> = new Map();
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
      node = new RuntimeNode(this.db, id, definition);
    }

    this.log("adding", id);
    this.nodes.set(node.id, node);
    if (definition.contentType === CONTENT_TYPE_DATA) {
      const saved = localStorage.getItem(id);

      if (saved) {
        node.write(JSON.parse(saved));
      } else {
        node.write(definition.body);
      }
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

export class RuntimeNode {
  private runner?: ReactiveEffectRunner;
  public inputs: Map<string, string> = new Map();
  public graph: Graph | undefined;

  constructor(
    public db: Db,
    public id: string,
    public definition: RecipeNode
  ) {}

  write(value: any) {
    this.log("write", this.id, truncatedJSON(value));
    gem(this.db, this.id).set(value);
  }

  read() {
    return gem(this.db, this.id).get();
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

  public async execute() {
    if (!this.graph) {
      throw new Error("Node has no graph");
    }

    if (this.inputs.size > 0) {
      const args = Array.from(this.inputs.entries()).map(([key, value]) => {
        return [key, this.db[value]];
      });

      if (args.some(([name, value]) => value === undefined)) {
        if (this.definition.contentType === CONTENT_TYPE_JAVASCRIPT) {
          this.log("skip", this.id);
          return;
        }
      }

      this.log("recomputing...", this.id);

      const result = await executeNode(
        this.graph,
        this,
        Object.fromEntries(args)
      );
      this.log("result", this.id);
      gem(this.db, this.id).set(result);
    } else {
      this.log("recomputing (no args)...", this.id);
      const result = await executeNode(this.graph, this, {});
      this.log("result", this.id);
      gem(this.db, this.id).set(result);
    }
  }

  async update() {
    this.dispose();

    if (this.definition.contentType === CONTENT_TYPE_EVENT_LISTENER) {
      // event listeners do not bind to their inputs, they are only triggered by uh... events
      return;
    }

    this.runner = effect(async () => {
      this.log("effect ran", this.id, this.inputs);
      this.execute();
    });
  }
}
