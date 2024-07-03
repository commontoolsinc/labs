import {
  CONFIDENTIAL_COMPUTE_SANDBOX,
  SES_SANDBOX,
  WASM_SANDBOX
} from "@commontools/runtime";

import {
  Subject,
  BehaviorSubject,
  Observable,
  combineLatest,
  Subscription
} from "rxjs";
import {
  debounceTime,
  distinct,
  filter,
  map,
  switchMap,
  take
} from "rxjs/operators";
import { CONTENT_TYPE_JAVASCRIPT } from "./contentType.js";

export type EvalMode =
  | typeof WASM_SANDBOX
  | typeof SES_SANDBOX
  | typeof CONFIDENTIAL_COMPUTE_SANDBOX;

export type SpecTree = {
  history: Message[];
  steps: {
    description: string;
    associatedNodes: NodeId[];
  }[];
};

export type NodeId = string;

export type Recipe = {
  spec: SpecTree;
  inputs: NodeId[];
  outputs: NodeId[];
  nodes: RecipeNode[];
  connections: RecipeConnectionMap;
};
export type ConnectionMap = { [port: string]: string };
export type RecipeConnectionMap = { [nodeId: string]: ConnectionMap };

export type RecipeNode = {
  id: string;
  contentType: string;
  body: any;
  evalMode?: EvalMode;
};

export type Message = {
  role: "user" | "assistant";
  content: string;
};

type NodeValue = any;

async function executeNode(
  node: RecipeNode,
  inputs: { [key: string]: NodeValue }
): Promise<NodeValue> {
  switch (node.contentType) {
    case CONTENT_TYPE_JAVASCRIPT:
      try {
        // Execute JavaScript code
        const func = new Function(
          ...Object.keys(inputs),
          `return ((${node.body})(...arguments))`
        );
        return func(...Object.values(inputs));
      } catch (e) {
        console.error(`Error executing node ${node.id}: ${e}`);
        return null;
      }
    case "text":
      // Return text content
      return node.body;
    // Add more content types as needed
    default:
      console.warn(`Unsupported content type: ${node.contentType}`);
    // throw new Error(`Unsupported content type: ${node.contentType}`);
  }
}

export class ReactiveNode {
  private subject: Subject<NodeValue> | BehaviorSubject<NodeValue>;
  private inputs: { [key: string]: Observable<NodeValue> } = {};
  private executionSubscription: Subscription | null = null;
  value: NodeValue;

  constructor(
    public readonly id: string,
    public readonly node: RecipeNode,
    initialValue?: NodeValue
  ) {
    this.subject =
      initialValue !== undefined
        ? new BehaviorSubject<NodeValue>(initialValue)
        : new Subject<NodeValue>();
  }

  addInput(name: string, observable: Observable<NodeValue>) {
    console.log(`Adding input ${name} to node ${this.id}`);
    this.inputs[name] = observable;
    this.setupExecution();
  }

  removeInput(name: string) {
    console.log(`Removing input ${name} from node ${this.id}`);
    if (this.inputs[name]) {
      delete this.inputs[name];
      this.setupExecution();
    }
  }

  getValue(): Observable<NodeValue> {
    return this.subject.asObservable();
  }

  getValueAsPromise(): Promise<NodeValue> {
    return new Promise((resolve) => {
      this.subject.pipe(take(1)).subscribe((value) => resolve(value));
    });
  }

  private update(value: NodeValue) {
    this.value = value;
    this.subject.next(value);
  }

  private setupExecution() {
    // Dispose of the previous subscription if it exists
    if (this.executionSubscription) {
      this.executionSubscription.unsubscribe();
    }

    if (Object.keys(this.inputs).length > 0) {
      this.executionSubscription = combineLatest(this.inputs)
        .pipe(
          filter((v) => v !== undefined),
          debounceTime(0),
          switchMap((inputs) => this.executeNode(inputs))
        )
        .subscribe(
          (result) => {
            console.log(
              `Node ${this.id} updated because inputs changed`,
              result
            );
            this.update(result);
          },
          (error) => console.error(`Error executing node ${this.id}:`, error)
        );
    } else {
      // For nodes without inputs, we don't need a subscription
      this.executeNode({}).then(
        (result) => this.update(result),
        (error) => console.error(`Error executing node ${this.id}:`, error)
      );
    }
  }

  async executeNode(inputs: { [key: string]: NodeValue }): Promise<NodeValue> {
    console.log(`Executing node ${this.id} with inputs:`, inputs);
    const result = await executeNode(this.node, inputs);
    this.update(result);
    return result;
  }

  replaceNode(node: RecipeNode) {
    this.node = node;
    this.setupExecution();
  }

  // Method to clean up subscriptions
  dispose() {
    if (this.executionSubscription) {
      this.executionSubscription.unsubscribe();
    }
    if (this.subject instanceof BehaviorSubject) {
      this.subject.complete();
    }
  }
}

export class GraphSnapshot {
  recipeTree: Recipe;
  constructor(recipeTree: Recipe) {
    this.recipeTree = recipeTree;
  }
}

export class ReactiveGraph {
  nodes: Map<string, ReactiveNode> = new Map();
  private executionOrder: string[] = [];
  readonly changes: Subject<GraphSnapshot> = new Subject();

  constructor(private recipeTree: Recipe) {}

  build() {
    this.createNodes(this.recipeTree);
    this.connectNodes();
    this.calculateExecutionOrder();
    this.initializeNodes();

    this.changes.next(new GraphSnapshot(this.recipeTree));
  }

  listInputsForNode(nodeId: string): [string, string][] {
    return Object.entries(this.recipeTree.connections[nodeId] || {});
  }

  listNodes(): [string, ReactiveNode][] {
    return Object.entries(this.nodes);
  }

  jsonSnapshot() {
    return JSON.stringify(this.snapshot(), null, 2);
  }

  snapshot() {
    return new GraphSnapshot(this.recipeTree);
  }

  private createNodes(tree: Recipe) {
    for (const child of tree.nodes) {
      this.nodes.set(child.id, new ReactiveNode(child.id, child));
    }
  }

  private connectNodes() {
    for (const [nodeId, connections] of Object.entries(
      this.recipeTree.connections
    )) {
      const node = this.nodes.get(nodeId);
      if (!node) {
        console.warn(`Node ${nodeId} not found in the graph.`);
        continue;
      }

      for (const [inputName, sourceId] of Object.entries(connections)) {
        const sourceNode = this.nodes.get(sourceId);
        if (!sourceNode) {
          console.warn(
            `Source node ${sourceId} not found for input ${inputName} of node ${nodeId}.`
          );
          continue;
        }
        node.addInput(inputName, sourceNode.getValue());
      }
    }
  }

  private calculateExecutionOrder() {
    const visited = new Set<string>();
    const tempVisited = new Set<string>();
    this.executionOrder = []; // Reset execution order

    const visit = (nodeId: string) => {
      if (tempVisited.has(nodeId)) {
        throw new Error(
          `Circular dependency detected involving node ${nodeId}`
        );
      }
      if (visited.has(nodeId)) return;

      tempVisited.add(nodeId);

      const connections = this.recipeTree.connections[nodeId] || {};
      for (const sourceId of Object.values(connections)) {
        visit(sourceId);
      }

      tempVisited.delete(nodeId);
      visited.add(nodeId);
      this.executionOrder.push(nodeId); // Changed from unshift to push
    };

    for (const nodeId of this.nodes.keys()) {
      visit(nodeId);
    }
  }

  private initializeNodes() {
    for (const nodeId of this.executionOrder) {
      const node = this.nodes.get(nodeId);
      if (node && Object.keys(node["inputs"]).length == 0) {
        node["executeNode"]({}); // Trigger initial execution
      }
    }
  }

  addConnection(fromNode: string, toNode: string, portName: string) {
    console.log(
      `Adding connection from ${fromNode} to ${toNode}, port ${portName}`
    );
    const newRecipeTree = { ...this.recipeTree };
    newRecipeTree.connections[toNode] ||= {};
    newRecipeTree.connections[toNode][portName] = fromNode;

    this.updateGraph(newRecipeTree);
  }

  addNode(node: RecipeNode, description: string) {
    const newRecipeTree = { ...this.recipeTree };
    newRecipeTree.spec.steps.push({
      associatedNodes: [node.id],
      description
    });

    const insertNode = (tree: Recipe) => {
      tree.nodes.push(node);
    };

    insertNode(newRecipeTree);
    this.updateGraph(newRecipeTree);
  }

  removeNode(nodeId: string) {
    const newRecipeTree = { ...this.recipeTree };

    // walk tree and remove node
    const removeNode = (tree: Recipe) => {
      tree.nodes = tree.nodes.filter((node) => {
        if (node.id === nodeId) {
          return false;
        }
        return true;
      });
    };

    removeNode(newRecipeTree);
    const newConnectionMap = { ...this.recipeTree.connections };
    delete newConnectionMap[nodeId];
    for (const connections of Object.values(newConnectionMap)) {
      delete connections[nodeId];
    }
    this.updateGraph(newRecipeTree);
  }

  updateGraph(newRecipeTree: Recipe) {
    const oldNodes = new Map(this.nodes);
    const newNodes = new Map<string, ReactiveNode>();

    // Update or create nodes
    this.updateNodes(newRecipeTree, oldNodes, newNodes);

    // Remove nodes that are no longer present
    for (const [nodeId, node] of oldNodes) {
      if (!newNodes.has(nodeId)) {
        node.dispose();
      }
    }

    this.nodes = newNodes;

    // Update connections
    this.updateConnections(newRecipeTree.connections);

    // Recalculate execution order and reinitialize
    this.calculateExecutionOrder();
    this.initializeNodes();

    this.recipeTree = newRecipeTree;
    this.changes.next(new GraphSnapshot(this.recipeTree));
  }

  private updateNodes(
    tree: Recipe,
    oldNodes: Map<string, ReactiveNode>,
    newNodes: Map<string, ReactiveNode>
  ) {
    for (const node of tree.nodes) {
      if (oldNodes.has(node.id)) {
        // Node exists, update it if necessary
        const existingNode = oldNodes.get(node.id)!;

        existingNode.replaceNode(node);
        newNodes.set(node.id, existingNode);
        oldNodes.delete(node.id);
      } else {
        // New node, create it
        const newNode = new ReactiveNode(node.id, node);
        newNodes.set(node.id, newNode);
      }
    }
  }

  private updateConnections(newConnectionMap: RecipeConnectionMap) {
    for (const [nodeId, newConnections] of Object.entries(newConnectionMap)) {
      const node = this.nodes.get(nodeId);
      if (!node) {
        console.warn(`Node ${nodeId} not found in the graph.`);
        continue;
      }

      const oldConnections = this.recipeTree.connections[nodeId] || {};

      // Remove old connections that are no longer present
      for (const [inputName, oldSourceId] of Object.entries(oldConnections)) {
        if (!newConnections[inputName]) {
          node.removeInput(inputName);
        }
      }

      // Add new connections
      for (const [inputName, newSourceId] of Object.entries(newConnections)) {
        const sourceNode = this.nodes.get(newSourceId);
        if (sourceNode) {
          node.addInput(inputName, sourceNode.getValue());
        } else {
          console.warn(
            `Source node ${newSourceId} not found for input ${inputName} of node ${nodeId}.`
          );
        }
      }
    }
  }

  // Method to dispose of the entire graph
  dispose() {
    for (const node of this.nodes.values()) {
      node.dispose();
    }
    this.nodes.clear();
    this.executionOrder = [];
  }
}
