import { LitElement, css } from "lit";
import { EditorState, Plugin } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { Schema } from "prosemirror-model";
import { history } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { baseKeymap } from "prosemirror-commands";
import { customElement } from "lit/decorators.js";
import { base } from "../shared/styles.js";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      group: "block",
      content: "inline*",
      parseDOM: [{ tag: "p" }],
      toDOM: () => ["p", 0],
    },
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

const editorClassPlugin = new Plugin({
  view(editorView) {
    editorView.dom.classList.add("editor");

    return {
      destroy() {
        editorView.dom.classList.remove("editor");
      },
    };
  },
});

const plugins = () => [history(), keymap(baseKeymap), editorClassPlugin];

@customElement("os-rich-text-editor")
export class OsRichTextEditor extends LitElement {
  #editor: EditorView | null = null;

  static override styles = [
    base,
    css`
      .editor {
        font-family: var(--font-family);
        font-size: var(--body-size);
        line-height: var(--body-line);
        -webkit-font-smoothing: antialiased;
        font-smooth: antialiased;
        display: flex;
        flex-direction: column;
        gap: var(--body-gap);

        &:focus {
          outline: none;
        }
      }
    `,
  ];

  get editor() {
    return this.#editor;
  }

  override firstUpdated() {
    this.#initEditor();
  }

  #initEditor() {
    const state = EditorState.create({
      schema,
      plugins: plugins(),
    });

    const editorEl = document.createElement("div");
    editorEl.id = "editor";
    editorEl.classList.add("editor");
    this.shadowRoot?.append(editorEl);

    this.#editor = new EditorView(editorEl, {
      state,
    });
  }
}
