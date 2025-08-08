# Query System TypeScript Types

## Core Types

```ts
type DocId = string;
type Path = string[];
type SpaceDid = string;
type QueryId = string;
type IRNodeId = string;
type EvalKeyHash = string;

type Link = {
  doc: DocId;
  path: Path;
};

type LinkEdge = {
  from: Link;
  to: Link;
};

type Verdict = "Yes" | "No" | "MaybeExceededDepth";

type EvalKey = {
  ir: IRNodeId;
  doc: DocId;
  path: Path;
  budget: number;
  refDepth?: number; // Track reference depth for cycle detection
};

type EvalResult = {
  verdict: Verdict;
  touches: Set<Link>;
  linkEdges: Set<LinkEdge>;
  deps: Set<EvalKey>;
  sourceDocsToSync: Set<DocId>;
};
```

## IR Node Types

```ts
type IRNode =
  | TypeCheckNode
  | ConstNode
  | EnumNode
  | RangeNode
  | PropsNode
  | ItemsNode
  | AllOfNode
  | AnyOfNode
  | RefNode
  | TrueNode
  | FalseNode;

type TypeCheckNode = {
  kind: "TypeCheck";
  type: "object" | "array" | "string" | "number" | "boolean" | "null";
};

type ConstNode = {
  kind: "Const";
  value: any;
};

type EnumNode = {
  kind: "Enum";
  values: Set<any>;
};

type RangeNode = {
  kind: "Range";
  min?: number;
  max?: number;
  exclusiveMin?: boolean;
  exclusiveMax?: boolean;
};

type PropsNode = {
  kind: "Props";
  required: Set<string>;
  properties: Map<string, IRNodeId>;
  additionalProperties: AdditionalProperties;
};

type AdditionalProperties =
  | { kind: "Omit" }
  | { kind: "False" }
  | { kind: "True" }
  | { kind: "Schema"; schema: IRNodeId };

type ItemsNode = {
  kind: "Items";
  items: IRNodeId | IRNodeId[]; // single schema or tuple
};

type AllOfNode = {
  kind: "AllOf";
  schemas: IRNodeId[];
};

type AnyOfNode = {
  kind: "AnyOf";
  schemas: IRNodeId[];
};

type RefNode = {
  kind: "Ref";
  name: string; // Definition name from /definitions
};

type TrueNode = {
  kind: "True";
};

type FalseNode = {
  kind: "False";
};
```

## Query Types

```ts
type QuerySubscription = {
  queryId: QueryId;
  spaceDid: SpaceDid;
  docId: DocId;
  path: JsonPtr;
  schema: any; // JSON Schema object
  maxLinkDepth: number;
  createdAt: string;
  lastEvaluatedAt?: string;
  rootVerdict?: Verdict;
};

type QueryNotification = {
  queryId: QueryId;
  epoch: number;
  txHash: string;
  reason:
    | "root-verdict-changed"
    | "touch-set-expanded"
    | "touch-set-shrunk"
    | "touched-doc-updated";
  docsToRefresh: DocId[];
  sourceDocsToSync: DocId[];
  summary: {
    oldVerdict?: Verdict;
    newVerdict?: Verdict;
    deltaTouched: {
      added: Link[];
      removed: Link[];
    };
  };
};
```

## WebSocket Message Types

```ts
// Client → Server
type ClientMessage =
  | HelloMessage
  | SubscribeMessage
  | UnsubscribeMessage
  | AckMessage;

type HelloMessage = {
  op: "hello";
  protocol: "v1";
  clientId: string;
};

type SubscribeMessage = {
  op: "subscribe";
  queryId: QueryId;
  spaceDid: SpaceDid;
  docId: DocId;
  path: Path;
  schema: any;
  maxLinkDepth?: number;
};

type UnsubscribeMessage = {
  op: "unsubscribe";
  queryId: QueryId;
};

type AckMessage = {
  op: "ack";
  queryId: QueryId;
  epoch: number;
};

// Server → Client
type ServerMessage =
  | HelloResponse
  | SubscribedMessage
  | QueryUpdateMessage
  | IdleMessage
  | ErrorMessage;

type HelloResponse = {
  op: "hello";
  serverId: string;
};

type SubscribedMessage = {
  op: "subscribed";
  queryId: QueryId;
  catchingUp: boolean;
};

type QueryUpdateMessage = {
  op: "query-update";
  queryId: QueryId;
  epoch: number;
  txHash: string;
  reason: QueryNotification["reason"];
  docsToRefresh: DocId[];
  sourceDocsToSync: DocId[];
  summary: QueryNotification["summary"];
};

type IdleMessage = {
  op: "idle";
  queryId: QueryId;
};

type ErrorMessage = {
  op: "error";
  code: string;
  details: any;
};
```

## Index Types

```ts
interface QueryIndexes {
  // Provenance
  docLinkToEvalNodes: Map<Link, Set<EvalKey>>;
  evalNodeDeps: Map<EvalKey, Set<EvalKey>>; // children
  evalNodeParents: Map<EvalKey, Set<EvalKey>>; // parents

  // Subscriptions
  evalNodeToQueries: Map<EvalKey, Set<QueryId>>;
  docLinkToQueries: Map<Link, Set<QueryId>>;

  // Links
  incomingLinks: Map<DocId, Set<Link>>;
}
```

## Function Signatures

```ts
// Core evaluation function
function evaluate(key: EvalKey): EvalResult;

// Schema compilation
function compileSchema(schema: any): IRNodeId;
function compileSchemaDefinitions(
  definitions: Record<string, any>,
): Map<string, IRNodeId>;

// Query management
function subscribeQuery(
  query: Omit<QuerySubscription, "queryId" | "createdAt">,
): QueryId;
function unsubscribeQuery(queryId: QueryId): void;

// Change processing
function onDocumentChange(
  docId: DocId,
  delta: DocumentDelta,
): QueryNotification[];

// Link management
function updateIncomingLinks(linkChanges: LinkChange[]): void;

// GC and maintenance
function garbageCollect(): void;
function cleanupOldNotifications(): void;
```
