export const todoAppMockup = {
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
          "tag": "ul",
          "props": {
            "className": "todo"
          },
          "children": {
            "type": "repeat",
            "binding": "todos",
            "template": {
              "tag": "li",
              "props": {},
              "children": [
                {
                  "tag": "input",
                  "props": {
                    "type": "checkbox",
                    "checked": { type: 'boolean', binding: 'checked' }
                  }
                },
                {
                  "tag": "span",
                  "props": {
                    "className": "todo-label"
                  },
                  "children": [
                    { type: 'string', binding: 'label' }
                  ]
                }
              ]
            }
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
