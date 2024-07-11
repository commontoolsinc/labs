export const replaceWith = (node: Node, replacement: Node) => {
  const parentNode = node.parentNode;
  if (parentNode == null) {
    throw new TypeError("Cannot replace node. Node's parent node is null.");
  }
  parentNode.replaceChild(replacement, node);
};

export const insertAfter = (node: Node, newNode: Node) => {
  const parentNode = node.parentNode;
  if (parentNode == null) {
    throw new TypeError("Cannot insert after node. Node's parent node is null.");
  }
  parentNode.insertBefore(newNode, node.nextSibling);
}

export const replaceNextSiblingWith = (node: Node, replacement: Node) => {
  if (node.nextSibling == null) {
    const parentNode = node.parentNode;
    if (parentNode == null) {
      throw new TypeError("Cannot replace next sibling. Node's parent node is null.");
      return;
    }
    // No next sibling means we're at the end of the parent node
    // so we just append the replacement.
    parentNode.appendChild(replacement);
    return;
  }
  replaceWith(node.nextSibling, replacement);
};
