import { LitElement, css } from "lit";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { Schema, DOMParser } from "prosemirror-model";
import { customElement } from "lit/decorators.js";

@customElement("os-rich-text-editor")
export class OsRichTextEditor extends LitElement {
  #editor: EditorView | null = null;

  static override styles = css`
    .ProseMirror {
      border: 1px solid #ccc;
      padding: 5px;
    }
    .ProseMirror:focus {
      outline: none;
      border-color: blue;
    }
  `;

  get editor() {
    return this.#editor;
  }

  override firstUpdated() {
    this.#initEditor();
  }

  #initEditor() {
    const schema = new Schema({
      nodes: {
        doc: { content: "block+" },
        paragraph: { group: "block", content: "inline*" },
        text: { group: "inline" },
      },
      marks: {
        bold: {
          parseDOM: [{ tag: "strong" }],
          toDOM: () => ["strong", 0],
        },
        italic: {
          parseDOM: [{ tag: "em" }],
          toDOM: () => ["em", 0],
        },
      },
    });

    const state = EditorState.create({
      schema,
      plugins: [],
    });

    const editorEl = document.createElement("div");
    editorEl.id = "editor";
    this.shadowRoot?.append(editorEl);

    this.#editor = new EditorView(editorEl, {
      state,
    });
  }
}
