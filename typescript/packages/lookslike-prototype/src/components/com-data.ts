import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { EditorView, basicSetup } from "codemirror"
import { javascript } from "@codemirror/lang-javascript"
import { json } from "@codemirror/lang-json"
import { EditorState } from '@codemirror/state';
import { format } from '../format'
import { foldGutter, foldService, foldAll, foldEffect, foldedRanges } from "@codemirror/language";

@customElement('com-data')
class CodeMirrorDataViewer extends LitElement {
  @property({ type: String }) data = '';

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
    const editorContainer = this.shadowRoot?.getElementById('editor');
    if (editorContainer) {
      const updateListener = EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          console.log('updated');
          const event = new CustomEvent('updated', {
            detail: {
              code: this.editor.state.doc.toString()
            }
          });
          this.dispatchEvent(event);
        }
      });
      this.state = EditorState.create({
        doc: this.data,
        extensions: [basicSetup, json(), updateListener]
      })
      this.editor = new EditorView({
        state: this.state,
        parent: editorContainer
      })
    }
  }

  foldAll() {
    const view = this.editor;
    foldAll(view)
    view.dispatch({});
  }

  updated() {
    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        console.log('updated');
        const event = new CustomEvent('updated', {
          detail: {
            data: this.editor.state.doc.toString()
          }
        });
        this.dispatchEvent(event);
      }
    });
    this.state = EditorState.create({
      doc: this.data,
      extensions: [basicSetup, json(), updateListener]
    })

    // replace contents
    this.editor.dispatch({
      changes: {
        from: 0,
        to: this.editor.state.doc.length,
        insert: this.data
      }
    });
    this.foldAll();
  }

  render() {
    return html`
      <div id="editor" class="editor"></div>
    `;
  }
}
