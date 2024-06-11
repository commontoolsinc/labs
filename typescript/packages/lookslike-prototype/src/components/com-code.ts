import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { EditorView, basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";

@customElement("com-code")
class CodeMirrorCodeViewer extends LitElement {
  @property({ type: String }) code = "";

  firstUpdated() {
    const editorContainer = this.shadowRoot?.getElementById("editor");
    if (editorContainer) {
      const updateListener = EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          const event = new CustomEvent("updated", {
            detail: {
              code: editor.state.doc.toString()
            }
          });
          this.dispatchEvent(event);
        }
      });
      const state = EditorState.create({
        doc: this.code,
        extensions: [basicSetup, updateListener]
      });
      const editor = new EditorView({
        state,
        parent: editorContainer
      });
    }
  }

  override render() {
    return html` <div id="editor" class="editor"></div> `;
  }
}
