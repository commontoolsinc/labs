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

export type EvalMode =
  | typeof WASM_SANDBOX
  | typeof SES_SANDBOX
  | typeof CONFIDENTIAL_COMPUTE_SANDBOX;

export type RecipeTree = {
  node: RecipeNode;
  content: string[];
  children: RecipeTree[];
};
export type ConnectionMap = { [port: string]: string[] };
export type RecipeConnectionMap = { [nodeId: string]: ConnectionMap };

export type RecipeNode = {
  id: string;
  contentType: string;
  body: string | object;
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
    case "javascript":
      // Execute JavaScript code
      const func = new Function(
        ...Object.keys(inputs),
        `return ((${node.body})(...arguments))`
      );
      return func(...Object.values(inputs));
    case "text":
      // Return text content
      return node.body;
    // Add more content types as needed
    default:
      throw new Error(`Unsupported content type: ${node.contentType}`);
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

  removeInput(name: string, sourceId: string) {
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

export class ReactiveGraph {
  private nodes: Map<string, ReactiveNode> = new Map();
  private executionOrder: string[] = [];

  constructor(
    private recipeTree: RecipeTree,
    private connectionMap: RecipeConnectionMap
  ) {}

  build() {
    this.createNodes(this.recipeTree);
    this.connectNodes();
    this.calculateExecutionOrder();
    this.initializeNodes();
  }

  private createNodes(tree: RecipeTree) {
    const node = new ReactiveNode(tree.node.id, tree.node);
    this.nodes.set(tree.node.id, node);

    for (const child of tree.children) {
      this.createNodes(child);
    }
  }

  private connectNodes() {
    for (const [nodeId, connections] of Object.entries(this.connectionMap)) {
      const node = this.nodes.get(nodeId);
      if (!node) {
        console.warn(`Node ${nodeId} not found in the graph.`);
        continue;
      }

      for (const [inputName, sourceIds] of Object.entries(connections)) {
        for (const sourceId of sourceIds) {
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

      const connections = this.connectionMap[nodeId] || {};
      for (const sourceIds of Object.values(connections)) {
        for (const sourceId of sourceIds) {
          visit(sourceId);
        }
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

  updateGraph(
    newRecipeTree: RecipeTree,
    newConnectionMap: RecipeConnectionMap
  ) {
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
    this.updateConnections(newConnectionMap);

    // Recalculate execution order and reinitialize
    this.calculateExecutionOrder();
    this.initializeNodes();

    this.recipeTree = newRecipeTree;
    this.connectionMap = newConnectionMap;
  }

  private updateNodes(
    tree: RecipeTree,
    oldNodes: Map<string, ReactiveNode>,
    newNodes: Map<string, ReactiveNode>
  ) {
    const nodeId = tree.node.id;
    if (oldNodes.has(nodeId)) {
      // Node exists, update it if necessary
      const existingNode = oldNodes.get(nodeId)!;

      existingNode.replaceNode(tree.node);
      newNodes.set(nodeId, existingNode);
      oldNodes.delete(nodeId);
    } else {
      // New node, create it
      const newNode = new ReactiveNode(nodeId, tree.node);
      newNodes.set(nodeId, newNode);
    }

    // Recursively process children
    for (const child of tree.children) {
      this.updateNodes(child, oldNodes, newNodes);
    }
  }

  private updateConnections(newConnectionMap: RecipeConnectionMap) {
    for (const [nodeId, newConnections] of Object.entries(newConnectionMap)) {
      const node = this.nodes.get(nodeId);
      if (!node) {
        console.warn(`Node ${nodeId} not found in the graph.`);
        continue;
      }

      const oldConnections = this.connectionMap[nodeId] || {};

      // Remove old connections that are no longer present
      for (const [inputName, oldSourceIds] of Object.entries(oldConnections)) {
        const newSourceIds = newConnections[inputName] || [];
        for (const oldSourceId of oldSourceIds) {
          if (!newSourceIds.includes(oldSourceId)) {
            node.removeInput(inputName, oldSourceId);
          }
        }
      }

      // Add new connections
      for (const [inputName, newSourceIds] of Object.entries(newConnections)) {
        const oldSourceIds = oldConnections[inputName] || [];
        for (const newSourceId of newSourceIds) {
          if (!oldSourceIds.includes(newSourceId)) {
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
