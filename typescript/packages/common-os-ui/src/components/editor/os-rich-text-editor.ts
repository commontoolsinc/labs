import { ReactiveElement, css, html, render, PropertyValues } from "lit";
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
import { classes } from "../../shared/dom.js";
import {
  createStore,
  cursor,
  forward,
  unknown,
  Fx,
  Store,
} from "../../shared/store.js";
import { createCleanupGroup } from "../../shared/cleanup.js";
import { TemplateResult } from "lit";

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
      return unknown(state, msg);
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

const createHashtagDecoration = ({ from, to, active }: Suggestion) => {
  return Decoration.inline(from, to, {
    class: classes({ hashtag: true, "hashtag--active": active }),
  });
};

const renderCompletion = (completion: suggestions.Completion) => html`
  <div class="completion">${completion.text}</div>
`;

/**
 * Specialized version of `suggestionsPlugin` that takes care of wiring
 * plugin lifecycle callbacks to store
 */
const suggestionsStorePlugin = ({
  pattern,
  decoration,
  send,
}: {
  pattern: RegExp;
  decoration: (suggestion: Suggestion) => Decoration;
  send: (msg: suggestions.Msg) => void;
}) =>
  suggestionsPlugin({
    pattern,
    decoration,
    onUpdate: (_view, update) => send(suggestions.createUpdateMsg(update)),
    onDestroy: () => send(suggestions.createDestroyMsg()),
    onArrowUp: () => send(suggestions.createArrowUpMsg()),
    onArrowDown: () => send(suggestions.createArrowDownMsg()),
    onEnter: () => send(suggestions.createEnterMsg()),
    onTab: () => send(suggestions.createTabMsg()),
  });

/**
 * Create and return a configured Prosemirror editor instance/**
 * @param {Object} options - Configuration options for creating the editor
 * @param {HTMLElement} options.element - The DOM element where the editor will be rendered
 * @param {(msg: Msg) => void} options.send - A function to send messages from the editor
 * @returns {EditorView} A configured Prosemirror editor instance
 */
export const createEditor = ({
  element: editor,
  send,
}: {
  element: HTMLElement;
  send: (msg: Msg) => void;
}): EditorView => {
  // NOTE: make sure suggestion plugins come before keymap plugin so they
  // get a chance to intercept enter and tab.
  const plugins = [
    suggestionsStorePlugin({
      pattern: /@\w+/g,
      decoration: createMentionDecoration,
      send: forward(send, createMentionMsg),
    }),
    suggestionsStorePlugin({
      pattern: /#\w+/g,
      decoration: createHashtagDecoration,
      send: forward(send, createHashtagMsg),
    }),
    history(),
    keymap(baseKeymap),
    editorClassPlugin(),
  ];

  const state = EditorState.create({
    schema: schema(),
    plugins,
  });

  return new EditorView(editor, {
    state,
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

  #destroy = createCleanupGroup();
  #store: Store<State, Msg>;
  #editorView?: EditorView;
  #reactiveRoot?: HTMLElement;

  constructor() {
    super();
    this.#store = createStore({
      state: init(),
      update,
      fx,
    });
    // Drive updates via store changes
    const cleanupRender = this.#store.sink(() => this.requestUpdate());
    this.#destroy.add(cleanupRender);
  }

  get editor() {
    return this.#editorView;
  }

  get state() {
    return this.#store.get();
  }

  send(msg: Msg) {
    this.#store.send(msg);
  }

  set state(_state: State) {
    // TODO
    // this.#state.send();
  }

  /**
   * Render reactive portion of editor.
   * This gets rendered in a `div#reactive` that is placed immediately
   * under the editor element.
   */
  render(): TemplateResult {
    const hashtagState = this.state.hashtag;
    const mentionState = this.state.mention;
    return html`
      <os-floating-menu
        id="mention-suggestions"
        .anchor=${mentionState.coords}
        .open=${mentionState.active != null}
      >
        ${mentionState.completions.map(renderCompletion)}
      </os-floating-menu>
      <os-floating-menu
        id="hashtag-suggestions"
        .anchor=${hashtagState.coords}
        .open=${hashtagState.active != null}
      >
        ${hashtagState.completions.map(renderCompletion)}
      </os-floating-menu>
    `;
  }

  protected override update(changedProperties: PropertyValues): void {
    super.update(changedProperties);

    // Wire up reactive rendering
    const templateResult = this.render();
    if (this.#reactiveRoot != null) render(templateResult, this.#reactiveRoot);
  }

  override firstUpdated(changedProperties: PropertyValues) {
    super.firstUpdated(changedProperties);
    this.#createSkeleton();

    const editorView = createEditor({
      element: this.renderRoot.querySelector("#editor") as HTMLElement,
      send: this.#store.send,
    });
    this.#destroy.add(() => {
      editorView.destroy();
    });
  }

  /** Renders the skeleton of the component. Run once during firstUpdated.
   * Sets up an HTML skeleton in the renderRoot with:
   * - a wrapper to create a shared positioning context
   * - an editor area that will be managed by ProseMirror and will not be
   *   touched by LitElement reactive rendering.
   * - a reactive area that will be the `renderRoot` for LitElement
   */
  #createSkeleton() {
    const skeleton = html`
      <div id="wrapper" class="wrapper">
        <div id="editor" class="editor"></div>
        <div id="reactive"></div>
      </div>
    `;
    render(skeleton, this.renderRoot);

    // Find the `div#reactive` element we just created and
    // assign it as reactive root.
    this.#reactiveRoot = this.renderRoot.querySelector(
      "#reactive",
    ) as HTMLElement;
  }
}
