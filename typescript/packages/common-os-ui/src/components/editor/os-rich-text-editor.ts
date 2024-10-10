import { ReactiveElement, css, html, render, TemplateResult } from "lit";
import { EditorState, Plugin } from "prosemirror-state";
import { EditorView, Decoration } from "prosemirror-view";
import { Schema } from "prosemirror-model";
import { history } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { baseKeymap } from "prosemirror-commands";
import { customElement } from "lit/decorators.js";
import { base } from "../../shared/styles.js";
import { suggestionsPlugin, Suggestion } from "./suggestions-plugin.js";
import * as suggestions from "./suggestions.js";
import { classes, toggleInvisible } from "../../shared/dom.js";
import { positionMenu } from "../../shared/position.js";
import { createStore, cursor, forward, Fx, Store } from "../../shared/store.js";
import { createCleanupGroup } from "../../shared/cleanup.js";

const schema = () => {
  return new Schema({
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
};

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

const freeze = Object.freeze;

export const createMentionMsg = (value: suggestions.Msg) =>
  freeze({
    type: "mention",
    value,
  });

export const createHashtagMsg = (value: suggestions.Msg) =>
  freeze({
    type: "hashtag",
    value,
  });

export type Msg =
  | ReturnType<typeof createHashtagMsg>
  | ReturnType<typeof createMentionMsg>;

export type State = {
  mention: suggestions.State;
  hashtag: suggestions.State;
};

export const init = (): State => ({
  mention: suggestions.init(),
  hashtag: suggestions.init(),
});

const updateMention = cursor({
  update: suggestions.update,
  get: (big: State) => big.mention,
  put: (big: State, small: suggestions.State) =>
    freeze({
      ...big,
      mention: small,
    }),
});

const updateHashtag = cursor({
  update: suggestions.update,
  get: (big: State) => big.mention,
  put: (big: State, small: suggestions.State) =>
    freeze({
      ...big,
      hashtag: small,
    }),
});

export const update = (state: State, msg: Msg): State => {
  switch (msg.type) {
    case "mention":
      return updateMention(state, msg.value);
    case "hashtag":
      return updateHashtag(state, msg.value);
    default:
      console.warn("update", "uknown msg type", msg);
      return state;
  }
};

export const fx = (_msg: Msg): Array<Fx<Msg>> => {
  return [];
};

const createMentionDecoration = ({ from, to, active }: Suggestion) => {
  return Decoration.inline(from, to, {
    class: classes({ mention: true, "mention--active": active }),
  });
};

@customElement("os-rich-text-editor")
export class OsRichTextEditor extends ReactiveElement {
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
        position: absolute;
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

  #cleanup = createCleanupGroup();
  #state: Store<State, Msg>;
  #editor: EditorView | null = null;
  #extras: HTMLElement | null = null;

  constructor() {
    super();
    this.#state = createStore({
      state: init(),
      update,
      fx,
    });
  }

  get state() {
    return this.#state.get();
  }

  send(msg: Msg) {
    this.#state.send(msg);
  }

  set state(_state: State) {
    // TODO
    // this.#state.send();
  }

  #render = () => {
    if (this.#extras == null) return;
    const template = this.render();
    render(template, this.#extras);
  };

  render(): TemplateResult {
    const hashtagState = this.state.hashtag;
    const mentionState = this.state.mention;
    return html`
      <os-floating-menu
        id="mention-suggestions"
        .anchor=${mentionState.coords}
        .open=${mentionState.active != null}
      >
        Hello mentions
      </os-floating-menu>
      <os-floating-menu
        id="hashtag-suggestions"
        .anchor=${hashtagState.coords}
        .open=${hashtagState.active != null}
      >
        Hello hashtag
      </os-floating-menu>
    `;
  }

  #createEditor() {
    // Set up editor DOM
    const elements = html`
      <div id="wrapper" class="wrapper">
        <div id="editor" class="editor"></div>
        <div id="extras"></div>
      </div>
    `;
    render(elements, this.renderRoot);

    this.#extras = this.renderRoot.querySelector("#extras") as HTMLElement;

    const editorElement = this.renderRoot.querySelector(
      "#editor",
    ) as HTMLElement;

    const sendMentions = forward(this.#state.send, createMentionMsg);

    // NOTE: make sure suggestion plugins come before keymap plugin so they
    // get a chance to intercept enter and tab.
    const plugins = [
      suggestionsPlugin({
        pattern: /@\w+/g,
        decoration: createMentionDecoration,
        onUpdate: (_view, update) =>
          sendMentions(suggestions.createUpdateMsg(update)),
        onDestroy: () => sendMentions(suggestions.createDestroyMsg()),
        onArrowUp: () => sendMentions(suggestions.createArrowUpMsg()),
        onArrowDown: () => sendMentions(suggestions.createArrowDownMsg()),
        onEnter: () => sendMentions(suggestions.createEnterMsg()),
        onTab: () => sendMentions(suggestions.createTabMsg()),
      }),
      history(),
      keymap(baseKeymap),
      editorClassPlugin(),
    ];

    const state = EditorState.create({
      schema: schema(),
      plugins,
    });

    const editor = new EditorView(editorElement, {
      state,
    });
    this.#editor = editor;

    const cleanupRender = this.#state.sink(this.#render);
    this.#cleanup.add(cleanupRender);
  }

  override connectedCallback() {
    super.connectedCallback();
    this.#createEditor();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.#editor?.destroy();
  }
}
