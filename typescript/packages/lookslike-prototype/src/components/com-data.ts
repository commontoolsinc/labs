import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { EditorView, basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { foldAll } from "@codemirror/language";

@customElement("com-data")
export class CodeMirrorDataViewer extends LitElement {
  @property({ type: String }) data = "";

  static styles = css`
    :host {
      display: block;
    }
    .editor {
      border: 1px solid #ccc;
      border-radius: 4px;
    }
  `;
  state: EditorState;
  editor: EditorView;

  firstUpdated() {
    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        console.log("updated");
        const event = new CustomEvent("updated", {
          detail: {
            data: this.editor.state.doc.toString()
          }
        });
        this.dispatchEvent(event);
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
    }
  }

  render() {
    return html` <div id="editor" class="editor"></div> `;
  }
}
