/// <cts-enable />
import { toSchema } from "commontools";

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

// 3) Intersection tests (deferred to CT-762 branch with intersection support)

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

export { schemaDoc, schemaPrecedence, schemaDerived, schemaDict, schemaCounts, schemaTags };


