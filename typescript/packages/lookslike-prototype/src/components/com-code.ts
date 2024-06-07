import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { EditorView, basicSetup } from "codemirror"
import { javascript } from "@codemirror/lang-javascript"
import { EditorState } from '@codemirror/state';
import { format } from '../format'

@customElement('com-code')
class CodeMirrorCodeViewer extends LitElement {
  @property({ type: String }) code = '';

  static styles = css`
    :host {
      display: block;
    }
    .editor {
      border: 1px solid #ccc;
      border-radius: 4px;
    }
  `;

  async firstUpdated() {
    const editorContainer = this.shadowRoot?.getElementById('editor');
    if (editorContainer) {
      const updateListener = EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          const event = new CustomEvent('updated', {
            detail: {
              code: editor.state.doc.toString()
            }
          });
          this.dispatchEvent(event);
        }
      });
      const state = EditorState.create({
        doc: await format(this.code),
        extensions: [basicSetup, javascript(), updateListener]
      })
      const editor = new EditorView({
        state,
        parent: editorContainer
      })

    }
  }

  override render() {
    return html`
      <div id="editor" class="editor"></div>
    `;
  }
}
