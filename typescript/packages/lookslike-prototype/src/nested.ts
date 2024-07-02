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

export type Graph = {
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
  | Graph;

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

type NodeType = "variable" | "function" | "render" | "scope";

interface INode {
  id: string;
  type: NodeType;
  setup(): void;
  dispose(): void;
}

class Variable implements INode {
  private valueSubject: BehaviorSubject<any>;

  constructor(
    public id: string,
    public type: "variable",
    private defaultValue: any
  ) {
    this.valueSubject = new BehaviorSubject(defaultValue);
  }

  setup() {}

  dispose() {
    this.valueSubject.complete();
  }

  getValue(): Observable<any> {
    return this.valueSubject.asObservable();
  }

  setValue(value: any) {
    this.valueSubject.next(value);
  }
}

class FunctionNode implements INode {
  private inputSubjects: Map<string, Subject<any>> = new Map();
  private outputSubject: Subject<any> = new Subject();
  private subscription: Subscription | null = null;

  constructor(
    public id: string,
    public type: "function",
    private inputs: { [port: string]: any },
    private body: string
  ) {
    for (const port of Object.keys(inputs)) {
      this.inputSubjects.set(port, new Subject());
    }
  }

  setup() {
    const func = new Function(
      ...Object.keys(this.inputs),
      `return ((${this.body})(...arguments))`
    );
    const b = this.body;
    const inputObservables = Array.from(this.inputSubjects.values());

    if (this.subscription) {
      this.subscription.unsubscribe();
    }

    this.subscription = combineLatest(inputObservables).subscribe(
      (inputValues) => {
        console.log("Function input values:", inputValues, b);
        const result = func(...inputValues);
        this.outputSubject.next(result);
      }
    );
  }

  dispose() {
    this.inputSubjects.forEach((subject) => subject.complete());
    this.outputSubject.complete();
  }

  getInput(port: string): Subject<any> {
    return this.inputSubjects.get(port)!;
  }

  getOutput(): Observable<any> {
    return this.outputSubject.asObservable();
  }
}

class RenderNode implements INode {
  private sourceSubject: Subject<any> = new Subject();
  private outputSubject: Subject<any> = new Subject();
  private subscription: Subscription | null = null;

  constructor(
    public id: string,
    public type: "render",
    private contentType: string
  ) {}

  setup() {
    if (this.subscription) {
      this.subscription.unsubscribe();
    }

    this.subscription = this.sourceSubject.subscribe((content) => {
      // In a real implementation, this would render the content
      console.log(`Rendering ${this.contentType} content:`, content);
      this.outputSubject.next(content);
    });
  }

  dispose() {
    this.sourceSubject.complete();
    this.outputSubject.complete();
  }

  setSource(source: Observable<any>) {
    source.subscribe(this.sourceSubject);
  }

  getOutput(): Observable<any> {
    return this.outputSubject.asObservable();
  }
}

class Scope implements INode {
  nodes: Map<string, INode> = new Map();
  connections: Array<{ from: string; to: string; port?: string }> = [];

  constructor(
    public id: string,
    public type: "scope"
  ) {}

  setup() {
    this.nodes.forEach((node) => node.setup());
  }

  dispose() {
    this.nodes.forEach((node) => node.dispose());
  }

  addNode(node: INode) {
    this.nodes.set(node.id, node);
  }

  removeNode(id: string) {
    const node = this.nodes.get(id);
    if (node) {
      node.dispose();
      this.nodes.delete(id);
    }
  }

  addConnection(from: string, to: string, port?: string) {
    this.connections.push({ from, to, port });
  }

  removeConnection(from: string, to: string, port?: string) {
    this.connections = this.connections.filter(
      (conn) => !(conn.from === from && conn.to === to && conn.port === port)
    );
  }

  getNode(id: string): INode | undefined {
    return this.nodes.get(id);
  }

  getConnections() {
    return this.connections;
  }
}

export class GraphRuntime {
  private rootScope: Scope;
  private nodeValues: Map<string, any> = new Map();

  constructor(private graph: any) {
    this.rootScope = this.createScope(graph);
  }

  private createNode(nodeData: any): INode {
    switch (nodeData.type) {
      case "variable":
        return new Variable(nodeData.id, nodeData.type, nodeData.default);
      case "function":
        return new FunctionNode(
          nodeData.id,
          nodeData.type,
          nodeData.inputs,
          nodeData.body
        );
      case "render":
        return new RenderNode(nodeData.id, nodeData.type, nodeData.contentType);
      case "scope":
        return this.createScope(nodeData);
      default:
        throw new Error(`Unknown node type: ${nodeData.type}`);
    }
  }

  private createScope(scopeData: any): Scope {
    const scope = new Scope(scopeData.id, "scope");

    scopeData.nodes.forEach((nodeData: any) => {
      const node = this.createNode(nodeData);
      scope.addNode(node);
    });

    scopeData.connections.forEach((conn: any) => {
      if (conn.toNode) {
        scope.addConnection(conn.bind, conn.toNode.node, conn.toNode.port);
      } else if (conn.toVariable) {
        scope.addConnection(conn.bind, conn.toVariable);
      }
    });

    return scope;
  }

  private setupConnections(scope: Scope) {
    const sub = new Subscription();
    scope.getConnections().forEach(({ from, to, port }) => {
      const fromNode = this.resolveNodePath(scope, from);
      const toNode = this.resolveNodePath(scope, to);

      console.log("connecting", from, to, port);
      if (fromNode instanceof Variable) {
        if (toNode instanceof FunctionNode && port) {
          sub.add(
            fromNode
              .getValue()
              .pipe(tap((x) => console.log(from, "variable changed", x)))
              .subscribe(toNode.getInput(port))
          );
        } else if (toNode instanceof Variable) {
          sub.add(fromNode.getValue().subscribe(toNode.setValue.bind(toNode)));
        }
      } else if (fromNode instanceof FunctionNode) {
        if (toNode instanceof FunctionNode && port) {
          sub.add(fromNode.getOutput().subscribe(toNode.getInput(port)));
        } else if (toNode instanceof Variable) {
          sub.add(fromNode.getOutput().subscribe(toNode.setValue.bind(toNode)));
        } else if (toNode instanceof RenderNode) {
          sub.add(toNode.setSource(fromNode.getOutput()));
        }
      }
    });

    scope.nodes.forEach((node) => {
      if (node instanceof Scope) {
        this.setupConnections(node);
      }
    });
  }

  private resolveNodePath(scope: Scope, path: string): INode {
    const parts = path.split(".");
    console.log("resolving", path, parts);
    let currentScope: Scope = scope;
    for (let i = 0; i < parts.length - 1; i++) {
      const node = currentScope.getNode(parts[i]);
      if (node instanceof Scope) {
        console.log("entered scope", parts[i]);
        currentScope = node;
      } else {
        throw new Error(`Invalid path: ${path}`);
      }
    }

    const leaf = parts[parts.length - 1];
    const node = currentScope.getNode(leaf);
    console.log(currentScope.id, leaf);
    if (!node) {
      throw new Error(`Node not found: '${leaf}' in ${currentScope.id}`);
    }
    return node;
  }

  execute() {
    this.rootScope.setup();
    this.setupConnections(this.rootScope);
  }

  setValue(nodeId: string, value: any) {
    const node = this.resolveNodePath(this.rootScope, nodeId);
    if (node instanceof Variable) {
      node.setValue(value);
    } else {
      throw new Error(`Cannot set value for non-variable node: ${nodeId}`);
    }
  }

  subscribeToNode(nodeId: string): Observable<any> {
    const node = this.resolveNodePath(this.rootScope, nodeId);
    if (node instanceof Variable) {
      return node.getValue();
    } else if (node instanceof FunctionNode || node instanceof RenderNode) {
      return node.getOutput();
    }
    throw new Error(`Cannot subscribe to node ${nodeId}`);
  }

  updateGraph(newGraph: any) {
    // Implement graph diffing and updating logic here
    // This would involve comparing the old and new graph structures,
    // adding/removing nodes and connections as necessary
    // After updating, call setupConnections again
    throw new Error("Graph updating not implemented yet");
  }
}
