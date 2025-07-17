import { html, PropertyValues } from "lit";
import { BaseElement } from "../../core/base-element.ts";
import { styles } from "./styles.ts";
import { basicSetup } from "codemirror";
import { EditorView, placeholder } from "@codemirror/view";
import { Compartment, EditorState, Extension } from "@codemirror/state";
import { LanguageSupport } from "@codemirror/language";
import { javascript as createJavaScript } from "@codemirror/lang-javascript";
import { markdown as createMarkdown } from "@codemirror/lang-markdown";
import { css as createCss } from "@codemirror/lang-css";
import { html as createHtml } from "@codemirror/lang-html";
import { json as createJson } from "@codemirror/lang-json";
import { oneDark } from "@codemirror/theme-one-dark";
import { type Cell, isCell } from "@commontools/runner";
import {
  InputTimingController,
  type InputTimingOptions,
} from "../../core/input-timing-controller.ts";

/**
 * Supported MIME types for syntax highlighting
 */
export const MimeType = Object.freeze(
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

// Language registry
const langRegistry = new Map<MimeType, LanguageSupport>();
const markdownLang = createMarkdown({
  defaultCodeLanguage: createJavaScript({ jsx: true }),
});
const defaultLang = markdownLang;

langRegistry.set(MimeType.javascript, createJavaScript());
langRegistry.set(MimeType.jsx, createJavaScript({ jsx: true }));
langRegistry.set(
  MimeType.typescript,
  createJavaScript({ jsx: true, typescript: true }),
);
langRegistry.set(MimeType.css, createCss());
langRegistry.set(MimeType.html, createHtml());
langRegistry.set(MimeType.markdown, markdownLang);
langRegistry.set(MimeType.json, createJson());

const getLangExtFromMimeType = (mime: MimeType) => {
  return langRegistry.get(mime) ?? defaultLang;
};

/**
 * CTCodeEditor - Code editor component with syntax highlighting and debounced changes
 *
 * @element ct-code-editor
 *
 * @attr {string|Cell<string>} value - Editor content (supports both plain string and Cell<string>)
 * @attr {string} language - MIME type for syntax highlighting
 * @attr {boolean} disabled - Whether the editor is disabled
 * @attr {boolean} readonly - Whether the editor is read-only
 * @attr {string} placeholder - Placeholder text when empty
 * @attr {string} timingStrategy - Input timing strategy: "immediate" | "debounce" | "throttle" | "blur"
 * @attr {number} timingDelay - Delay in milliseconds for debounce/throttle (default: 500)
 *
 * @fires ct-change - Fired when content changes with detail: { value, oldValue, language }
 * @fires ct-focus - Fired on focus
 * @fires ct-blur - Fired on blur
 *
 * @example
 * <ct-code-editor language="text/javascript" placeholder="Enter code..."></ct-code-editor>
 */
export class CTCodeEditor extends BaseElement {
  static override styles = [BaseElement.baseStyles, styles];

  static override properties = {
    value: { type: String },
    language: { type: String },
    disabled: { type: Boolean },
    readonly: { type: Boolean },
    placeholder: { type: String },
    timingStrategy: { type: String },
    timingDelay: { type: Number },
  };

  declare value: Cell<string> | string;
  declare language: MimeType;
  declare disabled: boolean;
  declare readonly: boolean;
  declare placeholder: string;
  declare timingStrategy: InputTimingOptions["strategy"];
  declare timingDelay: number;

  private _editorView: EditorView | undefined;
  private _lang = new Compartment();
  private _readonly = new Compartment();
  private _inputTiming: InputTimingController;
  private _cellUnsubscribe: (() => void) | null = null;
  private _cleanupFns: Array<() => void> = [];

  constructor() {
    super();
    this.value = "";
    this.language = MimeType.markdown;
    this.disabled = false;
    this.readonly = false;
    this.placeholder = "";
    this.timingStrategy = "debounce";
    this.timingDelay = 500;

    // Initialize input timing controller
    this._inputTiming = new InputTimingController(this, {
      strategy: this.timingStrategy,
      delay: this.timingDelay,
    });
  }

  private getValue(): string {
    if (isCell(this.value)) {
      return this.value.get?.() || "";
    }
    return this.value || "";
  }

  private setValue(newValue: string): void {
    const oldValue = this.getValue();

    this._inputTiming.schedule(() => {
      if (isCell(this.value)) {
        const tx = this.value.runtime.edit();
        this.value.withTx(tx).set(newValue);
        tx.commit();
      } else {
        this.value = newValue;
      }

      // Emit the value change event after the value is actually set
      this.emit("ct-change", {
        value: newValue,
        oldValue,
        language: this.language,
      });
    });
  }

  override connectedCallback() {
    super.connectedCallback();
    this._setupCellSubscription();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._cleanup();
  }

  private _setupCellSubscription(): void {
    if (isCell(this.value)) {
      // Subscribe to cell changes
      this._cellUnsubscribe = this.value.sink(() => {
        // Update editor content when cell value changes externally
        if (this._editorView) {
          const newValue = this.getValue();
          const currentValue = this._editorView.state.doc.toString();
          if (newValue !== currentValue) {
            this._editorView.dispatch({
              changes: {
                from: 0,
                to: this._editorView.state.doc.length,
                insert: newValue,
              },
            });
          }
        }
      });
    }
  }

  private _cleanupCellSubscription(): void {
    if (this._cellUnsubscribe) {
      this._cellUnsubscribe();
      this._cellUnsubscribe = null;
    }
  }

  private _cleanup(): void {
    this._cleanupCellSubscription();
    this._cleanupFns.forEach((fn) => fn());
    this._cleanupFns = [];
    if (this._editorView) {
      this._editorView.destroy();
      this._editorView = undefined;
    }
  }

  override updated(changedProperties: Map<string, any>) {
    super.updated(changedProperties);

    // If the value property itself changed (e.g., switched to a different cell)
    if (changedProperties.has("value")) {
      this._cleanupCellSubscription();
      this._setupCellSubscription();
      // Update editor content
      if (this._editorView) {
        const newValue = this.getValue();
        const currentValue = this._editorView.state.doc.toString();
        if (newValue !== currentValue) {
          this._editorView.dispatch({
            changes: {
              from: 0,
              to: this._editorView.state.doc.length,
              insert: newValue,
            },
          });
        }
      }
    }

    // Update language
    if (changedProperties.has("language") && this._editorView) {
      const lang = getLangExtFromMimeType(this.language);
      this._editorView.dispatch({
        effects: this._lang.reconfigure(lang),
      });
    }

    // Update readonly state
    if (changedProperties.has("readonly") && this._editorView) {
      this._editorView.dispatch({
        effects: this._readonly.reconfigure(
          EditorState.readOnly.of(this.readonly),
        ),
      });
    }

    // Update timing controller if timing options changed
    if (
      changedProperties.has("timingStrategy") ||
      changedProperties.has("timingDelay")
    ) {
      this._inputTiming.updateOptions({
        strategy: this.timingStrategy,
        delay: this.timingDelay,
      });
    }
  }

  protected override firstUpdated(_changedProperties: PropertyValues): void {
    super.firstUpdated(_changedProperties);
    this._initializeEditor();
  }

  private _initializeEditor(): void {
    const editorElement = this.shadowRoot?.querySelector(
      ".code-editor",
    ) as HTMLElement;
    if (!editorElement) return;

    // Create editor extensions
    const extensions: Extension[] = [
      basicSetup,
      oneDark,
      this._lang.of(getLangExtFromMimeType(this.language)),
      this._readonly.of(EditorState.readOnly.of(this.readonly)),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !this.readonly) {
          const value = update.state.doc.toString();
          this.setValue(value);
        }
      }),
      // Handle focus/blur events
      EditorView.domEventHandlers({
        focus: () => {
          this._inputTiming.onFocus();
          this.emit("ct-focus");
          return false;
        },
        blur: () => {
          this._inputTiming.onBlur();
          this.emit("ct-blur");
          return false;
        },
      }),
    ];

    // Add placeholder extension if specified
    if (this.placeholder) {
      extensions.push(placeholder(this.placeholder));
    }

    // Create editor state
    const state = EditorState.create({
      doc: this.getValue(),
      extensions,
    });

    // Create editor view
    this._editorView = new EditorView({
      state,
      parent: editorElement,
    });
  }

  override render() {
    return html`
      <div class="code-editor"></div>
    `;
  }

  /**
   * Focus the editor programmatically
   */
  override focus(): void {
    this._editorView?.focus();
  }

  /**
   * Get the current editor state
   */
  get editorState(): EditorState | undefined {
    return this._editorView?.state;
  }

  /**
   * Get the editor view instance
   */
  get editorView(): EditorView | undefined {
    return this._editorView;
  }
}

