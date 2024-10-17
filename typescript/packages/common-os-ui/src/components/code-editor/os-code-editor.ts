import { css, html, render, ReactiveElement, PropertyValues } from "lit";
import { customElement, property } from "lit/decorators.js";
import { basicSetup, EditorView } from "codemirror";
import { EditorState, Compartment, Extension } from "@codemirror/state";
import { LanguageSupport } from "@codemirror/language";
import { javascript as createJavaScript } from "@codemirror/lang-javascript";
import { markdown as createMarkdown } from "@codemirror/lang-markdown";
import { css as createCss } from "@codemirror/lang-css";
import { html as creatHtml } from "@codemirror/lang-html";
import { json as createJson } from "@codemirror/lang-json";
import { oneDark } from "@codemirror/theme-one-dark";
import { replaceSourceIfNeeded } from "./codemirror/utils.js";
import { createCancelGroup } from "../../shared/cancel.js";

const freeze = Object.freeze;

export const MimeType = freeze({
  css: "text/css",
  html: "text/html",
  javascript: "text/javascript",
  jsx: "text/x.jsx",
  typescript: "text/x.typescript",
  json: "application/json",
  markdown: "text/markdown",
} as const);

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

@customElement("os-code-editor")
export class OsCodeEditor extends ReactiveElement {
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

  #editorView: EditorView | undefined = undefined;
  #lang = new Compartment();
  #tabSize = new Compartment();

  destroy = createCancelGroup();

  @property({ type: String })
  source = "";

  @property({ type: String })
  lang = MimeType.markdown;

  get editor(): EditorState | undefined {
    return this.#editorView?.state;
  }

  set editor(state: EditorState) {
    this.#editorView?.setState(state);
  }

  protected firstUpdated(changedProperties: PropertyValues): void {
    super.firstUpdated(changedProperties);
    // Set up skeleton
    // - #editor is managed by ProseMirror
    // - #reactive is rendered via Lit templates and driven by store updates
    render(html`<div id="editor" class="code-editor"></div>`, this.renderRoot);
    const editorRoot = this.renderRoot.querySelector("#editor") as HTMLElement;

    this.#editorView = createEditor({
      element: editorRoot,
      extensions: [
        this.#lang.of(defaultLang),
        this.#tabSize.of(EditorState.tabSize.of(4)),
      ],
    });
    this.destroy.add(() => this.#editorView?.destroy());
  }

  protected updated(changedProperties: PropertyValues): void {
    if (changedProperties.has("source")) {
      replaceSourceIfNeeded(this.#editorView!, this.source);
    }
    if (changedProperties.has("lang")) {
      const lang = getLangExtFromMimeType(this.lang);
      this.#editorView?.dispatch({
        effects: this.#lang.reconfigure(lang),
      });
    }
  }
}
