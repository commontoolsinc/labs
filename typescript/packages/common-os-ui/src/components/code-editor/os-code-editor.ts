import { css, html, render, adoptStyles } from "lit";
import { customElement } from "lit/decorators.js";
import { basicSetup, EditorView } from "codemirror";
import { EditorState, Compartment } from "@codemirror/state";
import { javascript } from "@codemirror/lang-javascript";
import { oneDark } from "@codemirror/theme-one-dark";
import { createStore, Store, ValueMsg, FxDriver } from "../../shared/store.js";
import { createCancelGroup } from "../../shared/cancel.js";

const freeze = Object.freeze;

export const MimeTypes = freeze({
  css: "text/css",
  html: "text/html",
  javascript: "text/javascript",
  typescript: "text/x.typescript",
  json: "application/json",
  markdown: "text/markdown",
} as const);

export type MimeType = (typeof MimeTypes)[keyof typeof MimeTypes];

export type SetText = ValueMsg<"setText", string>;

export type Msg = SetText;

export type Model = {
  lang: MimeType;
  text: string;
};

export const model = ({
  lang = MimeTypes.javascript,
  text = "",
}: {
  lang?: MimeType;
  text?: string;
}): Model =>
  freeze({
    lang,
    text,
  });

export const update = (state: Model, _msg: Msg): Model => {
  return state;
};

export const createFx =
  (): FxDriver<Model, Msg> => (_state: Model, _msg: Msg) => {
    return [];
  };

export const createEditor = ({ element }: { element: HTMLElement }) => {
  const language = new Compartment();
  const tabSize = new Compartment();

  const state = EditorState.create({
    extensions: [
      basicSetup,
      oneDark,
      language.of(javascript()),
      tabSize.of(EditorState.tabSize.of(4)),
    ],
  });

  return new EditorView({
    state,
    parent: element,
  });
};

@customElement("os-code-editor")
export class OsCodeEditor extends HTMLElement {
  static styles = [
    css`
      :host {
        display: block;
      }

      .code-editor {
        display: block;
      }

      .cm-editor.cm-focused {
        outline: none;
      }
    `,
  ];

  #shadow: ShadowRoot;
  destroy = createCancelGroup();
  #store: Store<Model, Msg>;
  #editorView: EditorView;

  constructor() {
    super();
    // Set up shadow and styles
    this.#shadow = this.attachShadow({ mode: "closed" });
    adoptStyles(this.#shadow, OsCodeEditor.styles);

    // Set up skeleton
    // - #editor is managed by ProseMirror
    // - #reactive is rendered via Lit templates and driven by store updates
    render(html`<div id="editor" class="code-editor"></div>`, this.#shadow);

    const editorRoot = this.#shadow.querySelector("#editor") as HTMLElement;

    this.#store = createStore({
      state: model({}),
      update,
    });
    const cleanupRender = this.#store.sink(() => {});
    this.destroy.add(cleanupRender);

    this.#editorView = createEditor({
      element: editorRoot,
    });
    this.destroy.add(() => this.#editorView.destroy());
  }

  render() {}
}
