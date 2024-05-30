import { BehaviorSubject, Subject, combineLatest } from 'https://cdn.jsdelivr.net/npm/rxjs@7.8.1/+esm';

const STREAM = 'https://common.tools/stream-binding.schema.json'
const CELL = 'https://common.tools/cell-binding.schema.json'

function createElement(node, context) {
  if (typeof node === 'string') {
    const textNode = document.createTextNode(node);
    return textNode;
  }

  if (!node || typeof node !== 'object') return null;

  // Handle text nodes
  if (!node.tag && node.$id && node.name) {
    // Bind the reactive source to update the text node if it changes
    if (context[node.name] && context[node.name].subscribe) {
      if (node.type == 'slot') {
        const uiNode = createElement(context[node.name].getValue(), context)
        context[node.name].subscribe(newValue => {
          uiNode.innerHTML = '';
          uiNode.appendChild(createElement(newValue, context));
        });
        return uiNode;
      } else {
        const textNode = document.createTextNode(context[node.name] || '');
        context[node.name].subscribe(newValue => {
          textNode.textContent = newValue;
        });
        return textNode;
      }
    }
  }

  // Handle element nodes
  const element = document.createElement(node.tag);

  // Set properties
  for (const [key, value] of Object.entries(node.props || {})) {
    if (typeof value === 'object' && value.type) {
      // Handle specific types and bind reactive sources from context
      if (value.type && value["$id"] && value["$id"] === CELL) {
        let name = value.name || key;
        if (!context[name]) continue;
        element[key] = context[name].getValue();
        context[name].subscribe(newValue => element[key] = newValue);
      } else {
        // Fallback to setting attribute
        element.setAttribute(key, value.type);
      }
    } else if (value["$id"] && value["$id"] === STREAM && value.name) {
      // Handle event binding to a stream
      if (context[value.name]) {
        element.addEventListener(key, context[value.name]);
      }
    } else {
      element[key] = value;
    }
  }

  // Recursively create and append child elements
  (node.children || []).forEach(childNode => {
    const childElement = createElement(childNode, context);
    if (childElement) {
      element.appendChild(childElement);
    }
  });

  return element;
}

// Example usage
const uiTree = {
  "tag": "div",
  "props": {
    "style": "padding: 10px; border: 1px solid #ccc;"
  },
  "children": [
    {
      "tag": "input",
      "props": {
        "type": "text",
        "input": {
          "$id": "https://common.tools/stream-binding.schema.json",
          "name": "changes"
        },
        "value": {
          "$id": "https://common.tools/cell-binding.schema.json",
          "type": "string",
          "name": "label"
        }
      }
    },
    { "tag": "br" },
    {
      "tag": "label",
      "props": {},
      "children": [
        {
          "tag": "input",
          "props": {
            "type": "checkbox",
            "checked": {
              "$id": "https://common.tools/cell-binding.schema.json",
              "type": "boolean"
            },
            "click": {
              "$id": "https://common.tools/stream-binding.schema.json",
              "name": "clicks"
            }
          },
          "children": []
        },
        {
          "$id": "https://common.tools/cell-binding.schema.json",
          "type": "string",
          "name": "label"
        }
      ]
    },
    { "tag": "br" },
    {
      "$id": "https://common.tools/cell-binding.schema.json",
      "type": "slot",
      "name": "dynamic"
    },
    { "tag": "br" },
    {
      "$id": "https://common.tools/cell-binding.schema.json",
      "type": "slot",
      "name": "list"
    },
  ]
};


// output of a code node, tree held in a cell
function DynamicComponent(checked) {
  return {
    tag: "b",
    props: {},
    children: [
      {
        tag: "label",
        children: [
          checked ? "Yo!" : 'Nope!'
        ]
      },
      {
        tag: "button",
        props: {
          disabled: checked ? false : true,
          click: {
            "$id": "https://common.tools/stream-binding.schema.json",
            "name": "addItem"
          }
        },
        children: [
          "Click me!"
        ]
      }
    ]
  }
}

function List(items) {
  return {
    tag: "ul",
    props: {},
    children: items.map(item => {
      return {
        tag: "li",
        props: {},
        children: [
          item
        ]
      }
    })
  }
}

const items = new BehaviorSubject(['one'])
const label = new BehaviorSubject('Toggle')
const checked = new BehaviorSubject(false);
const dynamic = new BehaviorSubject(DynamicComponent(false));
const list = new BehaviorSubject(List(items.getValue()));

const context = {
  label,
  checked,
  dynamic,
  list,
  addItem: () => {
    items.next([...items.getValue(), label.getValue()]);
    list.next(List(items.getValue()));
  },
  clicks: () => {
    checked.next(!checked.getValue());
    dynamic.next(DynamicComponent(checked.getValue()));
  },
  changes: (event) => {
    label.next(event.target.value)
  }
};

// Object.values(context).forEach(cell => {
//   if (cell && cell.subscribe) {
//     cell.subscribe(() => {
//       debug();
//     })
//   }
// });

function debug() {
  document.querySelector('#tree').innerHTML = JSON.stringify(uiTree, null, 2);
  document.querySelector('#ctx').innerHTML = JSON.stringify(context, null, 2);
}

export function start() {
  debug();

  const todoElement = createElement(uiTree, context);
  document.querySelector('#app').appendChild(todoElement);
}
