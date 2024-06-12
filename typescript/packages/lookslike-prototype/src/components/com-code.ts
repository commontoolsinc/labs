import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { EditorView, basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";

@customElement("com-code")
class CodeMirrorCodeViewer extends LitElement {
  @property({ type: String }) code = "";
  editor: EditorView;

  override firstUpdated() {
    const editorContainer = this.shadowRoot?.getElementById("editor");
    if (editorContainer) {
      const updateListener = EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          const event = new CustomEvent("updated", {
            detail: {
              code: this.editor.state.doc.toString()
            }
          });
          this.dispatchEvent(event);
        }
      });
      const state = EditorState.create({
        doc: this.code,
        extensions: [basicSetup, updateListener]
      });
      this.editor = new EditorView({
        state,
        parent: editorContainer
      });
    }
  }

  override updated() {
    // replace contents if editor is not focused
    if (!this.editor.hasFocus) {
      this.editor.dispatch({
        changes: {
          from: 0,
          to: this.editor.state.doc.length,
          insert: this.code
        }
      });
    }
  }

  override render() {
    return html` <div id="editor" class="editor"></div> `;
  }
}
