// Minimal version of DOMParser types to work in a recipe
// until we have a better solution
export interface DOMParser {
  parseFromString(string: string, type: DOMParserSupportedType): Document;
}
export type DOMParserSupportedType =
  | "application/xhtml+xml"
  | "application/xml"
  | "image/svg+xml"
  | "text/html"
  | "text/xml";

export declare var DOMParser: {
  prototype: DOMParser;
  new (): DOMParser;
};

export interface Document extends Node {}
export interface Element extends Node {}
export interface ChildNode extends Node {}
export interface ParentNode extends Node {}
export interface HTMLElement extends Node {}
export interface Node extends EventTarget {
  getAttribute(attr: string): string | null;
  querySelector(selector: string): Node | null;
  querySelectorAll(selector: string): Node[];
  getElementsByTagName(tag: string): Node[];
  /**
   * Returns the children.
   *
   * [MDN Reference](https://developer.mozilla.org/docs/Web/API/Node/childNodes)
   */
  readonly childNodes: ChildNode[];
  /**
   * Returns the first child.
   *
   * [MDN Reference](https://developer.mozilla.org/docs/Web/API/Node/firstChild)
   */
  readonly firstChild: ChildNode | null;
  /**
   * Returns the last child.
   *
   * [MDN Reference](https://developer.mozilla.org/docs/Web/API/Node/lastChild)
   */
  readonly lastChild: ChildNode | null;
  /**
   * Returns the next sibling.
   *
   * [MDN Reference](https://developer.mozilla.org/docs/Web/API/Node/nextSibling)
   */
  readonly nextSibling: ChildNode | null;
  /**
   * Returns a string appropriate for the type of node.
   *
   * [MDN Reference](https://developer.mozilla.org/docs/Web/API/Node/nodeName)
   */
  readonly nodeName: string;
  /**
   * Returns the type of node.
   *
   * [MDN Reference](https://developer.mozilla.org/docs/Web/API/Node/nodeType)
   */
  readonly nodeType: number;
  /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/Node/nodeValue) */
  nodeValue: string | null;
  /**
   * Returns the node document. Returns null for documents.
   *
   * [MDN Reference](https://developer.mozilla.org/docs/Web/API/Node/ownerDocument)
   */
  readonly ownerDocument: Document | null;

  /**
   * Returns the parent element.
   *
   * [MDN Reference](https://developer.mozilla.org/docs/Web/API/Node/parentElement)
   */
  readonly parentElement: HTMLElement | null;
  /**
   * Returns the parent.
   *
   * [MDN Reference](https://developer.mozilla.org/docs/Web/API/Node/parentNode)
   */
  readonly parentNode: ParentNode | null;
  /**
   * Returns the previous sibling.
   *
   * [MDN Reference](https://developer.mozilla.org/docs/Web/API/Node/previousSibling)
   */
  readonly previousSibling: ChildNode | null;
  /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/Node/textContent) */
  textContent: string | null;
  /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/Node/appendChild) */
  appendChild<T extends Node>(node: T): T;
  /**
   * Returns a copy of node. If deep is true, the copy also includes the node's descendants.
   *
   * [MDN Reference](https://developer.mozilla.org/docs/Web/API/Node/cloneNode)
   */
  cloneNode(subtree?: boolean): Node;
  /**
   * Returns a bitmask indicating the position of other relative to node.
   *
   * [MDN Reference](https://developer.mozilla.org/docs/Web/API/Node/compareDocumentPosition)
   */
  compareDocumentPosition(other: Node): number;
  /**
   * Returns true if other is an inclusive descendant of node, and false otherwise.
   *
   * [MDN Reference](https://developer.mozilla.org/docs/Web/API/Node/contains)
   */
  contains(other: Node | null): boolean;

  /**
   * Returns node's root.
   *
   * [MDN Reference](https://developer.mozilla.org/docs/Web/API/Node/getRootNode)
   */
  getRootNode(options?: GetRootNodeOptions): Node;
  /**
   * Returns whether node has children.
   *
   * [MDN Reference](https://developer.mozilla.org/docs/Web/API/Node/hasChildNodes)
   */
  hasChildNodes(): boolean;
  /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/Node/insertBefore) */
  insertBefore<T extends Node>(node: T, child: Node | null): T;
  /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/Node/isDefaultNamespace) */
  isDefaultNamespace(namespace: string | null): boolean;
  /**
   * Returns whether node and otherNode have the same properties.
   *
   * [MDN Reference](https://developer.mozilla.org/docs/Web/API/Node/isEqualNode)
   */
  isEqualNode(otherNode: Node | null): boolean;
  /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/Node/isSameNode) */
  isSameNode(otherNode: Node | null): boolean;
  /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/Node/lookupNamespaceURI) */
  lookupNamespaceURI(prefix: string | null): string | null;
  /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/Node/lookupPrefix) */
  lookupPrefix(namespace: string | null): string | null;
  /**
   * Removes empty exclusive Text nodes and concatenates the data of remaining contiguous exclusive Text nodes into the first of their nodes.
   *
   * [MDN Reference](https://developer.mozilla.org/docs/Web/API/Node/normalize)
   */

  normalize(): void;
  /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/Node/removeChild) */
  removeChild<T extends Node>(child: T): T;
  /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/Node/replaceChild) */
  replaceChild<T extends Node>(node: Node, child: T): T;
  /** node is an element. */
  readonly ELEMENT_NODE: 1;
  readonly ATTRIBUTE_NODE: 2;
  /** node is a Text node. */
  readonly TEXT_NODE: 3;
  /** node is a CDATASection node. */
  readonly CDATA_SECTION_NODE: 4;
  readonly ENTITY_REFERENCE_NODE: 5;
  readonly ENTITY_NODE: 6;
  /** node is a ProcessingInstruction node. */
  readonly PROCESSING_INSTRUCTION_NODE: 7;
  /** node is a Comment node. */
  readonly COMMENT_NODE: 8;
  /** node is a document. */
  readonly DOCUMENT_NODE: 9;
  /** node is a doctype. */
  readonly DOCUMENT_TYPE_NODE: 10;
  /** node is a DocumentFragment node. */
  readonly DOCUMENT_FRAGMENT_NODE: 11;
  readonly NOTATION_NODE: 12;
  /** Set when node and other are not in the same tree. */
  readonly DOCUMENT_POSITION_DISCONNECTED: 0x01;
  /** Set when other is preceding node. */
  readonly DOCUMENT_POSITION_PRECEDING: 0x02;
  /** Set when other is following node. */
  readonly DOCUMENT_POSITION_FOLLOWING: 0x04;
  /** Set when other is an ancestor of node. */
  readonly DOCUMENT_POSITION_CONTAINS: 0x08;
  /** Set when other is a descendant of node. */
  readonly DOCUMENT_POSITION_CONTAINED_BY: 0x10;
  readonly DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC: 0x20;
}

interface GetRootNodeOptions {
  composed?: boolean;
}
