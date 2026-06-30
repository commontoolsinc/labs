/**
 * Shared data model for the `cf view` pager.
 *
 * The pipeline is: raw text -> {@link parseDocument} (TypeScript parser) ->
 * {@link Document} -> {@link renderFrame}. Everything downstream of the parser
 * operates on these structures, never on the TypeScript AST directly, which
 * keeps the renderer pure and testable.
 */

/**
 * Lexical/semantic classification of a contiguous run of source text. Drives
 * colour selection in {@link ../theme.ts}. Derived from the TypeScript token
 * kind, refined by the identifier's syntactic role in the AST.
 */
export type TokenClass =
  | "plain"
  | "whitespace"
  | "keyword"
  | "controlKeyword"
  | "storageKeyword" // const/let/var/function/type/interface/class
  | "operator"
  | "punctuation"
  | "bracket" // (){}[] — coloured by nesting depth, see `bracketDepth`
  | "string"
  | "template"
  | "number"
  | "boolean"
  | "regex"
  | "comment"
  | "docComment"
  | "sectionHeader" // `// transformed: <name>` divider lines
  | "typeName" // identifier used in a type position
  | "typeKeyword" // string/number/boolean/any/unknown… in a type position
  | "interfaceName"
  | "functionName" // identifier being declared as a function
  | "callName" // identifier in callee position of a call
  | "builderCall" // Common Fabric builder: pattern/lift/handler/computed…
  | "cfHelper" // synthetic __cfHelpers / __cfLift_N / __cfHardenFn…
  | "schemaKey" // property key inside a JSON-schema object literal
  | "propertyName" // ordinary object-literal / property-access key
  | "parameter"
  | "binding" // identifier being declared by const/let/var
  | "identifier"
  | "diffAdd" // the `+` marker of an added diff line
  | "diffDel" // the `-` marker of a removed diff line
  | "diffHunk" // a `@@ -a,b +c,d @@` hunk header
  | "diffMeta"; // diff metadata: `diff --git`, `index`, `---`, `+++`, …

/** A coloured run of text on a single logical (pre-wrap) source line. */
export interface Span {
  /** 0-based column where this span starts on its line. */
  readonly col: number;
  readonly text: string;
  readonly cls: TokenClass;
  /** Nesting depth for `bracket` spans, used for rainbow colouring. */
  readonly bracketDepth?: number;
}

/** One source line: the verbatim text plus its coloured spans. */
export interface Line {
  readonly text: string;
  readonly spans: readonly Span[];
  /** Full-row background tint for diff views (added/removed lines). */
  readonly bg?: "add" | "del";
}

/** Kinds of structural nodes surfaced in the navigation tree. */
export type StructureKind =
  | "section" // a `// transformed: <name>` file block
  | "import"
  | "function"
  | "closure" // arrow function / function expression
  | "pattern" // pattern(...) builder call
  | "builder" // other Common Fabric builder call (lift/handler/computed…)
  | "variable"
  | "schema" // object literal that is a JSON schema
  | "object"
  | "interface"
  | "typeAlias"
  | "class"
  | "method"
  | "export"
  | "return" // a `return …` statement
  | "control" // if/for/while/do/switch/try and similar control flow
  | "statement" // any other statement (throw, break, bare expression, …)
  | "node" // a generic AST node (expression, argument, identifier, …)
  | "comment" // a `//` or `/* */` comment
  | "hunk"; // a `@@ … @@` hunk in a diff view

/** A field of a JSON schema, summarised for display. */
export interface SchemaField {
  readonly name: string;
  /** Compact type, e.g. `string`, `string[]`, `object`, `boolean`. */
  readonly type: string;
  readonly required: boolean;
  /** Nested fields for object types / array-of-object item types. */
  readonly fields?: readonly SchemaField[];
}

/** A JSON schema (an object-literal `… satisfies JSONSchema`), summarised. */
export interface SchemaMeta {
  readonly rootType: string;
  readonly required: readonly string[];
  readonly fields: readonly SchemaField[];
}

/** A member of an interface / object type literal. */
export interface TypeMember {
  readonly name: string;
  readonly type: string;
  readonly optional: boolean;
}

/**
 * Structured, kind-specific information extracted from the AST while parsing, so
 * the Enter "info card" can surface a node's contract instead of re-showing its
 * source. Best-effort: absent when it cannot be derived.
 */
export type NodeMeta =
  | { readonly kind: "schema"; readonly schema: SchemaMeta }
  | {
    readonly kind: "contract";
    /** Builder family: `pattern`, `lift`, `handler`, `computed`, … */
    readonly builder: string;
    readonly synthetic: boolean;
    /** Callback parameters — the captured input cells, e.g. `{ token }`. */
    readonly captures: readonly string[];
    readonly input?: SchemaMeta;
    readonly output?: SchemaMeta;
    /** Keys of the returned object literal, when discernible. */
    readonly returns?: readonly string[];
    /** Explicit type arguments, e.g. `fetchData<{ connections: … }>`. */
    readonly typeArgs?: readonly string[];
    /** Keys of the non-schema object argument, e.g. fetchData's `{ url, … }`. */
    readonly args?: readonly string[];
    /** Names of builders/patterns called inside the body. */
    readonly innerBuilders: readonly string[];
  }
  | {
    readonly kind: "closure";
    readonly params: readonly string[];
    readonly returns?: readonly string[];
    /** Syntactic type signature, e.g. `(fn: Function)` or `({ x }) → boolean`,
     * present only when the source carries explicit parameter/return types. */
    readonly signature?: string;
  }
  | {
    readonly kind: "variable";
    readonly bindsTo: string;
    readonly typeText?: string;
  }
  | {
    readonly kind: "type";
    readonly form: "interface" | "alias";
    readonly members: readonly TypeMember[];
    /** For non-literal type aliases (unions, references), the type text. */
    readonly aliasText?: string;
  }
  | {
    readonly kind: "import";
    readonly names: readonly string[];
    readonly module: string;
  };

/**
 * A node in the structure tree. Line numbers are 0-based and inclusive. The
 * tree is built from the TypeScript AST so block boundaries match exactly what
 * the compiler sees.
 */
export interface StructureNode {
  readonly kind: StructureKind;
  /** Short human label, e.g. `pattern FetchPage` or `schema {token}`. */
  readonly label: string;
  /** Optional binding/identifier name, used for the definition index. */
  readonly name?: string;
  /** Char offset of the declared identifier (the `name`), for semantic queries
   * (type-at / definition-at). Absent when the node declares no single name. */
  readonly nameOffset?: number;
  readonly startLine: number;
  readonly endLine: number;
  /** 0-based column of the node start on `startLine`. */
  readonly startCol: number;
  /** 0-based column of the node end on `endLine`. */
  readonly endCol: number;
  /** Character offset of the node start, for definition peeks. */
  readonly startOffset: number;
  readonly endOffset: number;
  readonly depth: number;
  readonly children: StructureNode[];
  /** Structured, kind-specific detail for the info card (best-effort). */
  readonly meta?: NodeMeta;
  /** The TypeScript AST kind name(s) this node represents. More than one when
   * several nodes share the exact same source range and were merged into one
   * navigable node (e.g. an expression statement and the call it wraps). */
  readonly astKinds?: readonly string[];
}

/** A named declaration the user can peek (go-to-definition style). */
export interface Definition {
  readonly name: string;
  readonly kind: StructureKind;
  readonly startLine: number;
  readonly endLine: number;
  readonly startOffset: number;
  readonly endOffset: number;
}

/** Flatten a structure tree into its pre-order sequence — the linear order
 * that `flatStructure` holds and that navigation and search step through. */
export function flattenStructure(
  nodes: readonly StructureNode[],
): StructureNode[] {
  const out: StructureNode[] = [];
  const walk = (ns: readonly StructureNode[]) => {
    for (const n of ns) {
      out.push(n);
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

/** Fully parsed document handed to the renderer and pager. */
export interface Document {
  /** Verbatim source text exactly as piped in. */
  readonly text: string;
  readonly lines: readonly Line[];
  /** Root-level structure nodes (sections, or top-level statements). */
  readonly structure: readonly StructureNode[];
  /** Flattened, pre-order list of structure nodes for linear navigation. */
  readonly flatStructure: readonly StructureNode[];
  /** Map from identifier name to its declaration(s) for peek overlays. */
  readonly definitions: ReadonlyMap<string, Definition[]>;
}
