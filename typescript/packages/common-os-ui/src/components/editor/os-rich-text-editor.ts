import { css, html, render, adoptStyles } from "lit";
import { EditorState } from "prosemirror-state";
import { EditorView, Decoration } from "prosemirror-view";
import { Schema, Node } from "prosemirror-model";
import { history } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { baseKeymap } from "prosemirror-commands";
import { customElement } from "lit/decorators.js";
import { base } from "../../shared/styles.js";
import { editorClassPlugin } from "./prosemirror/editor-class-plugin.js";
import { verPlugin, updateVerState } from "./prosemirror/ver-plugin.js";
import * as suggestions from "./suggestions.js";
import * as completion from "./completion.js";
import { createSelection, TextSelection } from "./selection.js";
import {
  createStore,
  cursor,
  forward,
  unknown,
  mapFx,
  Fx,
  Store,
  ValueMsg,
} from "../../shared/store.js";
import { createCancelGroup } from "../../shared/cancel.js";
import { TemplateResult } from "lit";
import { classes, on } from "../../shared/dom.js";
import { ClickCompletion } from "../os-floating-completions.js";
import { Suggestion } from "./prosemirror/suggestions-plugin.js";

const freeze = Object.freeze;

export type MentionMsg = ValueMsg<"mention", suggestions.Msg>;

export const createMentionMsg = (value: suggestions.Msg): MentionMsg =>
  freeze({ type: "mention", value });

export type HashtagMsg = ValueMsg<"hashtag", suggestions.Msg>;

export const createHashtagMsg = (value: suggestions.Msg): HashtagMsg =>
  freeze({ type: "hashtag", value });

export type InfoMsg = ValueMsg<"info", string>;

export const createInfoMsg = (value: string): InfoMsg =>
  freeze({ type: "info", value });

export type Msg = MentionMsg | HashtagMsg | InfoMsg;

export const tagMentionMsg = (msg: suggestions.Msg): Msg => {
  switch (msg.type) {
    default:
      return createMentionMsg(msg);
  }
};

export const tagHashtagMsg = (msg: suggestions.Msg): Msg => {
  switch (msg.type) {
    default:
      return createHashtagMsg(msg);
  }
};

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

/**
 * Create an fx driver that generates fx based on the state and message.
 * @param {object }options - the options object
 * @param options.view - the ProseMirror EditorView
 * @param options.fetchCompletions - an async function that can fetch completion objects
 * @returns an fx function for store
 */
export const createFx = ({
  view,
  fetchCompletions,
}: {
  view: EditorView;
  fetchCompletions: (
    suggestion: Suggestion,
  ) => Promise<Array<completion.Model>>;
}) => {
  const suggestionsFx = suggestions.createFx({
    view,
    fetchCompletions,
  });

  return (state: Model, msg: Msg): Array<Fx<Msg>> => {
    switch (msg.type) {
      case "hashtag":
        return mapFx(suggestionsFx(state.hashtag, msg.value), tagHashtagMsg);
      case "mention":
        return mapFx(suggestionsFx(state.mention, msg.value), tagMentionMsg);
      default:
        return [];
    }
  };
};

/** ProseMirror schema */
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

/** Parse a text string into a document of schema type */
export const parseTextToDoc = (text: string): Node => {
  const content = text
    .split("\n")
    .map((p) => schema.nodes.paragraph.create(null, schema.text(p)));

  return schema.nodes.doc.create(null, content);
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

const suggestionsStorePlugin = suggestions.suggestionsStorePlugin;

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
      send: forward(send, tagMentionMsg),
    }),
    suggestionsStorePlugin({
      pattern: /#\w+/g,
      decoration: createHashtagDecoration,
      send: forward(send, tagHashtagMsg),
    }),
    history(),
    keymap(baseKeymap),
    editorClassPlugin(),
    verPlugin,
  ];

  const state = EditorState.create({
    schema,
    plugins,
  });

  return new EditorView(editor, {
    state,
  });
};

/** Custom event for editor state changes */
export class EditorStateChangeEvent extends Event {
  detail: EditorState;

  constructor(detail: EditorState) {
    super("EditorStateChange", {
      bubbles: true,
      composed: true,
    });
    this.detail = detail;
  }
}

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

  destroy = createCancelGroup();
  #store: Store<Model, Msg>;
  #editorView: EditorView;
  #reactiveRoot: HTMLElement;
  #shadow: ShadowRoot;

  constructor() {
    super();
    // Set up shadow and styles
    this.#shadow = this.attachShadow({ mode: "closed" });
    adoptStyles(this.#shadow, OsRichTextEditor.styles);

    // Set up skeleton
    // - #editor is managed by ProseMirror
    // - #reactive is rendered via Lit templates and driven by store updates
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

    // Create ProseMirror instance
    this.#editorView = createEditor({
      element: editorRoot,
      send: (msg: Msg) => this.#store.send(msg),
    });
    this.destroy.add(() => {
      this.#editorView.destroy();
    });

    // Relay input events as custom statechange events
    const offInput = on(this, "input", (_event) => {
      const event = new EditorStateChangeEvent(this.#editorView.state);
      this.dispatchEvent(event);
    });
    this.destroy.add(offInput);

    // Create fx driver
    const fx = createFx({
      view: this.#editorView,
      fetchCompletions: (suggestion: Suggestion) =>
        this.fetchCompletions(suggestion),
    });

    this.#store = createStore({
      state: model(),
      update,
      fx,
    });

    // Drive #reactive renders via store changes
    const cancelRender = this.#store.sink(() => {
      // Wire up reactive rendering
      render(this.render(), this.#reactiveRoot);
    });
    this.destroy.add(cancelRender);
  }

  get editor() {
    return this.#editorView.state;
  }

  set editor(state: EditorState) {
    updateVerState(this.#editorView, state);
  }

  /** TODO implement */
  async fetchCompletions(_suggestion: Suggestion) {
    return [];
  }

  /**
   * Render reactive portion of editor.
   * This gets rendered in a `div#reactive` that is placed immediately
   * under the editor element.
   */
  render(): TemplateResult {
    const hashtagState = this.#store.get().hashtag;
    const mentionState = this.#store.get().mention;

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
