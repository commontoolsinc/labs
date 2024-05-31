
export const STREAM = 'https://common.tools/stream-binding.schema.json'
export const CELL = 'https://common.tools/cell-binding.schema.json'

export function createElement(node, context) {
  if (typeof node === 'string') {
    const textNode = document.createTextNode(node);
    return textNode;
  }

  if (!node || typeof node !== 'object') return null;

  // repeat node
  if (!node.tag && node.type == 'repeat') {
    const container = document.createElement('div');
    const items = context[node.binding] || [];
    items.forEach(item => {
      container.appendChild(createElement(node.template, item));
    });
    return container
  }

  // element nodes
  const element = document.createElement(node.tag);

  // set attributes
  for (const [key, value] of Object.entries(node.props || {})) {
    if (typeof value === 'object' && value.type) {
      // Handle specific types and bind reactive sources from context
      if (value.type && value["$id"] && value["$id"] === CELL) {
        let name = value.name || key;
        if (!context[name]) continue;
        element[key] = context[name].getValue();
        context[name].subscribe(newValue => element[key] = newValue);
      } else {
        if (value.binding) {
          if (key === 'checked' || 'disabled' || 'hidden') {
            if (context[value.binding]) {
              element.setAttribute('checked', 'checked'); // Update the attribute
            } else {
              element.removeAttribute('checked'); // Remove the attribute if not checked
            }
          } else {
            element[key] = context[value.binding];
          }
        }
      }
    } else if (value["$id"] && value["$id"] === STREAM && value.name) {
      if (context[value.name]) {
        element.addEventListener(key, context[value.name]);
      }
    } else {
      element[key] = value;
    }
  }

  let children = node.children || [];
  if (!Array.isArray(children)) {
    children = [children];
  }

  // recursively create and append child elements
  children.forEach(childNode => {
    if (childNode.binding && childNode.type == 'string') {
      const node = document.createTextNode(context[childNode.binding])
      element.appendChild(node);
      return
    }

    const childElement = createElement(childNode, context);
    if (childElement) {
      element.appendChild(childElement);
    }
  });

  return element;
}
