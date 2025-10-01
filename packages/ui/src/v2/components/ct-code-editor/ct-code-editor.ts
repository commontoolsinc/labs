import { html, PropertyValues } from "lit";
import { BaseElement } from "../../core/base-element.ts";
import { styles } from "./styles.ts";
import { basicSetup } from "codemirror";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { Compartment, EditorState, Extension } from "@codemirror/state";
import { indentUnit, LanguageSupport } from "@codemirror/language";
import { javascript as createJavaScript } from "@codemirror/lang-javascript";
import { markdown as createMarkdown } from "@codemirror/lang-markdown";
import { css as createCss } from "@codemirror/lang-css";
import { html as createHtml } from "@codemirror/lang-html";
import { json as createJson } from "@codemirror/lang-json";
import { oneDark } from "@codemirror/theme-one-dark";
import { Runtime } from "@commontools/runner";
import { ALL_CHARMS_ID } from "@commontools/charm";

import {
  acceptCompletion,
  autocompletion,
  Completion,
  CompletionContext,
  CompletionResult,
} from "@codemirror/autocomplete";
import {
  Decoration,
  DecorationSet,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import {
  type Cell,
  getEntityId,
  type JSONSchema,
  NAME,
  type Schema,
} from "@commontools/runner";
import { type InputTimingOptions } from "../../core/input-timing-controller.ts";
import { createStringCellController } from "../../core/cell-controller.ts";
import {
  Mentionable,
  MentionableArray,
  mentionableArraySchema,
} from "../../core/mentionable.ts";
import { consume } from "@lit/context";
import { MemorySpace } from "@commontools/runner";

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
 * @attr {Array} mentionable - Array of mentionable items with Charm structure for backlink autocomplete
 * @attr {Array} mentioned - Optional Cell of live Charms mentioned in content
 * @attr {boolean} wordWrap - Enable soft line wrapping (default: true)
 * @attr {boolean} lineNumbers - Show line numbers gutter (default: false)
 * @attr {number} maxLineWidth - Optional max line width in ch units
 *   (default: undefined)
 * @attr {number} tabSize - Tab size (spaces shown for a tab, default: 2)
 * @attr {boolean} tabIndent - Indent on Tab key (default: true)
 * @attr {"light"|"dark"} theme - Editor theme mode; "dark" enables oneDark.
 *
 * @fires ct-change - Fired when content changes with detail: { value, oldValue, language }
 * @fires ct-focus - Fired on focus
 * @fires ct-blur - Fired on blur
 * @fires backlink-click - Fired when a backlink is clicked with Cmd/Ctrl+Enter with detail: { text, charm }
 * @fires backlink-create - Fired when a novel backlink is activated (Cmd/Ctrl+Click)
 *   or confirmed with Enter during autocomplete with no matches. Detail:
 *   { text: string, charmId: any, charm: Cell<MentionableCharm>, navigate: boolean }
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
    mentionable: { type: Array },
    mentioned: { type: Array },
    pattern: { type: Object },
    // New editor configuration props
    wordWrap: { type: Boolean },
    lineNumbers: { type: Boolean },
    maxLineWidth: { type: Number },
    tabSize: { type: Number },
    tabIndent: { type: Boolean },
    theme: { type: String, reflect: true },
  };

  declare value: Cell<string> | string;
  declare language: MimeType;
  declare disabled: boolean;
  declare readonly: boolean;
  declare placeholder: string;
  declare timingStrategy: InputTimingOptions["strategy"];
  declare timingDelay: number;
  declare mentionable: Cell<MentionableArray>;
  declare mentioned?: Cell<MentionableArray>;
  declare pattern: Cell<string>;
  declare wordWrap: boolean;
  declare lineNumbers: boolean;
  declare maxLineWidth?: number;
  declare tabSize: number;
  declare tabIndent: boolean;
  declare theme: "light" | "dark";

  private _editorView: EditorView | undefined;
  private _lang = new Compartment();
  private _readonly = new Compartment();
  private _wrap = new Compartment();
  private _gutters = new Compartment();
  private _tabSizeComp = new Compartment();
  private _tabIndentComp = new Compartment();
  private _maxLineWidthComp = new Compartment();
  private _indentUnitComp = new Compartment();
  private _themeComp = new Compartment();
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
      // Keep $mentioned in sync with content changes
      this._updateMentionedFromContent();
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
    // Defaults for new props
    this.wordWrap = true;
    this.lineNumbers = false;
    this.maxLineWidth = undefined;
    this.tabSize = 2;
    this.tabIndent = true;
    this.theme = "light";
  }

  /**
   * Create a backlink completion source for [[backlinks]]
   */
  private createBacklinkCompletionSource() {
    return (context: CompletionContext): CompletionResult | null => {
      // Look for incomplete backlinks: [[ followed by optional text
      const backlink = context.matchBefore(/\[\[([^\]]*)?/);

      if (!backlink) {
        return null;
      }

      // Check what comes after the cursor
      const afterCursor = context.state.doc.sliceString(
        context.pos,
        context.pos + 2,
      );

      // Allow completion inside existing backlinks - we'll replace the content between [[ and ]]
      const query = backlink.text.slice(2); // Remove [[ prefix

      const mentionable = this.getFilteredMentionable(query);

      // Build options from existing mentionable items
      const options: Completion[] = mentionable.map((charm) => {
        const charmIdObj = getEntityId(charm);
        const charmId = charmIdObj?.["/"] || "";
        const charmName = charm.key(NAME).get() || "";
        const insertText = `${charmName} (${charmId})`;
        return {
          label: charmName,
          apply: afterCursor === "]]" ? insertText : insertText + "]]",
          type: "text",
          info: "Backlink to " + charmName,
        };
      });

      // Inject a "create new" option when the typed text doesn't exactly match
      // any existing charm. This ensures there's a selectable option for
      // keyboard users when creating a novel backlink.
      const raw = query.trim();
      if (raw.length > 0) {
        const lower = raw.toLowerCase();
        const hasExact = options.some((o) => o.label.toLowerCase() === lower);
        if (!hasExact) {
          options.push({
            label: raw,
            detail: "Create",
            type: "text",
            info: "Create new backlink",
            apply: () => {
              // Instantiate the pattern if available
              if (this.pattern) {
                this.createBacklinkFromPattern(raw, false);
              } else {
                this.emit("backlink-create", { text: raw, navigate: false });
              }
            },
          });
        }
      }

      if (options.length === 0) return null;

      return {
        from: backlink.from + 2, // Start after [[
        to: afterCursor === "]]" ? context.pos : undefined,
        options,
        validFor: /^[^\]]*$/,
      };
    };
  }

  /**
   * Get filtered mentionable items based on query
   */
  private getFilteredMentionable(query: string): Cell<Mentionable>[] {
    if (!this.mentionable) {
      return [];
    }

    const mentionableArray = this.mentionable.asSchema(mentionableArraySchema);
    const mentionableData = mentionableArray.get();

    if (!mentionableData || mentionableData.length === 0) {
      return [];
    }

    const queryLower = query.toLowerCase();
    const matches: Cell<Mentionable>[] = [];

    for (let i = 0; i < mentionableData.length; i++) {
      const mentionable = mentionableArray.key(i);
      const mention = mentionable.get();
      if (
        mention &&
        mentionable.key(NAME).get()
          ?.toLowerCase()
          ?.includes(queryLower)
      ) {
        matches.push(mentionable);
      }
    }

    return matches;
  }

  /**
   * Handle backlink clicks with Cmd/Ctrl+Click
   */
  private createBacklinkClickHandler() {
    return EditorView.domEventHandlers({
      click: (event, view) => {
        if (event.ctrlKey || event.metaKey) {
          return this.handleBacklinkActivation(view, event);
        }
        return false;
      },
    });
  }
  /**
   * Handle backlink activation (Cmd/Ctrl+Click on a backlink)
   */
  private handleBacklinkActivation(
    view: EditorView,
    event?: MouseEvent,
  ): boolean {
    const state = view.state;
    const pos = state.selection.main.head;
    const doc = state.doc;

    // Find backlinks around cursor position
    const lineStart = doc.lineAt(pos).from;
    const lineEnd = doc.lineAt(pos).to;
    const lineText = doc.sliceString(lineStart, lineEnd);

    // Find all [[...]] patterns in the line
    const backlinkRegex = /\[\[([^\]]+)\]\]/g;
    let match;

    while ((match = backlinkRegex.exec(lineText)) !== null) {
      const matchStart = lineStart + match.index;
      const matchEnd = matchStart + match[0].length;

      // Check if cursor is within this backlink
      if (pos >= matchStart && pos <= matchEnd) {
        const backlinkText = match[1];
        // Extract ID from "Name (id)" format
        const idMatch = backlinkText.match(/\(([^)]+)\)$/);
        const backlinkId = idMatch ? idMatch[1] : undefined;
        const charm = backlinkId ? this.findCharmById(backlinkId) : null;

        if (charm) {
          this.emit("backlink-click", {
            id: backlinkId,
            text: backlinkText,
            charm: charm,
          });
          return true;
        }

        // Instantiate the pattern and pass the ID so we can insert it into the text
        if (this.pattern) {
          this.createBacklinkFromPattern(backlinkText, true);
        }

        return true;
      }
    }

    return false;
  }

  /**
   * Create a backlink from pattern
   */
  private createBacklinkFromPattern(
    backlinkText: string,
    navigate: boolean,
  ): void {
    try {
      const rt = this.pattern.runtime;
      const tx = rt.edit();
      const spaceName = this.pattern.space;
      // ensure the cause is unique
      const result = rt.getCell<any>(
        spaceName,
        { note: this.value, title: backlinkText },
      );

      // parse + start the recipe + link the inputs
      const pattern = JSON.parse(this.pattern.get());
      const allCharms = rt.getCellFromEntityId(spaceName, {
        "/": ALL_CHARMS_ID,
      });
      rt.run(tx, pattern, {
        title: backlinkText,
        content: "",
        allCharms,
      }, result);

      // let the pattern know about the new backlink
      tx.commit();
      this.emit("backlink-create", {
        text: backlinkText,
        charmId: getEntityId(result),
        charm: result,
        navigate,
      });
    } catch (error) {
      console.error("Error creating backlink:", error);
    }
  }

  /**
   * If the cursor is after an unclosed [[... token on the same line,
   * return the current query text. Otherwise return null.
   */
  private _currentBacklinkQuery(view: EditorView): string | null {
    const pos = view.state.selection.main.head;
    const line = view.state.doc.lineAt(pos);
    const textBefore = view.state.doc.sliceString(line.from, pos);
    const m = textBefore.match(/\[\[([^\]]*)$/);
    if (!m) return null;
    return m[1] ?? "";
  }

  /**
   * Find a charm by ID in the mentionable list
   */
  private findCharmById(id: string): Cell<Mentionable> | null {
    if (!this.mentionable) return null;

    const mentionableArray = this.mentionable.asSchema(mentionableArraySchema);
    const mentionableData = mentionableArray.get();
    if (!mentionableData) return null;

    for (let i = 0; i < mentionableData.length; i++) {
      const charm = mentionableArray.key(i);
      if (charm) {
        // this is VERY specific
        // if you do `getEntityId(mentionableArray.key(i))` you'll get a different answer (the ID of the array itself)
        const charmIdObjA = getEntityId(mentionableArray.get()[i]);
        const charmIdObjB = getEntityId(mentionableArray.key(i));
        const charmIdA = charmIdObjA?.["/"] || "";
        const charmIdB = charmIdObjB?.["/"] || "";
        if (charmIdA === id || charmIdB === id) {
          return charm;
        }
      }
    }

    return null;
  }

  /**
   * Create a plugin to decorate backlinks with special styling
   */
  private createBacklinkDecorationPlugin() {
    const backlinkMark = Decoration.mark({ class: "cm-backlink" });

    return ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;

        constructor(view: EditorView) {
          this.decorations = this.getBacklinkDecorations(view);
        }

        update(update: ViewUpdate) {
          if (update.docChanged || update.viewportChanged) {
            this.decorations = this.getBacklinkDecorations(update.view);
          }
        }

        getBacklinkDecorations(view: EditorView) {
          const decorations = [];
          const doc = view.state.doc;
          const backlinkRegex = /\[\[([^\]]+)\]\]/g;

          for (const { from, to } of view.visibleRanges) {
            for (let pos = from; pos <= to;) {
              const line = doc.lineAt(pos);
              const text = line.text;
              let match;

              backlinkRegex.lastIndex = 0; // Reset regex
              while ((match = backlinkRegex.exec(text)) !== null) {
                const start = line.from + match.index;
                const end = start + match[0].length;

                // Only decorate if within visible range
                if (start >= from && end <= to) {
                  decorations.push(backlinkMark.range(start, end));
                }
              }

              pos = line.to + 1;
            }
          }

          return Decoration.set(decorations);
        }
      },
      {
        decorations: (v) => v.decorations,
      },
    );
  }

  private getValue(): string {
    return this._cellController.getValue();
  }

  private setValue(newValue: string): void {
    this._cellController.setValue(newValue);
  }

  override connectedCallback() {
    super.connectedCallback();
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
    // Ensure mentioned charms reflect external value changes
    this._updateMentionedFromContent();
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

  /**
   * Subscribe to mentionable changes to re-resolve mentioned charms when
   * the source list updates.
   */
  private _setupMentionableSyncHandler(): void {
    if (!this.mentionable) return;
    const unsubscribe = this.mentionable.asSchema(mentionableArraySchema).sink(
      () => {
        this._updateMentionedFromContent();
      },
    );
    this._cleanupFns.push(unsubscribe);
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

    // Update word wrap
    if (changedProperties.has("wordWrap") && this._editorView) {
      this._editorView.dispatch({
        effects: this._wrap.reconfigure(
          this.wordWrap ? EditorView.lineWrapping : [],
        ),
      });
    }

    // Update line numbers visibility (hide gutters when false)
    if (changedProperties.has("lineNumbers") && this._editorView) {
      const hideGutters = !this.lineNumbers;
      const ext = hideGutters
        ? EditorView.theme({
          ".cm-gutters": { display: "none" },
          ".cm-content": { paddingLeft: "0px" },
        })
        : [] as unknown as Extension;
      this._editorView.dispatch({
        effects: this._gutters.reconfigure(ext),
      });
    }

    // Update tab size
    if (changedProperties.has("tabSize") && this._editorView) {
      const size = this.tabSize ?? 2;
      this._editorView.dispatch({
        effects: [
          this._tabSizeComp.reconfigure(EditorState.tabSize.of(size)),
          this._indentUnitComp.reconfigure(indentUnit.of(" ".repeat(size))),
        ],
      });
    }

    // Update tab indent keymap
    if (changedProperties.has("tabIndent") && this._editorView) {
      const ext = this.tabIndent ? keymap.of([indentWithTab]) : [];
      this._editorView.dispatch({
        effects: this._tabIndentComp.reconfigure(ext),
      });
    }

    // Update max line width theme
    if (changedProperties.has("maxLineWidth") && this._editorView) {
      const n = this.maxLineWidth;
      const ext = typeof n === "number" && n > 0
        ? EditorView.theme({
          ".cm-content": { maxWidth: `${n}ch` },
        })
        : [] as unknown as Extension;
      this._editorView.dispatch({
        effects: this._maxLineWidthComp.reconfigure(ext),
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

    // Update theme plugin
    if (changedProperties.has("theme") && this._editorView) {
      this._editorView.dispatch({
        effects: this._themeComp.reconfigure(
          this.theme === "dark" ? oneDark : [],
        ),
      });
    }

    // Re-subscribe if mentionable cell reference changes
    if (changedProperties.has("mentionable")) {
      this._setupMentionableSyncHandler();
      this._updateMentionedFromContent();
    }

    // If `$mentioned` binding changes, push current state immediately
    if (changedProperties.has("mentioned")) {
      this._updateMentionedFromContent();
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

    // Set up mentionable sync handler and initialize mentioned list
    this._setupMentionableSyncHandler();
    this._updateMentionedFromContent();
  }

  private _initializeEditor(): void {
    const editorElement = this.shadowRoot?.querySelector(
      ".code-editor",
    ) as HTMLElement;
    if (!editorElement) return;

    // Create editor extensions
    const extensions: Extension[] = [
      basicSetup,
      // Tab indentation keymap (toggleable)
      this._tabIndentComp.of(this.tabIndent ? keymap.of([indentWithTab]) : []),
      this._lang.of(getLangExtFromMimeType(this.language)),
      this._readonly.of(EditorState.readOnly.of(this.readonly)),
      // Word wrapping
      this._wrap.of(this.wordWrap ? EditorView.lineWrapping : []),
      // Hide gutters when line numbers are disabled
      this._gutters.of(
        !this.lineNumbers
          ? EditorView.theme({
            ".cm-gutters": { display: "none" },
            ".cm-content": { paddingLeft: "0px" },
          })
          : [] as unknown as Extension,
      ),
      // Tab size
      this._tabSizeComp.of(EditorState.tabSize.of(this.tabSize ?? 2)),
      this._indentUnitComp.of(
        indentUnit.of(" ".repeat(this.tabSize ?? 2)),
      ),
      // Optional max line width (in ch)
      this._maxLineWidthComp.of(
        typeof this.maxLineWidth === "number" && this.maxLineWidth > 0
          ? EditorView.theme({
            ".cm-content": { maxWidth: `${this.maxLineWidth}ch` },
          })
          : [] as unknown as Extension,
      ),
      // Theme (dark -> oneDark)
      this._themeComp.of(this.theme === "dark" ? oneDark : []),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !this.readonly) {
          const value = update.state.doc.toString();
          this.setValue(value);
          // Keep $mentioned current as user types
          this._updateMentionedFromContent();
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
      // Add backlink click handler for Cmd/Ctrl+Click
      this.createBacklinkClickHandler(),
      // Add backlink decoration plugin to visually style [[backlinks]]
      this.createBacklinkDecorationPlugin(),
      // Add autocompletion with backlink support
      autocompletion({
        override: [this.createBacklinkCompletionSource()],
        activateOnTyping: true,
        closeOnBlur: true,
      }),
      // Enter: accept selected completion, or create novel backlink
      keymap.of([{
        key: "Enter",
        run: (view) => {
          // Try accepting an active completion first
          if (acceptCompletion(view)) return true;

          // If typing a backlink with no matches, create new backlink
          const query = this._currentBacklinkQuery(view);
          if (query != null) {
            const matches = this.getFilteredMentionable(query);
            if (matches.length === 0) {
              const text = query.trim();
              if (text.length > 0) {
                // Instantiate the pattern if available
                if (this.pattern) {
                  this.createBacklinkFromPattern(text, false);
                } else {
                  this.emit("backlink-create", { text, navigate: false });
                }
                return true;
              }
            }
          }

          return false;
        },
      }]),
      // Intercept Cmd/Ctrl+S when editor is focused
      keymap.of([{
        key: "Mod-s",
        run: () => {
          console.log("[ct-code-editor] Intercepted save (Cmd/Ctrl+S).");
          return true; // prevent default browser save
        },
      }]),
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

  /**
   * Extract mentioned charms from current content and write to `$mentioned`.
   *
   * Link syntax: [[Name (id)]]. We parse ids and resolve them against
   * `$mentionable` to produce live Charm instances.
   */
  private _updateMentionedFromContent(): void {
    if (!this.mentioned) return;

    const content = this.getValue() || "";
    const newMentioned = this._extractMentionedCharms(content);

    // Compare by id set to avoid unnecessary writes
    const current = this.mentioned.asSchema(mentionableArraySchema).get() || [];
    const curIds = new Set(
      current.map((c) => getEntityId(c)?.["/"]).filter(Boolean),
    );
    const newIds = new Set(
      newMentioned.map((c) => getEntityId(c)?.["/"]).filter(Boolean),
    );

    if (curIds.size === newIds.size) {
      let same = true;
      for (const id of newIds) {
        if (!curIds.has(id)) {
          same = false;
          break;
        }
      }
      if (same) return; // No change
    }

    const tx = this.mentioned.runtime.edit();
    this.mentioned.withTx(tx).set(newMentioned);
    tx.commit();
  }

  /**
   * Parse content to a list of unique Charms referenced by [[...]] links.
   */
  private _extractMentionedCharms(content: string): Mentionable[] {
    if (!content || !this.mentionable) return [];

    const ids: string[] = [];
    const regex = /\[\[[^\]]*?\(([^)]+)\)\]\]/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      const id = match[1];
      if (id) ids.push(id);
    }

    // Resolve unique ids to charms using mentionable list
    const seen = new Set<string>();
    const result: Mentionable[] = [];
    for (const id of ids) {
      if (seen.has(id)) continue;
      const charm = this.findCharmById(id);
      if (charm) {
        result.push(charm.get());
        seen.add(id);
      }
    }
    return result;
  }
}

globalThis.customElements.define("ct-code-editor", CTCodeEditor);
