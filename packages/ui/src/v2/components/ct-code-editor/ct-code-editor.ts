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
import { type Cell } from "@commontools/runner";
import { type InputTimingOptions } from "../../core/input-timing-controller.ts";
import { createStringCellController } from "../../core/cell-controller.ts";

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
  private _cleanupFns: Array<() => void> = [];
  private _cellController = createStringCellController(this, {
    timing: {
      strategy: "debounce",
      delay: 500,
    },
    onChange: (newValue: string, oldValue: string) => {
      this.emit("ct-change", {
        value: newValue,
        oldValue,
        language: this.language,
      });
    },
  });

  constructor() {
    super();
    this.value = "";
    this.language = MimeType.markdown;
    this.disabled = false;
    this.readonly = false;
    this.placeholder = "";
    this.timingStrategy = "debounce";
    this.timingDelay = 500;
  }

  private getValue(): string {
    return this._cellController.getValue();
  }

  private setValue(newValue: string): void {
    this._cellController.setValue(newValue);
  }

  override connectedCallback() {
    super.connectedCallback();
    // CellController handles subscription automatically via ReactiveController
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._cleanup();
  }

  private _updateEditorFromCellValue(): void {
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
  }

  private _setupCellSyncHandler(): void {
    // Create a custom Cell sync handler that integrates with the CellController
    // but provides the special CodeMirror synchronization logic
    const originalTriggerUpdate = this._cellController["options"].triggerUpdate;

    // Override the CellController's update mechanism to include CodeMirror sync
    this._cellController["options"].triggerUpdate = false; // Disable default updates

    // Set up our own Cell subscription that calls both update methods
    if (this._cellController.isCell()) {
      const cell = this._cellController.getCell();
      if (cell) {
        const unsubscribe = cell.sink(() => {
          // First update the editor content
          this._updateEditorFromCellValue();
          // Then trigger component update if originally enabled
          if (originalTriggerUpdate) {
            this.requestUpdate();
          }
        });
        this._cleanupFns.push(unsubscribe);
      }
    }
  }

  private _cleanup(): void {
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
      this._cellController.bind(this.value);
      this._updateEditorFromCellValue();
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
      this._cellController.updateTimingOptions({
        strategy: this.timingStrategy,
        delay: this.timingDelay,
      });
    }
  }

  protected override firstUpdated(_changedProperties: PropertyValues): void {
    super.firstUpdated(_changedProperties);
    this._initializeEditor();

    // Bind the initial value to the cell controller
    this._cellController.bind(this.value);

    // Update timing options to match current properties
    this._cellController.updateTimingOptions({
      strategy: this.timingStrategy,
      delay: this.timingDelay,
    });

    // Set up custom cell sync handler for CodeMirror
    this._setupCellSyncHandler();
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
          this._cellController.onFocus();
          this.emit("ct-focus");
          return false;
        },
        blur: () => {
          this._cellController.onBlur();
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

globalThis.customElements.define("ct-code-editor", CTCodeEditor);
