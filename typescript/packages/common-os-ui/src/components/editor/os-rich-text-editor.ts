import { css, html, render, adoptStyles } from "lit";
import { EditorState } from "prosemirror-state";
import { EditorView, Decoration } from "prosemirror-view";
import { Schema } from "prosemirror-model";
import { history } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { baseKeymap } from "prosemirror-commands";
import { customElement } from "lit/decorators.js";
import { base } from "../../shared/styles.js";
import { editorClassPlugin } from "./prosemirror/editor-class-plugin.js";
import {
  suggestionsPlugin,
  Suggestion,
} from "./prosemirror/suggestions-plugin.js";
import * as suggestions from "./suggestions.js";
import { createSelection, TextSelection } from "./selection.js";
import {
  createStore,
  cursor,
  forward,
  unknown,
  mapFx,
  Fx,
  Store,
} from "../../shared/store.js";
import { createCleanupGroup } from "../../shared/cleanup.js";
import { TemplateResult } from "lit";
import { classes } from "../../shared/dom.js";
import { ClickCompletion } from "../os-floating-completions.js";

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

export const createInfoMsg = (value: string) => freeze({ type: "info", value });

export type Msg =
  | ReturnType<typeof createHashtagMsg>
  | ReturnType<typeof createMentionMsg>
  | ReturnType<typeof createInfoMsg>;

export type Model = {
  text: string;
  selection: TextSelection;
  mention: suggestions.Model;
  hashtag: suggestions.Model;
};

export const model = (): Model => ({
  text: "",
  selection: createSelection({ from: 0, to: 0, anchor: 0, head: 0 }),
  mention: suggestions.model(),
  hashtag: suggestions.model(),
});

const updateMention = cursor({
  update: suggestions.update,
  get: (big: Model) => big.mention,
  put: (big: Model, small: suggestions.Model) =>
    freeze({
      ...big,
      mention: small,
    }),
});

const updateHashtag = cursor({
  update: suggestions.update,
  get: (big: Model) => big.hashtag,
  put: (big: Model, small: suggestions.Model) =>
    freeze({
      ...big,
      hashtag: small,
    }),
});

const updateInfo = (state: Model, text: string): Model => {
  console.info(text);
  return state;
};

export const update = (state: Model, msg: Msg): Model => {
  switch (msg.type) {
    case "mention":
      return updateMention(state, msg.value);
    case "hashtag":
      return updateHashtag(state, msg.value);
    case "info":
      return updateInfo(state, msg.value);
    default:
      return unknown(state, msg);
  }
};

/** Side effects for the editor */
export const fx = (view: EditorView) => {
  const suggestionsFx = suggestions.fx(view);

  return (msg: Msg): Array<Fx<Msg>> => {
    switch (msg.type) {
      case "hashtag":
        return mapFx(suggestionsFx(msg.value), createHashtagMsg);
      case "mention":
        return mapFx(suggestionsFx(msg.value), createMentionMsg);
      default:
        return [];
    }
  };
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
    reducer: (_view, msg): boolean => {
      switch (msg.type) {
        case "activeUpdate":
          send(suggestions.createActiveUpdateMsg(msg));
          return true;
        case "inactiveUpdate":
          send(suggestions.createInactiveUpdateMsg());
          return true;
        case "destroy":
          send(suggestions.createDestroyMsg());
          return true;
        case "arrowUp":
          send(suggestions.createArrowUpMsg());
          return true;
        case "arrowDown":
          send(suggestions.createArrowDownMsg());
          return true;
        case "enter":
          send(suggestions.createEnterMsg());
          return true;
        case "tab":
          send(suggestions.createTabMsg());
          return true;
        default:
          return false;
      }
    },
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
export class OsRichTextEditor extends HTMLElement {
  static styles = [
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
  #store: Store<Model, Msg>;
  #editorView: EditorView;
  #reactiveRoot: HTMLElement;
  #shadow: ShadowRoot;

  constructor() {
    super();
    this.#shadow = this.attachShadow({ mode: "closed" });
    adoptStyles(this.#shadow, OsRichTextEditor.styles);

    render(
      html`
        <div id="wrapper" class="wrapper">
          <div id="editor" class="editor"></div>
          <div id="reactive"></div>
        </div>
      `,
      this.#shadow,
    );

    // Find the `div#reactive` element we just created and
    // assign it as reactive root.
    this.#reactiveRoot = this.#shadow.querySelector("#reactive") as HTMLElement;
    const editorRoot = this.#shadow.querySelector("#editor") as HTMLElement;

    this.#editorView = createEditor({
      element: editorRoot,
      send: (msg: Msg) => this.#store.send(msg),
    });

    this.#destroy.add(() => {
      this.#editorView.destroy();
    });

    this.#store = createStore({
      state: model(),
      update,
      fx: fx(this.#editorView),
    });

    // Drive updates via store changes
    const cleanupRender = this.#store.sink(this.#render);
    this.#destroy.add(cleanupRender);
  }

  #render = () => {
    // Wire up reactive rendering
    render(this.render(), this.#reactiveRoot);
  };

  get editor() {
    return this.#editorView;
  }

  get state() {
    return this.#store.get();
  }

  send(msg: Msg) {
    this.#store.send(msg);
  }

  set state(_state: Model) {
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

    const onHashtagClickCompletion = (event: ClickCompletion) => {
      this.#store.send(
        createHashtagMsg(suggestions.createClickCompletionMsg(event.detail)),
      );
    };

    const onMentionClickCompletion = (event: ClickCompletion) => {
      this.#store.send(
        createMentionMsg(suggestions.createClickCompletionMsg(event.detail)),
      );
    };

    return html`
      <os-floating-completions
        id="hashtag-completions"
        .anchor=${hashtagState.coords}
        .show=${hashtagState.active != null}
        .completions=${hashtagState.completions}
        .selected=${hashtagState.selectedCompletion}
        @click-completion=${onHashtagClickCompletion}
      >
      </os-floating-completions>
      <os-floating-completions
        id="mention-completions"
        .anchor=${mentionState.coords}
        .show=${mentionState.active != null}
        .completions=${mentionState.completions}
        .selected=${mentionState.selectedCompletion}
        @click-completion=${onMentionClickCompletion}
      >
      </os-floating-completions>
    `;
  }
}
