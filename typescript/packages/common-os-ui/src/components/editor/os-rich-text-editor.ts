import { LitElement, css, html, render } from "lit";
import { EditorState, Plugin } from "prosemirror-state";
import { EditorView, Decoration } from "prosemirror-view";
import { Schema } from "prosemirror-model";
import { history } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { baseKeymap } from "prosemirror-commands";
import { customElement } from "lit/decorators.js";
import { base } from "../../shared/styles.js";
import {
  suggestionsPlugin,
  getSuggestionRect,
  Suggestion,
} from "./suggestions-plugin.js";
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

/**
 * Specialized version of the suggestion plugin that has more opinions about
 *
 */
const suggestionMenuPlugin = ({
  menu,
  pattern,
  decoration,
}: {
  menu: HTMLElement;
  pattern: RegExp;
  decoration: (suggestion: Suggestion) => Decoration;
}) =>
  suggestionsPlugin({
    pattern,
    decoration,
    reducer: (view, msg) => {
      if (msg.type === "init") {
        return false;
      } else if (msg.type === "update") {
        const suggestion = msg.suggestion;
        if (suggestion) {
          const rect = getSuggestionRect(view, suggestion);
          positionMenu(menu, rect);
          toggleHidden(menu, false);
          return false;
        } else {
          toggleHidden(menu, true);
          return false;
        }
      } else if (msg.type === "arrowDown") {
        return true;
      } else if (msg.type === "arrowUp") {
        return true;
      } else if (msg.type === "tab") {
        return true;
      } else if (msg.type === "enter") {
        return true;
      }
      return false;
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
  const hashtagPlugin = suggestionMenuPlugin({
    menu: hashtagSuggestionsElement,
    pattern: /#\w+/g,
    decoration: ({ from, to, active }) =>
      Decoration.inline(from, to, {
        class: classes({ hashtag: true, "hashtag--active": active }),
      }),
  });

  const mentionPlugin = suggestionMenuPlugin({
    pattern: /@\w+/g,
    menu: mentionSuggestionsElement,
    decoration: ({ from, to, active }) =>
      Decoration.inline(from, to, {
        class: classes({ mention: true, "mention--active": active }),
      }),
  });

  const plugins = [
    mentionPlugin,
    hashtagPlugin,
    history(),
    keymap(baseKeymap),
    editorClassPlugin(),
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
      :host {
        --suggestions-width: calc(var(--u) * 80);
      }

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
        background-color: var(--bg);
        padding: var(--pad-sm);
        border-radius: var(--radius);
        box-shadow: var(--shadow-menu);
        position: fixed;
        left: 0;
        top: 0;
        width: var(--suggestions-width);
        transition: opacity var(--dur-md) var(--ease-out-expo);
      }

      :is(.mention, .hashtag) {
        --height: calc(var(--u) * 5);
        font-weight: bold;
        display: inline-flex;
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

  override connectedCallback() {
    super.connectedCallback();

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

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.#editor?.destroy();
  }
}
