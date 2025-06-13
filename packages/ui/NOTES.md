# 2024-06-10

```ts
addUiNode({
  "id": "imageUi",
  "node": {
    "in": {
      "images": [".", "images"]
    },
    "outputType": {
      "$id": "https://common.tools/ui.schema.json"
    },
  },
  "body": {
    "tag": "ul",
    "props": {
      "className": "image"
    },
    "children": [
      "type": "repeat",
      "binding": "images",
      "template": {
        "tag": "li",
        "props": {},
        "children": [
          {
            "tag": "img",
            "props": {
              "src": { type: 'string', binding: null },
            }
          }
        ],
      }
    ]
  }
})

addUiNode({
  "id": "todoUi",
  "node": {
    "in": {
      "todos": [".", "todos"]
    },
    "outputType": {
      "$id": "https://common.tools/ui.schema.json"
    },
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
})
```
