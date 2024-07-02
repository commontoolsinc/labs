import { JSONSchema } from "openai/lib/jsonschema.mjs";
import {
  Observable,
  BehaviorSubject,
  combineLatest,
  Subscription,
  from,
  Subject,
  of
} from "rxjs";
import {
  map,
  distinctUntilChanged,
  catchError,
  switchMap,
  filter,
  debounceTime,
  tap
} from "rxjs/operators";

type Id = string;
type Port = string;

type Scope = {
  id: Id;
  type: "scope";
  nodes: Node[];
  connections: Connection[];
};

type Node =
  | {
      id: Id;
      type: "variable";
      default: any;
    }
  | {
      id: Id;
      type: "function";
      inputs: { [port: string]: JSONSchema };
      body: string;
    }
  | {
      id: Id;
      type: "render";
      contentType: "html";
      source: Id;
    }
  | Scope;

type Connection =
  | {
      bind: Id;
      toNode: {
        node: Id;
        port: Port;
      };
    }
  | {
      bind: Id;
      toVariable: Id;
    };

export type Graph = Scope;

const serializedGraph: Graph = {
  id: "root",
  type: "scope",
  nodes: [
    {
      id: "sourceUrl",
      type: "variable",
      default: "https://example.com/news"
    },
    {
      id: "inputField",
      type: "function",
      inputs: { onChange: { type: "string" } },
      body: `(onChange) => ({
        tag: "input",
        type: "text",
        "@change": { type: "@binding", name: onChange }
      })`
    },
    {
      id: "render",
      type: "render",
      contentType: "html",
      source: "inputField"
    },
    {
      id: "news",
      type: "scope",
      nodes: [
        {
          id: "sourceUrl",
          type: "variable",
          default: "https://example.com/news"
        },
        {
          id: "fetchData",
          type: "function",
          inputs: { url: { type: "string" } },
          body: "async (url) => { /* fetch logic */ }"
        },
        {
          id: "processData",
          type: "function",
          inputs: { data: { type: "object" } },
          body: "(data) => { /* process logic */ }"
        },
        {
          id: "filterAds",
          type: "function",
          inputs: { data: { type: "object" } },
          body: "(data) => { /* filter logic */ }"
        }
      ],
      connections: [
        { bind: "sourceUrl", toNode: { node: "fetchData", port: "url" } },
        { bind: "fetchData", toNode: { node: "processData", port: "data" } },
        { bind: "processData", toNode: { node: "filterAds", port: "data" } }
      ]
    },
    {
      id: "listView",
      type: "scope",
      nodes: [
        {
          id: "sourceData",
          type: "variable",
          default: []
        },
        {
          id: "listItemViewTemplate",
          type: "function",
          inputs: { item: { type: "object" } },
          body: "() => (item) => tag('li', item)"
        },
        {
          id: "composedView",
          type: "function",
          inputs: { data: { type: "json" }, template: { type: "function" } },
          body: "(data, template) => data.map(template)"
        }
      ],
      connections: [
        { bind: "sourceData", toNode: { node: "composedView", port: "data" } },
        {
          bind: "listItemViewTemplate",
          toNode: {
            node: "composedView",
            port: "template"
          }
        }
      ]
    }
  ],
  connections: [
    { bind: "sourceUrl", toVariable: "news.sourceUrl" },
    { bind: "news.filterAds", toVariable: "listView.sourceData" }
  ]
};

export interface ReactiveNode {
  id: string;
  type: "input" | "output" | "process" | "namespace";
  contentType: string;
  body: string | object;
  children: Map<string, ReactiveNode>;
  inputs: Map<string, BehaviorSubject<any>>;
  output: BehaviorSubject<any>;
  subscription?: Subscription;
}

export class ReactiveGraph {
  private nodes: Map<string, ReactiveNode> = new Map();
  private subscriptions: Subscription = new Subscription();

  constructor(serialized: SerializedGraph) {
    this.buildGraph(serialized.root);
  }

  private buildGraph(
    namespace: SerializedNamespaceNode,
    prefix: string = ""
  ): ReactiveNode {
    const fullPath = prefix ? `${prefix}.${namespace.id}` : namespace.id;

    const node: ReactiveNode = {
      id: namespace.id,
      type: "namespace",
      contentType: "namespace",
      body: {},
      children: new Map(),
      inputs: new Map(),
      output: new BehaviorSubject<any>(null)
    };

    this.nodes.set(fullPath, node);

    for (const port of namespace.ports) {
      node.inputs.set(port.id, new BehaviorSubject(port.default));
    }

    for (const childNode of namespace.nodes) {
      const childPath = `${fullPath}.${childNode.id}`;
      if (childNode.type === "namespace") {
        const child = this.buildGraph(
          childNode as SerializedNamespaceNode,
          fullPath
        );
        node.children.set(childNode.id, child);
      } else {
        const child: ReactiveNode = {
          ...childNode,
          children: new Map(),
          inputs: new Map(),
          output: new BehaviorSubject<any>(null)
        };
        for (const port of childNode.ports) {
          child.inputs.set(port.id, new BehaviorSubject(port.default));
        }
        node.children.set(childNode.id, child);
        this.nodes.set(childPath, child);
        this.setupNodeExecution(child);
      }
    }

    this.applyConnections(namespace.connections, fullPath);

    return node;
  }

  public logGraphState() {
    for (const [path, node] of this.nodes) {
      console.log(`Node: ${path}`);
      console.log("  Inputs:");
      for (const [port, subject] of node.inputs) {
        console.log(`    ${port}: ${subject.value}`);
      }
      console.log(`  Output: ${node.output.value}`);
      console.log("---");
    }
  }

  private wouldCreateCircularDependency(
    fromNodePath: string,
    toNodePath: string
  ): boolean {
    // Allow connections within the same namespace
    if (
      fromNodePath.split(".").slice(0, -1).join(".") ===
      toNodePath.split(".").slice(0, -1).join(".")
    ) {
      return false;
    }

    const visited = new Set<string>();
    const dfs = (nodePath: string): boolean => {
      if (nodePath === fromNodePath) return true;
      if (visited.has(nodePath)) return false;
      visited.add(nodePath);

      const node = this.getNodeByPath(nodePath);
      if (node && node.inputs) {
        for (const [, inputObservable] of node.inputs) {
          for (const [path, otherNode] of this.nodes) {
            if (otherNode.output === inputObservable && dfs(path)) {
              return true;
            }
          }
        }
      }
      return false;
    };
    return dfs(toNodePath);
  }

  private applyConnections(
    connections: SerializedConnection[],
    prefix: string
  ) {
    for (const connection of connections) {
      console.log("Applying connection", connection);
      const fromNodePath = prefix + "." + connection.from;
      const toNodePath = prefix + "." + connection.to;
      const toNodePort = connection.port;

      const fromInput = this.getNodeByPath(prefix)?.inputs.get(connection.from);
      const fromNode = this.getNodeByPath(fromNodePath);
      const toNode = this.getNodeByPath(toNodePath);

      const source = fromNode?.output || fromInput;

      console.log("Connecting", fromNodePath, toNodePath, toNodePort);
      if (source && toNode) {
        if (this.wouldCreateCircularDependency(fromNodePath, toNodePath)) {
          throw new Error(
            `Circular dependency detected: ${fromNodePath} -> ${toNodePath}:${toNodePort}`
          );
        }

        const inputSubject = toNode.inputs.get(toNodePort);
        if (inputSubject) {
          source.subscribe((value) => {
            console.log(
              `Propagating value from ${fromNodePath} to ${toNodePath}:${toNodePort}`,
              value
            );
            inputSubject.next(value);
          });
        }
      } else {
        console.error(
          `Connection failed: ${fromNodePath} -> ${toNodePath}:${toNodePort}`
        );
      }
    }
  }

  private resolvePath(path: string): [string, string | null] {
    const parts = path.split(".");
    if (parts.length > 1 && this.nodes.has(parts.slice(0, -1).join("."))) {
      return [parts.slice(0, -1).join("."), parts[parts.length - 1]];
    }
    return [path, null];
  }

  private setupNodeExecution(node: ReactiveNode) {
    if (node.type === "process" || node.type === "output") {
      node.subscription?.unsubscribe();

      const inputObservables = Array.from(node.inputs.values());
      console.log("Setting up node execution for", node.id, [
        ...node.inputs.keys()
      ]);

      if (inputObservables.length === 0) {
        // For nodes with no inputs, execute immediately
        this.executeNode(node, {}).then((result) => {
          if (result !== null) {
            node.output.next(result);
          }
        });
      } else {
        node.subscription = combineLatest(inputObservables)
          .pipe(
            debounceTime(0),
            switchMap((inputValues) => {
              const inputObject = Object.fromEntries(
                Array.from(node.inputs.keys()).map((key, index) => [
                  key,
                  inputValues[index]
                ])
              );
              return from(this.executeNode(node, inputObject)).pipe(
                catchError((error) => {
                  console.error(`Error executing node ${node.id}:`, error);
                  return of(null);
                })
              );
            })
          )
          .subscribe((result) => {
            if (result !== null) {
              console.log(`Node ${node.id} emitted`, result);
              node.output.next(result);
            }
          });

        this.subscriptions.add(node.subscription);
      }
    }
  }

  private async executeNode(
    node: ReactiveNode,
    inputs: Record<string, any>
  ): Promise<any> {
    console.log(`Executing node ${node.id} with inputs`, inputs);
    switch (node.contentType) {
      case "javascript":
        const func = new Function(
          ...Object.keys(inputs),
          `return (${node.body})(...arguments)`
        );
        return await func(...Object.values(inputs));
      case "text":
      case "view":
        return node.body;
      default:
        throw new Error(`Unsupported content type: ${node.contentType}`);
    }
  }

  public getNodeOutput(path: string): Observable<any> | undefined {
    const node = this.getNodeByPath(path);
    return node?.output.asObservable();
  }

  public setNodeInput(path: string, port: string, value: any) {
    console.log(`Setting input ${port} of ${path} to`, value);
    const node = this.getNodeByPath(path);
    if (node && node.inputs.has(port)) {
      const inputSubject = node.inputs.get(port);
      if (inputSubject && !Object.is(inputSubject.value, value)) {
        console.log("Triggering update for", port, "of", path, "to", value);
        inputSubject.next(value);
      }
    }
  }
  private triggerDownstreamUpdates(node: ReactiveNode) {
    for (const [path, otherNode] of this.nodes) {
      for (const [, input] of otherNode.inputs) {
        if (input === node.output) {
          this.setupNodeExecution(otherNode);
          this.triggerDownstreamUpdates(otherNode);
        }
      }
    }
  }

  public extractSubtree(path: string): SerializedNamespaceNode {
    const node = this.getNodeByPath(path);
    if (!node || node.type !== "namespace") {
      throw new Error(`Invalid path or node is not a namespace: ${path}`);
    }

    const serializeNode = (
      node: ReactiveNode,
      currentPath: string
    ): SerializedNode | SerializedNamespaceNode => {
      const base = {
        id: node.id,
        type: node.type,
        ports: Array.from(node.inputs.entries()).map(([id, subject]) => ({
          id,
          contentType: "any", // You might want to store and retrieve the actual content type
          default: (subject as BehaviorSubject<any>).getValue()
        })),
        contentType: node.contentType
      };

      if (node.type === "namespace") {
        return {
          ...base,
          nodes: Array.from(node.children.values()).map((child) =>
            serializeNode(child, `${currentPath}.${child.id}`)
          ),
          connections: this.extractConnections(node, currentPath)
        } as SerializedNamespaceNode;
      } else {
        return {
          ...base,
          body: node.body
        } as SerializedNode;
      }
    };

    return serializeNode(node, path) as SerializedNamespaceNode;
  }

  private extractConnections(
    node: ReactiveNode,
    currentPath: string
  ): SerializedConnection[] {
    const connections: SerializedConnection[] = [];

    const addConnections = (node: ReactiveNode, nodePath: string) => {
      for (const [port, observable] of node.inputs.entries()) {
        for (const [otherNodePath, otherNode] of this.nodes.entries()) {
          if (otherNode.output === observable) {
            connections.push({
              from: otherNodePath.replace(`${currentPath}.`, ""),
              to: nodePath.replace(`${currentPath}.`, ""),
              port
            });
          }
        }
      }

      for (const [childId, childNode] of node.children.entries()) {
        addConnections(childNode, `${nodePath}.${childId}`);
      }
    };

    addConnections(node, currentPath);
    return connections;
  }

  private getNodeByPath(path: string): ReactiveNode | undefined {
    return this.nodes.get(path);
  }

  public dispose() {
    this.subscriptions.unsubscribe();
  }
}
