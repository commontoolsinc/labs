export const examples = `
  Examples of tasks include:

  "Imagine some todos" ->

  func({
    "id": "todos",
    "code": "return [{ label: 'Water my plants', checked: false }, { label: 'Buy milk', checked: true }];"
  })

  Tasks that take no inputs require no edges.
  All function bodies must take zero parameters. Inputs can be accessed via 'read'.

  ---

  "Add a button to generate a random number"

  ui({
    "id": "generateRandom",
    "uiTree": {
      "tag": "button",
      "props": {
        "@click": { "@type": "binding", "name": "clicked" }
      },
      "children": [ "Click me" ]
    }
  })

  listen({
    "event": "clicked",
    "id": "generateRandom",
    "code": "return Math.random()"
  })

  ---

  "Take the existing todos and filter to unchecked"

  func({
    "id": "filteredTodos",
    "code": "const todos = input('todos');\nreturn todos.filter(todo => todo.checked);"
  })

  Tasks that filter other data must pipe the data through the edges.
  All function bodies must take zero parameters. Inputs can be accessed via 'input()', values may be null.

  ---

  "render each image by url" ->
  Imagine the output of a code node will be bound to the input named 'images'

  ui({
    "id": "imageUi",
    "uiTree": {
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
                "src": { "@type": 'binding', "name": 'src' },
              },
              "children": []
            }
          ],
        }
      ]
    }
  })

  ---

  "show some text" ->
  The output of a code node will be bound to the input named 'text'

  ui({
    "id": "dataUi",
    "uiTree": {
      "tag": "span",
      "props": { "innerText": { "@type": "binding", "name": "text" } },
      "children": [ ]
    }
  })

  ---

  "make a nametag with an editable name" ->
  (this is more complex and would ideally be broken down to more granular steps, but you can deal with this too)

  data({
    "id": "name",
    "data": ""
  })

  listen({
    "event": "onNameChanged",
    "id": "updateName",
    "code": "return input('value')"
  })

  ui({
    "id": "nameInputUi",
    "uiTree": {
      "tag": "input",
      "props": {
        "@change": { "@type": "binding", "name": "onNameChanged"}
      }
    }
  })

  connect({
    "from": "onNameChanged",
    "to": "name"
    "portName": "data"
  })

  connect({
    "from": "nameInputUi",
    "to": "onNameChanged"
    "portName": "target"
  })

  ---

  "render my todos" ->
  The output of a code node will be bound to the input named 'todos'

  ui({
    "id": "todoUi",
    "uiTree": {
      "tag": "ul",
      "props": {
        "className": "todo"
      },
      "children": [
        {
          "@type": "repeat",
          "name": "todos",
          "template": {
            "tag": "li",
            "props": {},
            "children": [
              {
                "tag": "input",
                "props": {
                  "type": "checkbox",
                  "checked": { "@type": "binding", "name": "checked" }
                },
                "children": []
              },
              {
                "tag": "span",
                "props": {
                  "className": "todo-label",
                  "innerText": { "@type": "binding", "name": "label" }
                },
                "children": [ ]
              }
            ]
          }
        }
      ]
    }
  })

  UI trees cannot use any javascript methods, code blocks must prepare the data for the UI to consume.
  Bindings for text nodes MUST be applied using the innerText prop.
  GLSL shaders cannot declare uniforms other than iTime, iResolution, iMouse and iChannel0 (the user's webcam).

  Make to check the connections and data flow through the entire graph at each step.
`;
