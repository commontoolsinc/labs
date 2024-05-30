import { BehaviorSubject, combineLatest } from 'https://cdn.jsdelivr.net/npm/rxjs@7.8.1/+esm';
import Ajv from 'https://cdn.jsdelivr.net/npm/ajv@8.14.0/+esm'
import Mustache from 'https://cdn.jsdelivr.net/npm/mustache@4.2.0/+esm'
import { render, html } from 'https://cdn.jsdelivr.net/npm/lit-html@3.1.3/+esm'

const tag = (name) => (props, ...children) => ({ name, props, children });
const VStack = tag('div');
const Checkbox = tag('checkbox');
const Label = tag('label');
const Heading = tag('h1');
const ForEach = (items, template) => {
  return items.map(template)
};
const TodoItem = ({ label, checked, onClick }) => Label({ label, onClick }, Checkbox({ checked }))

// next steps:
// 1. updating state and re-rendering via callbacks (implies using a different templating system)
// 2. bind in two phases, register names in context and then for each note, using "imports", we map those global names to local names

export function start() { }

function coerce(val) {
  if (val == 'true') return true;
  if (val == 'false') return false;
  if (!isNaN(val)) return parseFloat(val);
  return val;
}

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

// Function to create the RxJS network from JSON document
function createRxJSNetworkFromJson(jsonDocument) {
  const context = {};
  const validators = {};

  // Create subjects and validators for each cell
  jsonDocument.conversation.forEach(conversation => {
    conversation.messages.forEach(message => {
      if (message.role === 'assistant') {
        const cellName = message.name || generateUniqueId();
        context[cellName] = new BehaviorSubject(message.output.schema.default || null);
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
            get: (key) => context[key].getValue(),
            set: (key, value) => context[key].next(value)
          });

          // // Validate the result against the output schema
          // if (validators[`${cellName}_output`] && !validators[`${cellName}_output`](result)) {
          //   console.error(`Output validation failed for cell ${cellName}`, validators[`${cellName}_output`].errors);
          // } else {
          context[cellName].next(result);
          // }
        } else if (message.contentType === 'text/vnd.common.template') {
          // Set up template rendering
          const { inputs } = message;
          const inputObservables = [];

          for (const [key, schema] of Object.entries(inputs)) {
            const inputName = key;
            if (context[inputName]) {
              inputObservables.push(context[inputName]);
            }
          }

          combineLatest(inputObservables).subscribe(values => {
            const inputValues = values.reduce((acc, value, index) => {
              const key = Object.keys(inputs)[index];
              acc[key] = value;
              return acc;
            }, {});

            const renderedTemplate = (message.content(inputValues));
            context[cellName]?.next(renderedTemplate);
          });
        }
      }
    });
  });

  return context;
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
                "required": ["label"],
              },
              "default": []
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
          "imports": {
            "Label": "common:ui/label.component.json",
            "Checkbox": "common:ui/checkbox.component.json"
          },
          "content": ({ label, checked }) => Label({ label, test: 'test' }, Checkbox({ checked }))
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
          // use these to bind names in context, don't infer via the inputs
          "imports": {
            "todos": "todos",
            "title": "title",
            "VStack": "common:ui/vstack.component.json",
            "Header": "common:ui/label.component.json",
            "Checkbox": "common:ui/checkbox.component.json",
            "TodoItem": "todo-item"
          },
          "content": ({ title, todos }) =>
            VStack({},
              Heading({ text: title }),
              VStack({},
                ForEach(todos, TodoItem)
              )
            )
        }
      ]
    }
  ]
};

const calendar = {
  "conversation": [
    {
      "id": "",
      "messages": [
        {
          "role": "user",
          "content": "Get my calendar events"
        },
        {
          "role": "assistant",
          "contentType": "text/javascript",
          "name": "calendarEvents",
          "inputs": {},
          "output": {
            "schema": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "title": {
                    "type": "string"
                  },
                  "date": {
                    "type": "string",
                    "format": "date-time"
                  }
                },
                "required": ["title", "date"]
              }
            }
          },
          "content": {
            "args": [],
            "body": "return system.get('calendarEvents')"
          }
        }
      ]
    },
    {
      "id": "",
      "messages": [
        {
          "role": "user",
          "content": "I would like a calendar event item component, e.g. <calendar-event>Meeting with Bob - 2024-05-29T14:30:00Z</calendar-event>"
        },
        {
          "role": "assistant",
          "contentType": "text/vnd.common.template",
          "tag": "calendar-event",
          "inputs": {
            "title": {
              "type": "string"
            },
            "date": {
              "type": "string",
              "format": "date-time"
            }
          },
          "output": {
            "schema": {
              "type": "template"
            }
          },
          "content": "<div><strong>{{title}}</strong> - {{date}}</div>"
        }
      ]
    },
    {
      "id": "",
      "messages": [
        {
          "role": "user",
          "content": "Ok, now make a calendar list using that calendar event."
        },
        {
          "role": "assistant",
          "contentType": "text/vnd.common.template",
          "name": "ui",
          "inputs": {
            "events": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "title": {
                    "type": "string"
                  },
                  "date": {
                    "type": "string",
                    "format": "date-time"
                  }
                },
                "required": ["title", "date"]
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
            "event": "calendar-event"
          },
          "content": "<h1>{{title}}</h1><ul>{{#events}}<li><calendar-event title={{title}} date={{date}}></calendar-event></li>{{/events}}</ul>"
        }
      ]
    }
  ]
}

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

subjects['ui'].subscribe(console.log);
// subjects['calendarEvents'].subscribe(console.log);
subjects['ui'].subscribe(html => {
  document.getElementById('tree').innerHTML = JSON.stringify(html, null, 2);
});

window.subjects = subjects;
