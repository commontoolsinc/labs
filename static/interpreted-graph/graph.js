import { BehaviorSubject, combineLatest } from 'https://cdn.jsdelivr.net/npm/rxjs@7.8.1/+esm';
import Ajv from 'https://cdn.jsdelivr.net/npm/ajv@8.14.0/+esm'
import Mustache from 'https://cdn.jsdelivr.net/npm/mustache@4.2.0/+esm'

export function start() { }

function coerce(val) {
  if (val == 'true') return true;
  if (val == 'false') return false;
  if (!isNaN(val)) return parseFloat(val);
  return val;
}

// Function to create the RxJS network from JSON document
function createRxJSNetworkFromJson(jsonDocument) {
  const ajv = new Ajv();
  const cells = {};
  const validators = {};


  const system = {
    get: (key) => {
      if (key == 'todos') {
        return [
          { label: 'Buy groceries', checked: false },
          { label: 'Vacuum house', checked: true },
          { label: 'Learn RxJS', checked: false }
        ]
      }
    }
  };

  // Create subjects and validators for each cell
  jsonDocument.conversation.forEach(conversation => {
    conversation.messages.forEach(message => {
      if (message.role === 'assistant') {
        const cellName = message.name || generateUniqueId();

        cells[cellName] = new BehaviorSubject(null);

        // if (message.inputs) {

        //   for (const [key, schema] of Object.entries(message.inputs)) {
        //     const inputName = key;
        //     validators[inputName] = ajv.compile(message.input);
        //   }

        // if schema has not been compiled, compile it

        // }

        // // If there is an output schema, validate the output
        // if (message.output && message.output.schema) {
        //   validators[`${cellName}_output`] = ajv.compile(message.output.schema);
        // }
      }
    });
  });

  // Define a unique ID generator
  function generateUniqueId() {
    return '_' + Math.random().toString(36).substr(2, 9);
  }

  // Process messages and set up reactive bindings
  jsonDocument.conversation.forEach(conversation => {
    conversation.messages.forEach(message => {
      if (message.role === 'assistant') {
        const cellName = message.name || generateUniqueId();

        if (message.contentType === 'text/javascript') {
          // Evaluate the JavaScript content and bind it to the subject
          const func = new Function('system', ...message.content.args, message.content.body);
          const result = func(system, {
            get: (key) => cells[key].getValue(),
            set: (key, value) => cells[key].next(value)
          });

          // Validate the result against the output schema
          if (validators[`${cellName}_output`] && !validators[`${cellName}_output`](result)) {
            console.error(`Output validation failed for cell ${cellName}`, validators[`${cellName}_output`].errors);
          } else {
            cells[cellName].next(result);
          }
        } else if (message.contentType === 'text/vnd.common.template') {
          // Set up template rendering
          const { inputs } = message;
          const inputObservables = [];

          for (const [key, schema] of Object.entries(inputs)) {
            const inputName = key;
            if (cells[inputName]) {
              inputObservables.push(cells[inputName]);
            }
          }

          if (message.tag) {
            // register as web component
            customElements.define(message.tag, class extends HTMLElement {
              constructor() {
                super();
                this.attachShadow({ mode: 'open' });
              }

              connectedCallback() {
                const attrs = Object.fromEntries(Object.entries(this.attributes).map(([key, attr]) => ([attr.name, coerce(attr.value)])));

                attrs.alert = () => {
                  alert('clicked');
                };

                const renderedTemplate = Mustache.render(message.content, attrs);
                this.shadowRoot.innerHTML = renderedTemplate;
              }
            });
          } else {
            combineLatest(inputObservables).subscribe(values => {
              const inputValues = values.reduce((acc, value, index) => {
                const key = Object.keys(inputs)[index];
                acc[key] = value;
                return acc;
              }, {});

              const renderedTemplate = Mustache.render(message.content, inputValues);
              cells[cellName]?.next(renderedTemplate);
            });
          }
        }
      }
    });
  });

  return cells;
}

// Example JSON document
const jsonDocument = {
  "conversation": [
    {
      "id": "",
      "messages": [
        {
          "role": "user",
          "content": "Write a title"
        },
        {
          "role": "assistant",
          "contentType": "text/javascript",
          "name": "title",
          "inputs": {},
          "output": {
            "schema": {
              "type": "string",
            }
          },
          "content": {
            args: [],
            body: "return 'hello'"
          }
        }
      ]
    },
    {
      "id": "",
      "messages": [
        {
          "role": "user",
          "content": "Get my todos"
        },
        {
          "role": "assistant",
          "contentType": "text/javascript",
          "name": "todos",
          "inputs": {},
          "output": {
            "schema": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "label": {
                    "type": "string"
                  },
                  "checked": {
                    "type": "boolean",
                    "default": false
                  }
                },
                "required": ["label"]
              }
            }
          },
          "content": {
            args: [],
            body: "return system.get('todos')"
          }
        }
      ]
    },
    {
      "id": "",
      "messages": [
        {
          "role": "user",
          "content": "I would like a todo item component, e.g. <todo-item checked>vacuum house</todo-item>"
        },
        {
          "role": "assistant",
          "contentType": "text/vnd.common.template",
          "tag": "todo-item",
          "imports": {
            "label": "common:ui/label.component.json",
            "checkbox": "common:ui/checkbox.component.json"
          },
          "inputs": {
            "checked": {
              "type": "boolean",
              "default": false
            },
            "label": {
              "type": "string"
            }
          },
          "output": {
            "schema": {
              "type": "template"
            }
          },
          "content": "<label onclick={{alert}}><input type=checkbox {{#checked}}checked={{checked}}{{/checked}}> {{label}}</label>"
        }
      ]
    },
    {
      "id": "",
      "messages": [
        {
          "role": "user",
          "content": "Ok, now make a task list using that todo item."
        },
        {
          "role": "assistant",
          "contentType": "text/vnd.common.template",
          "name": "ui",
          "inputs": {
            "title": {
              "type": "string",
            },
            "todos": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "label": {
                    "type": "string"
                  },
                  "checked": {
                    "type": "boolean",
                    "default": false
                  }
                },
                "required": ["label"]
              },
              "default": []
            }
          },
          "output": {
            "schema": {
              "type": "template"
            }
          },
          "imports": {
            "task": "todo-item"
          },
          "content": "<h1>{{title}}</h1><ul>{{#todos}}<li><todo-item label={{label}} checked={{checked}}></todo-item></li>{{/todos}}</ul>"
        }
      ]
    }
  ]
};

// Create the RxJS network
const subjects = createRxJSNetworkFromJson(jsonDocument);

// Example usage: Adding a new todo item
// subjects['todos'].next([
//   { label: 'Buy groceries', checked: false },
//   { label: 'Vacuum house', checked: true },
//   { label: 'Learn RxJS', checked: false }
// ]);

// Example usage: Updating the title
subjects['title'].next('My Updated Task List');

console.log(subjects)

// subjects['ui'].subscribe(console.log);
subjects['todos'].subscribe(console.log);
subjects['ui'].subscribe(html => {
  document.getElementById('app').innerHTML = html;
});
