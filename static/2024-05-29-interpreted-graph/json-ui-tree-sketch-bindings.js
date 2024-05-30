const clicks = () => {
  return Signal(0)
}

const todoItem = {
  "tag": "div",
  "props": {},
  "children": [{
    "tag": "label",
    "props": {
      "label": {
        "type": "string"
      }
    },
    "children": [
      {
        "tag": "checkbox",
        "props": {
          "checked": {
            "type": "boolean"
          },
          "onclick": {
            "$id": "https://common.tools/stream-binding.schema.json",
            "name": "clicks"
          }
        },
        "children": []
      }
    ]
  }]
}

const tree = {
  "tag": "div",
  "props": {},
  "children": [
    {
      "tag": "h1",
      "props": {
        "text": "My Updated Task List"
      },
      "children": []
    },
    {
      "tag": "div",
      "props": {},
      "children": [
        [
          {
            "tag": "label",
            "props": {
              "label": "Buy groceries"
            },
            "children": [
              {
                "tag": "checkbox",
                "props": {
                  "checked": false,
                  "onclick": {
                    "$id": "https://common.tools/stream-binding.schema.json",
                    "name": "clicks"
                  }
                },
                "children": []
              }
            ]
          },
          {
            "tag": "label",
            "props": {
              "label": "Vacuum house"
            },
            "children": [
              {
                "tag": "checkbox",
                "props": {
                  "checked": true
                },
                "children": []
              }
            ]
          },
          {
            "tag": "label",
            "props": {
              "label": "Learn RxJS"
            },
            "children": [
              {
                "tag": "checkbox",
                "props": {
                  "checked": false
                },
                "children": []
              }
            ]
          }
        ]
      ]
    }
  ]
}
