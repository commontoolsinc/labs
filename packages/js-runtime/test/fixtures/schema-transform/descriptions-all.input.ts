/// <cts-enable />
import { toSchema, Cell, Stream, Default } from "commontools";

// 1) Nested: Child/Doc with property docs and root doc
interface ChildNode {
  /** The main text content of the child node */
  body: string;
  /** Children of the child node */
  children: any[];
  /** Attachments associated with the child node */
  attachments: any[];
}

/** Outliner document */
type Doc = {
  /** The main text content of the node */
  body: string;
  /** Child nodes of this node */
  children: ChildNode[];
  /** Attachments associated with this node */
  attachments: any[];
  /** Version of document */
  version: number;
};

const schemaDoc = toSchema<Doc>();

// 2) Precedence: explicit description overrides root JSDoc
/** Root docstring to be overridden */
interface HasDocs {
  /** Name of item */
  name: string;
}
const schemaPrecedence = toSchema<HasDocs>({ description: "Explicit description" });

// 3) Intersections: same vs conflicting property docs
interface A {
  /** Name doc */
  name: string;
}
interface B {
  /** Name doc */
  name: string;
  /** Age */
  age: number;
}
type AB = A & B;
const schemaAB = toSchema<AB>();

interface C {
  /** First name doc */
  name: string;
}
interface D {
  /** Second name doc */
  name: string;
}
type CD = C & D;
const schemaCD = toSchema<CD>();

// 4) Extends-based inheritance of docs
/** Base type */
interface Base {
  /** Base id */
  id: string;
}
/** Derived type */
interface Derived extends Base {
  /** Derived name */
  name: string;
}
const schemaDerived = toSchema<Derived>();

// 5) Index signature and Record-like
/** Map of values */
interface Dict {
  /** Description for arbitrary keys */
  [key: string]: number;
}
const schemaDict = toSchema<Dict>();

/** Record of counts */
type Counts = {
  /** per-key count */
  [k: string]: number;
};
const schemaCounts = toSchema<Counts>();

// 6) Root JSDoc with tags; property doc
/** Summary line
 *
 * Longer details here.
 * @deprecated Use NewType instead.
 * @example
 *   const x = 1;
 */
interface WithTags {
  /** A value */
  value: number;
}
const schemaTags = toSchema<WithTags>();


// 7) Wrappers on properties
interface WrappedProps {
  /** Titles in a cell */
  titles: Cell<string[]>;
  /** Count as stream */
  count: Stream<number>;
  /** Level with default */
  level: Default<number, 3>;
}
const schemaWrapped = toSchema<WrappedProps>();

// 8) Optional and undefined unions
interface OptionalProps {
  /** maybe label */
  label?: string;
  /** maybe flag */
  flag: boolean | undefined;
}
const schemaOptional = toSchema<OptionalProps>();

// 9) Root alias docs
/** Root alias doc */
interface BaseRoot {
  /** id */
  id: string;
}
type RootAlias = BaseRoot;
const schemaRootAlias = toSchema<RootAlias>();

// 10) Recursive with $ref
interface Tree {
  /** node name */
  name: string;
  /** Child nodes */
  children: Tree[];
}
const schemaTree = toSchema<Tree>();

// 11) Array property JSDoc applies to array, not items
interface ArrayDocProps {
  /** tags of the item */
  tags: string[];
}
const schemaArrayDoc = toSchema<ArrayDocProps>();

export { schemaDoc, schemaPrecedence, schemaDerived, schemaDict, schemaCounts, schemaTags, schemaWrapped, schemaOptional, schemaRootAlias, schemaTree, schemaArrayDoc };
