import { LitElement, css, html, render } from "lit";
import { EditorState, Plugin } from "prosemirror-state";
import { EditorView, Decoration } from "prosemirror-view";
import { Schema } from "prosemirror-model";
import { history } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { baseKeymap } from "prosemirror-commands";
import { customElement } from "lit/decorators.js";
import { base } from "../../shared/styles.js";
import { suggestionsPlugin } from "./suggestions-plugin.js";
import { classes, toggleHidden } from "../../shared/dom.js";
import { positionMenu } from "../../shared/position.js";

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

const editorClassPlugin = () =>
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

const createEditor = (
  editorElement: HTMLElement,
  mentionSuggestionsElement: HTMLElement,
  hashtagSuggestionsElement: HTMLElement,
) => {
  const hashtagPlugin = suggestionsPlugin({
    pattern: /#\w+/g,
    decoration: ({ from, to, active }) =>
      Decoration.inline(from, to, {
        class: classes({ hashtag: true, "hashtag--active": active }),
      }),
    onUpdate: (view, suggestion) => {
      if (suggestion) {
        const rect = view.coordsAtPos(suggestion.from);
        positionMenu(hashtagSuggestionsElement, rect);
        toggleHidden(hashtagSuggestionsElement, false);
      } else {
        toggleHidden(hashtagSuggestionsElement, true);
      }
    },
  });

  const mentionPlugin = suggestionsPlugin({
    pattern: /@\w+/g,
    decoration: ({ from, to, active }) =>
      Decoration.inline(from, to, {
        class: classes({ mention: true, "mention--active": active }),
      }),
    onUpdate: (view, suggestion) => {
      if (suggestion) {
        const rect = view.coordsAtPos(suggestion.from);
        positionMenu(mentionSuggestionsElement, rect);
        toggleHidden(mentionSuggestionsElement, false);
      } else {
        toggleHidden(mentionSuggestionsElement, true);
      }
    },
  });

  const plugins = [
    history(),
    keymap(baseKeymap),
    editorClassPlugin(),
    mentionPlugin,
    hashtagPlugin,
  ];

  const state = EditorState.create({
    schema,
    plugins,
  });

  return new EditorView(editorElement, {
    state,
  });
};

@customElement("os-rich-text-editor")
export class OsRichTextEditor extends LitElement {
  #editor: EditorView | null = null;

  static override styles = [
    base,
    css`
      .wrapper {
        display: block;
        position: relative;
      }

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

      .suggestions {
        border: 1px solid black;
        position: absolute;
        left: 0;
        top: 0;
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
    const elements = html`
      <div id="wrapper" class="wrapper">
        <div id="editor" class="editor"></div>
        <div id="mention-suggestions" class="suggestions">
          Hello mention suggestions
        </div>
        <div id="hashtag-suggestions" class="suggestions">
          Hello hashtag suggestions
        </div>
      </div>
    `;
    render(elements, this.renderRoot);
    const editorElement = this.renderRoot.querySelector(
      "#editor",
    ) as HTMLElement;
    const mentionSuggestionsElement = this.renderRoot.querySelector(
      "#mention-suggestions",
    ) as HTMLElement;
    const hashtagSuggestionsElement = this.renderRoot.querySelector(
      "#hashtag-suggestions",
    ) as HTMLElement;
    this.#editor = createEditor(
      editorElement,
      mentionSuggestionsElement,
      hashtagSuggestionsElement,
    );
  }
}
