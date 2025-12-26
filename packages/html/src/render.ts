import {
  type Cancel,
  type CellHandle,
  effect,
  isCellHandle,
  isVNode,
  type Props,
  type RenderNode,
  serializeCellHandles,
  UI,
  useCancelGroup,
  type VNode,
} from "@commontools/runtime-client";

import {
  cleanEventProp,
  createCyclePlaceholder,
  isEventProp,
  isRenderableCell,
  listen,
  sanitizeEvent,
  sanitizeNode,
  setPropDefault,
  type SetPropHandler,
} from "./render-utils.ts";

export interface RenderOptions {
  setProp?: SetPropHandler;
  document?: Document;
  /** The root cell for auto-wrapping with ct-cell-context on [UI] traversal */
  rootCell?: CellHandle<VNode>;
}

/**
 * Renders a view into a parent element, supporting both static VNodes and reactive cells.
 * @param parent - The HTML element to render into
 * @param view - The VNode or reactive cell containing a VNode to render
 * @param options - Options for the renderer.
 * @returns A cancel function to clean up the rendering
 */
export const render = (
  parent: HTMLElement,
  view: VNode | CellHandle<VNode>,
  options: RenderOptions = {},
): Cancel => {
  let rootCell: CellHandle<VNode> | undefined;

  if (isCellHandle(view)) {
    rootCell = view as CellHandle<VNode>; // Capture the original cell for ct-cell-context wrapping
    // Don't apply vdomSchema to CellHandle - it causes the worker to return
    // cell references (SigilLinks) instead of actual values, which creates
    // infinite chains of CellHandles that need resolution.
  }

  // Pass rootCell through options if we have one
  const optionsWithCell = rootCell ? { ...options, rootCell } : options;

  return effect(
    view as VNode,
    (view: VNode) => {
      // Create a fresh visited set for each render pass.
      // This prevents false cycle detection when re-rendering with updated values.
      const visited = new Set<object>();
      if (rootCell) {
        visited.add(rootCell);
      }
      return renderImpl(parent, view, optionsWithCell, visited);
    },
  );
};

/**
 * Internal implementation that renders a VNode into a parent element.
 * @param parent - The HTML element to render into
 * @param view - The VNode to render
 * @param options - Options for the renderer.
 * @param visited - Set of visited cells/nodes for cycle detection
 * @returns A cancel function to remove the rendered content
 */
export const renderImpl = (
  parent: HTMLElement,
  view: VNode,
  options: RenderOptions = {},
  visited: Set<object> = new Set(),
): Cancel => {
  // If there is no valid vnode, don't render anything
  // Likely that content hasn't loaded yet
  if (view === undefined || !isVNode(view)) {
    return () => {};
  }
  const [root, cancel] = renderNode(view, options, visited);
  if (!root) {
    return cancel;
  }
  parent.append(root);
  return () => {
    root.remove();
    cancel();
  };
};

export default render;

/** Check if a cell has been visited, using .equals() for cell comparison */
const hasVisitedCell = (
  visited: Set<object>,
  cell: { equals(other: unknown): boolean },
): boolean => {
  for (const item of visited) {
    if (cell.equals(item)) {
      return true;
    }
  }
  return false;
};

const renderNode = (
  node: VNode,
  options: RenderOptions = {},
  visited: Set<object> = new Set(),
): [HTMLElement | null, Cancel] => {
  const document = options.document ?? globalThis.document;
  const [cancel, addCancel] = useCancelGroup();

  // Check if we should wrap with ct-cell-context (when traversing [UI] with a rootCell)
  const shouldWrapWithContext = node[UI] && options.rootCell;
  const cellForContext = shouldWrapWithContext ? options.rootCell : undefined;

  // Follow `[UI]` to actual vdom. Do this before otherwise parsing the vnode,
  // so that if there are both, the `[UI]` annotation takes precedence (avoids
  // accidental collision with the otherwise quite generic property names)
  while (node[UI]) {
    // Detect cycles in UI chain
    if (visited.has(node)) {
      return [
        createCyclePlaceholder(document),
        cancel,
      ];
    }
    visited.add(node);
    node = node[UI];
  }

  // Check if the final node creates a cycle (for child -> parent references)
  if (visited.has(node)) {
    return [
      createCyclePlaceholder(document),
      cancel,
    ];
  }
  visited.add(node);

  const sanitizedNode = sanitizeNode(node);
  if (!sanitizedNode) {
    return [null, cancel];
  }

  const element = document.createElement(
    sanitizedNode.name,
  );

  const cancelProps = bindProps(element, sanitizedNode.props, options);
  addCancel(cancelProps);

  if (sanitizedNode.children !== undefined) {
    const cancelChildren = bindChildren(
      element,
      sanitizedNode.children,
      options,
      visited,
    );
    addCancel(cancelChildren);
  }

  // Wrap with ct-cell-context if we traversed [UI] with a rootCell
  if (cellForContext && element) {
    const wrapper = document.createElement(
      "ct-cell-context",
    ) as HTMLElement & { cell?: CellHandle<VNode> };
    wrapper.cell = cellForContext;
    wrapper.appendChild(element);
    return [wrapper, cancel];
  }

  return [element, cancel];
};

const bindChildren = (
  element: HTMLElement,
  children: RenderNode,
  options: RenderOptions = {},
  visited: Set<object> = new Set(),
): Cancel => {
  // Mapping from stable key to its rendered node and cancel function.
  let keyedChildren = new Map<string, { node: ChildNode; cancel: Cancel }>();

  // Render a child that can be static or reactive. For reactive cells we update
  // the already-rendered node (using replaceWith) so that we never add an extra
  // container.
  const renderChild = (
    child: RenderNode,
    key: string,
  ): { node: ChildNode; cancel: Cancel } => {
    const document = options.document ?? globalThis.document;

    // Check for cell cycle before setting up effect
    if (
      isRenderableCell(child) &&
      hasVisitedCell(visited, child as unknown as CellHandle<unknown>)
    ) {
      return { node: createCyclePlaceholder(document), cancel: () => {} };
    }

    // Track if this child is a cell for the visited set
    const childIsCell = isRenderableCell(child);

    let currentNode: ChildNode | null = null;

    const cancel = effect(child, (childValue) => renderValue(childValue));

    function renderValue(value: RenderNode): Cancel | undefined {
      if (Array.isArray(value)) {
        const cancels = value.map((node) => renderValue(node));
        return () => cancels.forEach((c) => c && c());
      }
      if (isCellHandle(value)) {
        return effect(value, (resolved) => renderValue(resolved as RenderNode));
      }

      let newRendered: { node: ChildNode; cancel: Cancel };
      if (isVNode(value)) {
        // Create visited set for this child's subtree (cloned to avoid sibling interference)
        const childVisited = new Set(visited);
        if (childIsCell) {
          childVisited.add(child);
        }
        const [childElement, childCancel] = renderNode(
          value,
          options,
          childVisited,
        );
        newRendered = {
          node: childElement ?? document.createTextNode(""),
          cancel: childCancel ?? (() => {}),
        };
      } else {
        let textValue: string | number | boolean = value as
          | string
          | number
          | boolean;
        if (
          textValue === null || textValue === undefined ||
          textValue === false
        ) {
          textValue = "";
        } else if (typeof textValue === "object") {
          textValue = JSON.stringify(textValue);
        }
        newRendered = {
          node: document.createTextNode(textValue.toString()),
          cancel: () => {},
        };
      }

      if (currentNode) {
        // Replace the previous DOM node, if any
        currentNode.replaceWith(newRendered.node);
        // Update the mapping entry to capture any newly-rendered node.
        keyedChildren.set(key, {
          ...keyedChildren.get(key)!,
          node: newRendered.node,
        });
      }

      currentNode = newRendered.node;
      return newRendered.cancel;
    }

    return { node: currentNode!, cancel };
  };

  // When the children array changes, diff its flattened values against what we previously rendered.
  const updateChildren = (
    childrenArr: RenderNode | RenderNode[] | undefined | null,
  ) => {
    const newChildren = Array.isArray(childrenArr) ? childrenArr.flat() : [];
    const newKeyOrder: string[] = [];
    const newMapping = new Map<string, { node: ChildNode; cancel: Cancel }>();
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
        // Reuse an existing rendered node.
        newMapping.set(key, keyedChildren.get(key)!);
        keyedChildren.delete(key);
      } else {
        // Render a new child.
        newMapping.set(key, renderChild(child, key));
      }
    }

    // Remove any obsolete nodes.
    for (const [_, { node, cancel }] of keyedChildren.entries()) {
      cancel();
      node.remove();
    }

    // Now update the parent element so that its children appear in newKeyOrder.
    // We build an array of current DOM nodes to compare by index.
    const domNodes = Array.from(element.childNodes);
    for (let i = 0; i < newKeyOrder.length; i++) {
      const key = newKeyOrder[i];
      const desiredNode = newMapping.get(key)!.node;
      // If there's no node at this position, or it's different, insert desiredNode there.
      if (domNodes[i] !== desiredNode) {
        // Using domNodes[i] (which may be undefined) is equivalent to appending
        // if there's no node at that index.
        element.insertBefore(desiredNode, domNodes[i] ?? null);
      }
    }

    keyedChildren = newMapping;
  };

  // Set up a reactive effect so that changes to the children array are diffed and applied.
  const cancelArrayEffect = effect(
    children,
    (val) => updateChildren(val),
  );

  // Return a cancel function that tears down the effect and cleans up any rendered nodes.
  return () => {
    cancelArrayEffect();
    for (const { node, cancel } of keyedChildren.values()) {
      cancel();
      node.remove();
    }
  };
};

const bindProps = (
  element: HTMLElement,
  props: Props,
  options: RenderOptions,
): Cancel => {
  const setProperty = options.setProp ?? setPropDefault;
  const [cancel, addCancel] = useCancelGroup();
  for (const [propKey, propValue] of Object.entries(props)) {
    if (!isRenderableCell(propValue)) {
      setProperty(element, propKey, propValue);
      continue;
    }
    // If prop is an event, we need to add an event listener
    if (isEventProp(propKey)) {
      const key = cleanEventProp(propKey);
      if (key != null) {
        const cancel = listen(element, key, (event) => {
          const sanitizedEvent = serializeCellHandles(sanitizeEvent(event));
          propValue.send(sanitizedEvent);
        });
        addCancel(cancel);
      }
    } else if (propKey.startsWith("$")) {
      // Properties starting with $ get passed in as raw values, useful for
      // e.g. passing a cell itself instead of its value.
      const key = propKey.slice(1);
      setProperty(element, key, propValue);
    } else {
      const cancel = effect(propValue, (replacement) => {
        // Replacements are set as properties not attributes to avoid
        // string serialization of complex datatypes.
        setProperty(element, propKey, replacement);
      });
      addCancel(cancel);
    }
  }
  return cancel;
};
