import { css, html, LitElement, PropertyValues, render } from "lit";
import { baseStyles } from "../style.ts";
import { basicSetup } from "codemirror";
import { EditorView } from "@codemirror/view";
import { Compartment, EditorState, Extension } from "@codemirror/state";
import { LanguageSupport } from "@codemirror/language";
import { javascript as createJavaScript } from "@codemirror/lang-javascript";
import { markdown as createMarkdown } from "@codemirror/lang-markdown";
import { css as createCss } from "@codemirror/lang-css";
import { html as creatHtml } from "@codemirror/lang-html";
import { json as createJson } from "@codemirror/lang-json";
import { oneDark } from "@codemirror/theme-one-dark";
import {
  createCancelGroup,
  replaceSourceIfNeeded,
} from "./codemirror/utils.ts";
import {
  type CompilationError,
  errorDecorations,
  setErrors,
} from "./codemirror/error-decorations.ts";

const freeze = Object.freeze;

export const MimeType = freeze(
  {
    css: "text/css",
    html: "text/html",
    javascript: "text/javascript",
    jsx: "text/x.jsx",
    typescript: "text/x.typescript",
    json: "application/json",
    markdown: "text/markdown",
  } as const,
);

export type MimeType = (typeof MimeType)[keyof typeof MimeType];

export const langRegistry = new Map<MimeType, LanguageSupport>();
const markdownLang = createMarkdown({
  defaultCodeLanguage: createJavaScript({ jsx: true }),
});
const defaultLang = markdownLang;

langRegistry.set(MimeType.javascript, createJavaScript());
langRegistry.set(
  MimeType.jsx,
  createJavaScript({
    jsx: true,
  }),
);
langRegistry.set(
  MimeType.typescript,
  createJavaScript({
    jsx: true,
    typescript: true,
  }),
);
langRegistry.set(MimeType.css, createCss());
langRegistry.set(MimeType.html, creatHtml());
langRegistry.set(MimeType.markdown, markdownLang);
langRegistry.set(MimeType.json, createJson());

export const getLangExtFromMimeType = (mime: MimeType) => {
  return langRegistry.get(mime) ?? defaultLang;
};

export const createEditor = ({
  element,
  extensions = [],
}: {
  element: HTMLElement;
  extensions?: Array<Extension>;
}) => {
  const state = EditorState.create({
    extensions: [basicSetup, oneDark, ...extensions],
  });

  return new EditorView({
    state,
    parent: element,
  });
};

export type CommonCodeEditorDetail = {
  id: string;
  value: string;
  language: string;
};

export class CommonCodeEditorEvent extends Event {
  detail: CommonCodeEditorDetail;

  constructor(detail: CommonCodeEditorDetail) {
    super("change", { bubbles: true, composed: true });
    this.detail = detail;
  }
}

export class CommonCodeEditor extends LitElement {
  static override styles = [
    baseStyles,
    css`
      :host {
        display: block;
      }

      .code-editor {
        display: block;
        height: 100%;
      }

      .cm-editor {
        height: 100%;
      }

      .cm-scroller {
        overflow: auto;
      }

      .cm-editor.cm-focused {
        outline: none;
      }
    `,
  ];

  #editorView: EditorView | undefined = undefined;
  #lang = new Compartment();
  #tabSize = new Compartment();
  #docChangeTimeout: number | undefined = undefined;

  destroy = createCancelGroup();

  static override properties = {
    source: { type: String },
    language: { type: String },
    errors: { type: Array },
  };

  declare source: string;
  declare language: MimeType;
  declare errors?: CompilationError[];

  constructor() {
    super();
    this.source = "";
    this.language = MimeType.markdown;
  }

  get editor(): EditorState | undefined {
    return this.#editorView?.state;
  }

  set editor(state: EditorState) {
    this.#editorView?.setState(state);
  }

  protected override firstUpdated(changedProperties: PropertyValues): void {
    super.firstUpdated(changedProperties);
    // Set up skeleton
    // - #editor is managed by ProseMirror
    // - #reactive is rendered via Lit templates and driven by store updates
    render(
      html`
        <div id="editor" class="code-editor"></div>
      `,
      this.renderRoot,
    );
    const editorRoot = this.renderRoot.querySelector("#editor") as HTMLElement;

    const ext = EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        if (this.#docChangeTimeout) {
          globalThis.clearTimeout(this.#docChangeTimeout);
        }
        this.#docChangeTimeout = globalThis.setTimeout(() => {
          const value = this.#editorView?.state.doc.toString() || "";
          this.source = value;
          this.dispatchEvent(
            new CommonCodeEditorEvent({
              id: this.id,
              value,
              language: this.language,
            }),
          );
        }, 500);
      }
    });
    this.#editorView = createEditor({
      element: editorRoot,
      extensions: [
        this.#lang.of(defaultLang),
        this.#tabSize.of(EditorState.tabSize.of(4)),
        ext,
        errorDecorations(),
      ],
    });

    this.destroy.add(() => {
      this.#editorView?.destroy();
      if (this.#docChangeTimeout) {
        globalThis.clearTimeout(this.#docChangeTimeout);
      }
    });
  }

  protected override updated(changedProperties: PropertyValues): void {
    if (changedProperties.has("source")) {
      replaceSourceIfNeeded(this.#editorView!, this.source);
    }
    if (changedProperties.has("language")) {
      const lang = getLangExtFromMimeType(this.language);
      this.#editorView?.dispatch({
        effects: this.#lang.reconfigure(lang),
      });
    }
    if (changedProperties.has("errors") && this.#editorView) {
      setErrors(this.#editorView, this.errors || []);
    }
  }
}

globalThis.customElements.define("common-code-editor", CommonCodeEditor);
