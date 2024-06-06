export type Recipe = RecipeNode[]
export type NodePath = [string, string]
export type InputMap = { [port: string]: NodePath };

export type RecipeNode = {
  id: string, // an actual unique ID
  messages?: Message[], // could be empty if a user hand-authored the node etc.
  contentType: string,
  outputType: any,
  in: InputMap,
  body: string | object
};

export type Message = {
  role: 'user' | 'assistant',
  content: string,
}

export const emptyGraph: Recipe = [];
export const todoAppMockup: Recipe = [
  {
    "id": "todos",
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
    "contentType": "text/javascript",
    "in": {},
    "outputType": {
      "$id": "https://common.tools/stream.schema.json",
      "type": {
        "$id": "https://common.tools/todos.json"
      }
    },
    "body": "return system.get('todos')"
  },
  {
    "id": "todoUi",
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
    "contentType": "application/json+vnd.common.ui",
    "in": {
      "todos": [".", "todos"]
    },
    "outputType": {
      "$id": "https://common.tools/ui.schema.json"
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
]
