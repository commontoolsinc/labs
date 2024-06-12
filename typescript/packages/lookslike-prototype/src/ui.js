export const STREAM = "https://common.tools/stream-binding.schema.json";
export const CELL = "https://common.tools/cell-binding.schema.json";

function readValue(context, binding) {
  const path = binding.split(".");
  let value = context;
  if (path.length > 1) {
    for (let i = 0; i < path.length; i++) {
      value = value?.[path?.[i]];
    }
  } else {
    value = context?.[path?.[0]];
  }

  return value;
}

export function createElement(node, context) {
  if (typeof node === "string") {
    const textNode = document.createTextNode(node);
    return textNode;
  }

  if (!node || typeof node !== "object") return null;

  // repeat node
  if (!node.tag && node.type == "repeat") {
    const container = document.createElement("div");
    const items = readValue(context, node.binding) || [];
    items.forEach((item) => {
      container.appendChild(createElement(node.template, item));
    });
    return container;
  }

  // element nodes
  const element = document.createElement(node.tag);

  // set attributes
  for (const [key, value] of Object.entries(node.props || {})) {
    if (typeof value === "object" && value.type) {
      // Handle specific types and bind reactive sources from context
      if (value.type && value["$id"] && value["$id"] === CELL) {
        let name = value.name || key;
        if (!context[name]) continue;
        element[key] = context[name].get();
        effect([context[name]], (newValue) => {
          element[key] = newValue;
        });
      } else {
        if (value.binding) {
          if (key === "checked" || "disabled" || "hidden") {
            if (context[value.binding]) {
              element.setAttribute("checked", "checked"); // Update the attribute
            } else {
              element.removeAttribute("checked"); // Remove the attribute if not checked
            }
          } else {
            element[key] = context[value.binding];
          }
        } else {
          // the value is not in a subfield, context is the value
          element[key] = context;
        }
      }
    } else if (value["$id"] && value["$id"] === STREAM && value.name) {
      if (context[value.name]) {
        element.addEventListener(key, context[value.name]);
      }
    } else {
      if (key === "style") {
        Object.keys(value).forEach((style) => {
          element.style[style] = value[style];
        });
      }
      element[key] = value;
    }
  }

  let children = node.children || [];
  if (!Array.isArray(children)) {
    children = [children];
  }

  // recursively create and append child elements
  children.forEach((childNode) => {
    if (
      childNode.type === "string" ||
      typeof childNode === "text" ||
      typeof childNode === "number"
    ) {
      if (childNode.binding && typeof context === "object") {
        const value = readValue(context, childNode.binding);
        const node = document.createTextNode(value);
        element.appendChild(node);
        return;
      } else {
        const node = document.createTextNode(context);
        element.appendChild(node);
        return;
      }
    }

    const childElement = createElement(childNode, context);
    if (childElement) {
      element.appendChild(childElement);
    }
  });

  return element;
}
