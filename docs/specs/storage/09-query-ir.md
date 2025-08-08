# Query IR (Intermediate Representation)

## IR: Schema Automaton

Compile JSON Schema subset into a **directed acyclic IR** (allowing shared
subgraphs):

### NodeKinds

- **`TypeCheck(kind)`** — object, array, string, number, boolean, null
- **`Const(value)`**, **`Enum(set)`**, **`Range({min,max,exclusive})`**, etc.
- **`Props(required:Set<string>, props: Map<string, IR>, additional: AP)`**
  where `AP = Omit | False | True | Schema(IR)`
- **`Items(itemIR | TupleIR[])`**
- **`AllOf(IR[])`**
- **`AnyOf(IR[])`**
- **`Ref(name)`** — reference to a definition in `/definitions`
- **`True`**, **`False`**

### LinkFollow Rule

At **any** node where evaluation reaches a JSON value that is a link (by shape),
the evaluator may "jump" to `(id, path)` **without changing the IR state**; it
just decrements `linkBudget`.

### Sharing

Identical sub-schemas compile to **the same IR node** (hash-consing) so
different queries can share evaluation cache.

### Recursive Schemas

Support recursive schemas using `$ref` with definitions in `/definitions`:

```json
{
  "type": "object",
  "properties": {
    "value": { "type": "string" },
    "children": {
      "type": "array",
      "items": { "$ref": "#/definitions/Node" }
    }
  },
  "definitions": {
    "Node": {
      "type": "object",
      "properties": {
        "value": { "type": "string" },
        "children": {
          "type": "array",
          "items": { "$ref": "#/definitions/Node" }
        }
      }
    }
  }
}
```

- **Definition compilation**: Compile each definition in `/definitions` to an IR
  node
- **Reference resolution**: `$ref` nodes resolve to the corresponding definition
  IR
- **Cycle detection**: Track reference depth to prevent infinite recursion
- **Memoization**: References share the same memoization as their target
  definitions

## Core Data Structures

### Document Storage and Change Surface

- Store each document as a persistent tree with addressable **links**
  `(docId, path)` where `path` is an array of strings
- Mutations produce a **diff** as a set of changed links (added, removed,
  updated) plus **structural events** (property added/removed, array splice)
- Maintain a **reverse link index**:
  `incomingLinks: docId → Set<(srcDocId, srcPath)>`

### Evaluation Cache & Provenance

Think of evaluating `IR` at `(docId, path)` as a **function**:

```ts
type EvalKey = {
  ir: IRNodeId;
  doc: DocId;
  path: Path;
  budget: number;
  refDepth?: number; // Track reference depth for cycle detection
};

type EvalResult = {
  verdict: "Yes" | "No" | "MaybeExceededDepth";
  touches: Set<Link>;
  linkEdges: Set<LinkEdge>;
  deps: Set<EvalKey>;
};
```

- **Memo table**: `memo: Map<EvalKey, EvalResult>` (global, shared across
  queries)
- **Provenance Graph** (bipartite):
  - **EvalNodes** keyed by `EvalKey`
  - **DocLinks** keyed by `(docId, path)`
  - Edges:
    - `DocLink → EvalNode` when EvalNode read that link
    - `EvalNode → EvalNode` for recursive dependencies
    - `EvalNode → LinkEdge` and `LinkEdge → DocLink`

### Subscribers

- A subscription (query) is anchored at
  `RootEvalKey = (IR(schema), doc, path, budget)`
- We maintain:
  - `QueryTouchSet ⊆ DocLinks` (closed over link targets actually traversed)
  - `QueryEvalNodes ⊆ EvalNodes` (the slice of the provenance graph reachable
    from RootEvalKey)
- A **reverse index** from `DocLink → Set<QueryId>` and
  `EvalNode → Set<QueryId>` supports fast invalidation

### Three-Valued Logic

- **`Yes`**: sufficient evidence that schema matches at the node
- **`No`**: sufficient evidence that schema cannot match
- **`MaybeExceededDepth`**: result may change if we had more link budget; treat
  as **Yes**/**No** for notification

## Minimal Interfaces

```ts
type DocId = string;
type Path = string[];
type Link = { doc: DocId; path: Path };
type LinkEdge = { from: Link; to: Link };

interface Indexes {
  // Provenance
  docLinkToEvalNodes: Map<Link, Set<EvalKey>>;
  evalNodeDeps: Map<EvalKey, Set<EvalKey>>; // children
  evalNodeParents: Map<EvalKey, Set<EvalKey>>; // parents

  // Subscriptions
  evalNodeToQueries: Map<EvalKey, Set<string>>;
  docLinkToQueries: Map<Link, Set<string>>;

  // Links
  incomingLinks: Map<DocId, Set<Link>>;
}

function evaluate(key: EvalKey): EvalResult; // memoized, builds provenance
```
