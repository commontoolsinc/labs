import {
  type Cancel,
  type CellHandle,
  isCellHandle,
  type Props,
  type RenderNode,
  UI,
  useCancelGroup,
  type VNode,
} from "@commontools/runtime-client";

import {
  cleanEventProp,
  createCyclePlaceholder,
  effect,
  hasVisitedCell,
  isEventProp,
  isVNodeish,
  listen,
  noop,
  sanitizeEvent,
  sanitizeNode,
  setPropDefault,
  type SetPropHandler,
  stringifyText,
  styleObjectToCssString,
} from "./render-utils.ts";
import { vdomSchema } from "@commontools/runner/schemas";
//import { animate } from "./debug-element.ts";

export interface RenderOptions {
  setProp?: SetPropHandler;
  document?: Document;
  rootCell?: CellHandle<VNode>;
}

type KeyedChildren = Map<string, VdomChildNode>;
type PropsValues =
  | string
  | number
  | boolean
  | object
  | any[]
  | CellHandle<any>
  | null;

export const render = (
  parent: HTMLElement,
  view: VNode | CellHandle<VNode>,
  options: RenderOptions = {},
): Cancel => {
  let rootCell: CellHandle<VNode> | undefined;

  if (isCellHandle(view)) {
    rootCell = view as CellHandle<VNode>;
    view = view.asSchema(vdomSchema) as CellHandle<VNode>;
  }

  const optionsWithCell = rootCell ? { ...options, rootCell } : options;

  return effect(view as VNode, (value: VNode | undefined) => {
    if (!value) {
      return;
    }
    const visited = new Set<object>();
    if (rootCell) {
      visited.add(rootCell);
    }
    return renderImpl(parent, value, optionsWithCell, visited);
  });
};

export const renderImpl = (
  parent: HTMLElement,
  view: VNode,
  options: RenderOptions = {},
  visited: Set<object> = new Set(),
): Cancel => {
  const [root, cancel] = renderNode(view, options, visited);
  if (!root) {
    return cancel;
  }
  parent.append(root);
  //animate(root, "created");
  return () => {
    root.remove();
    cancel();
  };
};

export default render;

function renderNode(
  inputNode: VNode,
  options: RenderOptions,
  visited: Set<object>,
): [HTMLElement | null, Cancel] {
  // Working with user data, it's still possible for this method
  // to be called with invalid data.
  if (!inputNode || typeof inputNode !== "object") {
    return [null, noop];
  }

  const doc = options.document ?? globalThis.document;
  const [cancel, addCancel] = useCancelGroup();

  const shouldWrapWithContext = inputNode[UI] && options.rootCell;
  const cellForContext = shouldWrapWithContext ? options.rootCell : undefined;

  let node = inputNode;
  // Follow [UI] chain
  while (node && node[UI]) {
    if (visited.has(node)) {
      return [createCyclePlaceholder(doc), cancel];
    }
    visited.add(node);
    node = node[UI];
  }

  if (isCellHandle(node)) {
    const wrapper = doc.createElement("ct-internal-fill-element");
    addCancel(
      effect(node as CellHandle<VNode>, (resolvedNode) => {
        wrapper.innerHTML = "";
        if (!resolvedNode) return;
        const [childElement, childCancel] = renderNode(
          resolvedNode,
          options,
          new Set(visited),
        );
        if (childElement) {
          wrapper.appendChild(childElement);
          //animate(childElement, "created");
        }
        return childCancel;
      }),
    );

    return [wrapper, cancel];
  }

  if (visited.has(node)) {
    return [createCyclePlaceholder(doc), cancel];
  }
  visited.add(node);

  const sanitizedNode = sanitizeNode(node);
  if (!sanitizedNode) {
    return [null, cancel];
  }

  const element = doc.createElement(sanitizedNode.name);

  addCancel(bindProps(element, sanitizedNode.props, options));

  if (sanitizedNode.children !== undefined) {
    addCancel(bindChildren(element, sanitizedNode.children, options, visited));
  }

  if (cellForContext && element) {
    const wrapper = doc.createElement("ct-cell-context") as HTMLElement & {
      cell?: CellHandle<VNode>;
    };
    wrapper.cell = cellForContext;
    wrapper.appendChild(element);
    return [wrapper, cancel];
  }

  return [element, cancel];
}

const bindChildren = (
  element: HTMLElement,
  children: RenderNode,
  options: RenderOptions = {},
  visited: Set<object> = new Set(),
): Cancel => {
  // Mapping from stable key to its rendered node and cancel function.
  let keyedChildren: KeyedChildren = new Map();

  // When the children array changes, diff its flattened values against what we previously rendered.
  const updateChildren = (
    childrenArr: RenderNode | RenderNode[] | undefined | null,
  ) => {
    const newChildren = Array.isArray(childrenArr)
      ? childrenArr.flat()
      : childrenArr
      ? [childrenArr]
      : [];
    const newKeyOrder: string[] = [];
    const newMapping: KeyedChildren = new Map();
    const occurrence = new Map<string, number>();

    for (let i = 0; i < newChildren.length; i++) {
      const child = newChildren[i];
      // Try JSON.stringify for stable keys, fall back to index for circular structures
      let rawKey: string;
      try {
        rawKey = JSON.stringify(child);
      } catch {
        // Circular structure or other JSON error - use index-based key
        rawKey = `__circular_${i}`;
      }
      const count = occurrence.get(rawKey) ?? 0;
      occurrence.set(rawKey, count + 1);
      // Composite key ensures that two structurally identical children get unique keys.
      const key = rawKey + "-" + count;
      newKeyOrder.push(key);
      if (keyedChildren.has(key)) {
        // Reuse an existing rendered node, but update it with the new child
        // in case the child contains different Cell references.
        const existingNode = keyedChildren.get(key)!;
        existingNode.update(child);
        newMapping.set(key, existingNode);
        keyedChildren.delete(key);
      } else {
        newMapping.set(
          key,
          new VdomChildNode(child, options, visited),
        );
      }
    }

    // Remove any obsolete nodes.
    for (const [_, node] of keyedChildren.entries()) {
      node.dispose();
    }

    // Now update the parent element so that its children appear in newKeyOrder.
    // We use element.childNodes directly (a live NodeList) instead of a static
    // snapshot, because insertBefore() mutates the DOM and a static array would
    // have stale references after the first move.
    for (let i = 0; i < newKeyOrder.length; i++) {
      const key = newKeyOrder[i];
      // element() always returns a valid ChildNode (real element or placeholder)
      const desiredNode = newMapping.get(key)!.element();
      // If there's no node at this position, or it's different, insert desiredNode there.
      if (element.childNodes[i] !== desiredNode) {
        // Using element.childNodes[i] (which may be undefined) is equivalent to
        // appending if there's no node at that index.
        element.insertBefore(desiredNode, element.childNodes[i] ?? null);
        //animate(element, "moved");
      }
    }

    keyedChildren = newMapping;
  };

  // Set up a reactive effect so that changes to the children array are diffed and applied.
  const cancelArrayEffect = effect<RenderNode>(
    children,
    (childrenVal) => updateChildren(childrenVal),
  );

  return () => {
    cancelArrayEffect();
    for (const node of keyedChildren.values()) {
      node.dispose();
    }
  };
};

class VdomChildNode {
  private cancel: Cancel | undefined;
  private _element: ChildNode | null = null;
  private document: Document;
  private options: RenderOptions;
  private visited: Set<object>;
  // Placeholder used when element hasn't been created yet (async CellHandle case)
  private _placeholder: ChildNode;

  constructor(
    child: RenderNode,
    options: RenderOptions = {},
    visited: Set<object> = new Set(),
  ) {
    this.document = options.document ?? globalThis.document;
    this.options = options;
    this.visited = visited;

    // Create a placeholder text node. This ensures element() always returns
    // something insertable, so the reorder loop can position it correctly. When
    // the real element is created (possibly async for CellHandle children), it
    // replaces this placeholder via replaceWith().
    this._placeholder = this.document.createTextNode("") as ChildNode;

    this.setupEffect(child);
  }

  private setupEffect(child: RenderNode) {
    // Check for cell cycle before setting up effect (using .equals() for comparison)
    if (isCellHandle(child) && hasVisitedCell(this.visited, child)) {
      const placeholder = createCyclePlaceholder(this.document);
      if (this._element) {
        this._element.replaceWith(placeholder);
      }
      this._element = placeholder;
      this.cancel = undefined;
      return;
    }
    this.cancel = effect<RenderNode>(child, this.onEffect);
  }

  /**
   * Update this node with a new child. This is called when the parent
   * re-renders and produces a new child value that matches this node's key.
   * We need to cancel the old subscription and set up a new one.
   */
  update(newChild: RenderNode) {
    // Cancel old effect/subscription
    if (this.cancel) {
      this.cancel();
      this.cancel = undefined;
    }

    // Set up new effect with the new child
    this.setupEffect(newChild);
  }

  onEffect = (childValue: RenderNode): Cancel | undefined => {
    let element;
    let cancel;
    if (isCellHandle(childValue)) {
      throw new Error("child node cell resolved to another cell.");
    } else if (Array.isArray(childValue)) {
      // Wrap array in synthetic VNode with display:contents so it's layout-invisible
      const [childElement, childCancel] = renderNode(
        {
          type: "vnode",
          name: "span",
          props: { style: "display:contents" },
          children: childValue,
        },
        this.options,
        new Set(this.visited),
      );
      element = childElement;
      cancel = childCancel;
    } else if (isVNodeish(childValue)) {
      // Create a fresh copy of visited for each effect invocation to avoid
      // false cycle detection when the same VNode structure is re-rendered.
      // This mirrors the behavior in renderNode when handling CellHandle nodes.
      const [childElement, childCancel] = renderNode(
        childValue,
        this.options,
        new Set(this.visited),
      );
      element = childElement;
      cancel = childCancel;
    } else {
      const text = stringifyText(childValue);
      element = this.document.createTextNode(text) as ChildNode;
    }

    if (this._element && element) {
      // Replace existing element with new element
      this._element.replaceWith(element);
    } else if (this._element) {
      // Remove existing element (new element is null/undefined)
      this._element.remove();
    } else if (element && this._placeholder.parentNode) {
      // First real element arriving - replace the placeholder
      this._placeholder.replaceWith(element);
    }
    this._element = element;
    return cancel;
  };

  element(): ChildNode {
    // Return the real element if available, otherwise the placeholder.
    // This ensures the reorder loop always has something to insert.
    return this._element ?? this._placeholder;
  }

  dispose() {
    if (this.cancel) this.cancel();
    if (this._element) this._element.remove();
    // Also remove placeholder if it's still in the DOM (e.g., async element never arrived)
    if (this._placeholder.parentNode) this._placeholder.remove();
  }
}

function bindProps(
  element: HTMLElement,
  props: Props | CellHandle<Props>,
  options: RenderOptions,
): Cancel {
  const [cancel, addCancel] = useCancelGroup();
  const setProp = options.setProp ?? setPropDefault;

  if (isCellHandle(props)) {
    addCancel(
      effect(
        props,
        (resolved) => bindProps(element, resolved as Props, options),
      ),
    );
    return cancel;
  }

  if (typeof props !== "object" || !props) {
    return cancel;
  }

  for (const [key, value] of Object.entries(props as Props)) {
    const setProperty = <T>(element: T, key: string, value: unknown) =>
      key === "style" && value && typeof value === "object"
        ? setProp(element, key, styleObjectToCssString(value))
        : setProp(element, key, value);

    if (!isCellHandle(value)) {
      setProperty(element, key, value);
      continue;
    }

    if (isEventProp(key)) {
      const eventName = cleanEventProp(key);
      if (eventName != null) {
        addCancel(
          listen(element, eventName, (event) => {
            value.send(sanitizeEvent(event));
          }),
        );
      }
    } else if (key.startsWith("$")) {
      setProperty(element, key.slice(1), value);
    } else {
      addCancel(effect(value, (replacement) => {
        setProperty(element, key, replacement);
      }));
    }
  }

  return cancel;
}
