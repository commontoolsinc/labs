import { Plugin } from "prosemirror-state";

export const editorClassPlugin = () =>
  new Plugin({
    view(editorView) {
      editorView.dom.classList.add("editor");

      return {
        destroy() {
          editorView.dom.classList.remove("editor");
        },
      };
    },
  });

export default editorClassPlugin;
