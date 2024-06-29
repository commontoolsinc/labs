import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { EditorView, basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { foldAll } from "@codemirror/language";

@customElement("com-data")
export class CodeMirrorDataViewer extends LitElement {
  @property({ type: String }) data = "";

  state: EditorState;
  editor: EditorView;

  #lastData = "";

  firstUpdated() {
    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        const content = this.editor.state.doc.toString();
        if (content !== this.#lastData) {
          console.log("updated");
          const event = new CustomEvent("updated", {
            detail: {
              data: this.editor.state.doc.toString()
            }
          });
          this.#lastData = content;
          this.dispatchEvent(event);
        }
      }
    });
    const editorContainer = this.shadowRoot?.getElementById("editor");
    if (editorContainer) {
      this.state = EditorState.create({
        doc: this.data,
        extensions: [basicSetup, updateListener]
      });
      this.editor = new EditorView({
        state: this.state,
        parent: editorContainer
      });
    }
    this.foldAll();
  }

  foldAll() {
    const view = this.editor;
    foldAll(view);
  }

  updated() {
    // replace contents if editor is not focused
    if (!this.editor.hasFocus) {
      this.editor.dispatch({
        changes: {
          from: 0,
          to: this.editor.state.doc.length,
          insert: this.data
        }
      });
      this.foldAll();
    }
  }

  render() {
    return html` <div id="editor" class="editor"></div> `;
  }
}
