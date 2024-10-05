import { LitElement, css } from "lit";
import { EditorState, Plugin } from "prosemirror-state";
import { EditorView, Decoration, DecorationSet } from "prosemirror-view";
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
    hashtag: {
      parseDOM: [{ tag: "span.hashtag" }],
      toDOM: () => ["span", { class: "hashtag" }, 0],
    },
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

export const modelessMarkupDecorationPlugin = ({
  pattern,
  decoration,
}: {
  pattern: RegExp;
  decoration: (from: number, to: number) => Decoration;
}) =>
  new Plugin({
    props: {
      decorations(state) {
        const decorations: Array<Decoration> = [];
        state.doc.descendants((node, pos) => {
          if (node.isText && node.text != null) {
            const text = node.text;
            const matches = text.matchAll(pattern);
            for (const match of matches) {
              const from = pos + match.index;
              const to = from + match[0].length;
              decorations.push(decoration(from, to));
            }
          }
        });
        return DecorationSet.create(state.doc, decorations);
      },
    },
  });

const hashtagPlugin = modelessMarkupDecorationPlugin({
  pattern: /#\w+/g,
  decoration: (from, to) => Decoration.inline(from, to, { class: "hashtag" }),
});

const mentionPlugin = modelessMarkupDecorationPlugin({
  pattern: /@\w+/g,
  decoration: (from, to) => Decoration.inline(from, to, { class: "mention" }),
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

const plugins = () => [
  history(),
  keymap(baseKeymap),
  editorClassPlugin,
  hashtagPlugin,
  mentionPlugin,
];

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
        white-space: pre-wrap;

        &:focus {
          outline: none;
        }
      }

      .mention {
        --height: calc(var(--u) * 5);
        font-weight: bold;
        display: inline-block;
        background-color: var(--bg-3);
        height: var(--height);
        line-height: var(--height);
        border-radius: calc(var(--height) / 2);
        padding: 0 calc(var(--u) * 2);
      }

      .hashtag {
        --height: calc(var(--u) * 5);
        font-weight: bold;
        display: inline-block;
        background-color: var(--bg-3);
        height: var(--height);
        line-height: var(--height);
        border-radius: calc(var(--height) / 2);
        padding: 0 calc(var(--u) * 2);
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
