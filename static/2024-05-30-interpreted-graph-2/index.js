import { BehaviorSubject, combineLatest } from 'https://cdn.jsdelivr.net/npm/rxjs@7.8.1/+esm';

// Example usage with a simplified system.get function
const system = {
  get: (key) => {
    if (key === 'todos') {
      return [
        { label: 'Buy groceries', checked: false },
        { label: 'Vacuum house', checked: true },
        { label: 'Learn RxJS', checked: false }
      ];
    }
    return [];
  }
};

// Function to create the RxJS network from the new JSON graph format
function createRxJSNetworkFromJson(graph) {
  const context = {};

  // Create subjects for each node
  graph.nodes.forEach(node => {
    const nodeName = node.definition.name;
    context[nodeName] = {};
    context[nodeName]['out'] = new BehaviorSubject(null);

    // foreach input in the signature, create a subject
    if (node.definition.signature) {
      const { inputs } = node.definition.signature;
      for (const inputName in inputs) {
        context[nodeName][inputName] = new BehaviorSubject(null);
      }
    }
  });

  // Set up reactive bindings based on edges
  graph.edges.forEach(edge => {
    const [source, target] = Object.entries(edge)[0];
    const sourceSubject = context[source]['out'];
    const targetSubject = context[target[0]][target[1]];

    sourceSubject.subscribe(value => {
      targetSubject.next(value);
    });
  });

  // Process node definitions and set up reactive logic
  graph.nodes.forEach(node => {
    const nodeName = node.definition.name;
    const { contentType, body, signature } = node.definition;

    if (contentType === 'text/javascript') {
      // Evaluate the JavaScript content and bind it to the subject
      const func = new Function('system', body);
      const result = func(system, {
        get: (key) => context[key]['out'].getValue(),
        set: (key, value) => context[key]['out'].next(value)
      });
      context[nodeName]['out'].next(result);
    } else if (contentType === 'application/json+vnd.common.ui') {
      // Set up template rendering
      const { inputs } = signature;
      const inputObservables = [];

      for (const inputName in inputs) {
        if (context[inputName]) {
          inputObservables.push(context[inputName].out);
        }
      }

      combineLatest(inputObservables).subscribe(values => {
        const inputValues = values.reduce((acc, value, index) => {
          const key = Object.keys(inputs)[index];
          acc[key] = value;
          return acc;
        }, {});

        const renderedTemplate = renderTemplate(node.definition.body, inputValues);
        context[nodeName]['out'].next(renderedTemplate);
      });
    }
  });

  return context;
}

// Function to render the template based on the node body and input values
function renderTemplate(body, inputValues) {
  // Simplified rendering logic for demonstration
  if (body.type === 'repeat' && body.binding in inputValues) {
    return inputValues[body.binding].map(item => {
      return body.template.map(templateNode => {
        return `<${templateNode.tag} class="${body.props?.className}">${item.label}</${templateNode.tag}>`;
      }).join('');
    }).join('');
  } else {
    let children = body.children;
    if (!Array.isArray(body.children)) {
      children = [body.children];
    }

    return `<${body.tag} class="${body.props.className}">${children.map(c => renderTemplate(c, inputValues)).join('\n')}</${body.tag}>`;
  }
}

// Example JSON graph document
const jsonDocument = {
  "nodes": [
    {
      "id": "a",
      "messages": [
        {
          "role": "user",
          "content": "get my todos"
        },
        {
          "role": "assistant",
          "content": "..."
        }
      ],
      "definition": {
        "name": "todos",
        "contentType": "text/javascript",
        "signature": {
          "inputs": {},
          "output": {
            "$id": "https://common.tools/stream.schema.json",
            "type": {
              "$id": "https://common.tools/todos.json"
            }
          }
        },
        "body": "return system.get('todos')"
      }
    },
    {
      "id": "b",
      "messages": [
        {
          "role": "user",
          "content": "render todo"
        },
        {
          "role": "assistant",
          "content": "..."
        }
      ],
      "definition": {
        "name": "ui",
        "contentType": "application/json+vnd.common.ui",
        "signature": {
          "inputs": {
            "todos": {
              "$id": "https://common.tools/stream.schema.json",
              "type": {
                "$id": "https://common.tools/todos.json"
              }
            }
          },
          "output": {
            "$id": "https://common.tools/ui.schema.json"
          }
        },
        "body": {
          "tag": "todos",
          "props": {
            "className": "todo"
          },
          "children": {
            "type": "repeat",
            "binding": "todos",
            "template": [
              {
                "tag": "li",
                "props": {
                  "todo": {
                    "$id": "https://common.tools/cell.json",
                    "type": "todo"
                  }
                },
                "children": []
              }
            ]
          }
        }
      }
    }
  ],
  "edges": [
    { "todos": ["ui", "todos"] }
  ],
  "order": [
    "a",
    "b"
  ]
};

// Create the RxJS network
const context = createRxJSNetworkFromJson(jsonDocument);

// Example output for the UI component
context['ui'].out.subscribe(renderedTemplate => {
  console.log(renderedTemplate);
  document.getElementById('app').innerHTML = renderedTemplate;
});
