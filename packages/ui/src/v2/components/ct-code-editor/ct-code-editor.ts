import { html, PropertyValues } from "lit";
import { BaseElement } from "../../core/base-element.ts";
import { styles } from "./styles.ts";
import { basicSetup } from "codemirror";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import {
  Annotation,
  Compartment,
  EditorState,
  Extension,
  Prec,
  Range,
  StateField,
} from "@codemirror/state";
import { indentUnit, LanguageSupport } from "@codemirror/language";
import { javascript as createJavaScript } from "@codemirror/lang-javascript";
import { markdown as createMarkdown } from "@codemirror/lang-markdown";
import { css as createCss } from "@codemirror/lang-css";
import { html as createHtml } from "@codemirror/lang-html";
import { json as createJson } from "@codemirror/lang-json";
import { oneDark } from "@codemirror/theme-one-dark";

import {
  autocompletion,
  Completion,
  CompletionContext,
  CompletionResult,
  completionStatus,
  startCompletion,
} from "@codemirror/autocomplete";
import {
  Decoration,
  DecorationSet,
  ViewPlugin,
  ViewUpdate,
} from "@codemirror/view";
import {
  type CellHandle,
  isCellHandle,
  NAME,
} from "@commontools/runtime-client";
import { type InputTimingOptions } from "../../core/input-timing-controller.ts";
import { createStringCellController } from "../../core/cell-controller.ts";
import {
  Mentionable,
  MentionableArray,
  MentionableArraySchema,
} from "../../core/mentionable.ts";

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
 * Represents a parsed backlink with position and content info
 */
interface BacklinkInfo {
  from: number; // Start of [[
  to: number; // End of ]]
  nameFrom: number; // Start of name (after [[)
  nameTo: number; // End of name (before " (id)" or "]]")
  id: string; // The charm ID (empty string if incomplete)
  name: string; // The display name text
}

/**
 * Parse all backlinks from a document string
 */
function parseBacklinks(doc: string): BacklinkInfo[] {
  const backlinks: BacklinkInfo[] = [];
  const backlinkRegex = /\[\[([^\]]+)\]\]/g;
  let match;

  while ((match = backlinkRegex.exec(doc)) !== null) {
    const from = match.index;
    const to = from + match[0].length;
    const innerText = match[1];

    // Parse: check if has ID in format "Name (id)"
    const idMatch = innerText.match(/^(.+?)\s+\(([^)]+)\)$/);
    const hasId = idMatch !== null;
    const name = hasId ? idMatch[1] : innerText;
    const id = hasId ? idMatch[2] : "";

    const nameFrom = from + 2; // After [[
    const nameTo = nameFrom + name.length;

    backlinks.push({ from, to, nameFrom, nameTo, id, name });
  }

  return backlinks;
}

/**
 * StateField to track all backlink positions in the document.
 * Updated whenever the document changes.
 */
const backlinkField = StateField.define<BacklinkInfo[]>({
  create(state) {
    return parseBacklinks(state.doc.toString());
  },
  update(value, tr) {
    if (!tr.docChanged) return value;
    return parseBacklinks(tr.newDoc.toString());
  },
});

/**
 * Create atomic ranges that make cursor skip over [[ and (id)]] portions.
 * This prevents the cursor from entering the ID area during navigation.
 * Note: We must ensure ranges don't span line breaks.
 */
const atomicBacklinkRanges = EditorView.atomicRanges.of((view) => {
  const backlinks = view.state.field(backlinkField);
  const doc = view.state.doc;
  const decorations: Range<Decoration>[] = [];

  for (const bl of backlinks) {
    if (!bl.id) continue; // Only protect complete backlinks with IDs

    // Safety: ensure the backlink is on a single line
    const startLine = doc.lineAt(bl.from).number;
    const endLine = doc.lineAt(bl.to).number;
    if (startLine !== endLine) continue; // Skip multi-line backlinks

    // Make [[ atomic (cursor skips from before [[ to after [[)
    if (bl.from < bl.nameFrom) {
      decorations.push(Decoration.mark({}).range(bl.from, bl.nameFrom));
    }

    // Make " (id)]]" atomic (cursor skips from end of name to after ]])
    if (bl.nameTo < bl.to) {
      decorations.push(Decoration.mark({}).range(bl.nameTo, bl.to));
    }
  }

  decorations.sort((a, b) => a.from - b.from);
  return Decoration.set(decorations);
});

/**
 * Transaction filter to prevent edits from corrupting the ID portion of backlinks.
 * - Blocks edits that start within the ID portion
 * - Truncates edits that span from name into ID
 * - Allows full backlink deletions
 */
const backlinkEditFilter = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged) return tr;

  const backlinks = tr.startState.field(backlinkField);
  if (backlinks.length === 0) return tr;

  let needsModification = false;

  // Check each change to see if it affects any backlink's protected area
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, _inserted) => {
    for (const bl of backlinks) {
      if (!bl.id) continue; // Only protect complete backlinks

      // Case: Edit starts in the ID portion " (id)]]" - block it
      if (fromA > bl.nameTo && fromA < bl.to) {
        needsModification = true;
        return;
      }

      // Case: Edit spans from name into ID - needs truncation
      if (fromA <= bl.nameTo && toA > bl.nameTo && toA < bl.to) {
        needsModification = true;
        return;
      }
    }
  });

  // If we detected a problematic edit, we need to filter/modify the transaction
  // For now, we'll rely on atomicRanges to prevent cursor entry,
  // and handle edge cases like paste operations here
  if (needsModification) {
    // Build a modified changes array that respects backlink boundaries
    const specs: { from: number; to: number; insert: string }[] = [];
    let blocked = false;

    tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      const adjustedFrom = fromA;
      let adjustedTo = toA;
      let shouldInclude = true;

      for (const bl of backlinks) {
        if (!bl.id) continue;

        // Block edits that start in ID area
        if (fromA > bl.nameTo && fromA < bl.to) {
          shouldInclude = false;
          blocked = true;
          break;
        }

        // Truncate edits that span into ID area
        if (fromA <= bl.nameTo && toA > bl.nameTo && toA < bl.to) {
          adjustedTo = bl.nameTo;
        }
      }

      if (shouldInclude) {
        specs.push({
          from: adjustedFrom,
          to: adjustedTo,
          insert: inserted.toString(),
        });
      }
    });

    if (blocked) {
      // Return a modified transaction with adjusted changes
      return {
        changes: specs,
        selection: tr.selection,
        effects: tr.effects,
      };
    }
  }

  return tr;
});

/**
 * CTCodeEditor - Code editor component with syntax highlighting and debounced changes
 *
 * @element ct-code-editor
 *
 * @attr {string|CellHandle<string>} value - Editor content (supports both plain string and CellHandle<string>)
 * @attr {string} language - MIME type for syntax highlighting
 * @attr {boolean} disabled - Whether the editor is disabled
 * @attr {boolean} readonly - Whether the editor is read-only
 * @attr {string} placeholder - Placeholder text when empty
 * @attr {string} timingStrategy - Input timing strategy: "immediate" | "debounce" | "throttle" | "blur"
 * @attr {number} timingDelay - Delay in milliseconds for debounce/throttle (default: 500)
 * @attr {CellHandle<MentionableArray>} mentionable - Cell of mentionable items for @/@[[ completion
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
    mentionable: { type: Object },
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

  declare value: CellHandle<string> | string;
  declare language: MimeType;
  declare disabled: boolean;
  declare readonly: boolean;
  declare placeholder: string;
  declare timingStrategy: InputTimingOptions["strategy"];
  declare timingDelay: number;
  /**
   * Mentionable items for @ completion.
   */
  declare mentionable?: CellHandle<MentionableArray> | null;
  declare mentioned?: CellHandle<MentionableArray>;
  declare pattern: CellHandle<string>;
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
  private _mentionableUnsub: (() => void) | null = null;
  private _mentionedUnsub: (() => void) | null = null;
  // Track previous backlink names to detect changes for syncing to charm NAME
  private _previousBacklinkNames = new Map<string, string>();
  // Track subscriptions to charm NAME cells for bidirectional sync
  private _charmNameSubscriptions = new Map<string, () => void>();

  // Transaction annotation to mark Cell-originated updates.
  // This is the idiomatic CodeMirror 6 way to distinguish programmatic
  // changes from user input. The updateListener checks this annotation
  // and skips setValue for Cell-originated changes, preventing the
  // feedback loop: Cell → Editor → updateListener → setValue → Cell...
  private static _cellSyncAnnotation = Annotation.define<boolean>();

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
    this.mentionable = null;
  }

  /**
   * Create a backlink completion source for [[backlinks]]
   * The dropdown stays open as long as cursor is inside [[...
   */
  private createBacklinkCompletionSource() {
    return (context: CompletionContext): CompletionResult | null => {
      // Look for incomplete backlinks: [[ followed by optional text (not yet closed)
      const backlink = context.matchBefore(/\[\[([^\]]*)?/);

      if (!backlink) {
        return null;
      }

      // Check if this is already a complete backlink WITH an ID (not just auto-closed brackets)
      // Pattern: [[Name (id)]] - if there's an ID, don't show dropdown
      const afterCursor = context.state.doc.sliceString(
        context.pos,
        context.pos + 50, // Look ahead for potential ]] and ID pattern
      );
      const hasIdPattern = afterCursor.match(/^\s*\([^)]+\)\]\]/);
      if (hasIdPattern) {
        // This is a complete backlink with ID - don't show dropdown
        return null;
      }

      const query = backlink.text.slice(2); // Remove [[ prefix

      const mentionable = this.getFilteredMentionable(query);

      // Check if auto-close added ]] after cursor
      const hasAutoCloseBrackets = afterCursor.startsWith("]]");

      // Build options from existing mentionable items
      const options: Completion[] = mentionable.map((charm) => {
        const charmId = charm.id();
        const charmName = charm.key(NAME).get() || "";
        const insertText = `${charmName} (${charmId})`;
        return {
          label: charmName,
          // Use apply function to handle auto-closed brackets
          apply: (view, _completion, from, to) => {
            // If auto-close added ]], extend replacement to include them
            const replaceTo = hasAutoCloseBrackets ? to + 2 : to;
            view.dispatch({
              changes: { from, to: replaceTo, insert: insertText + "]]" },
              selection: { anchor: from + insertText.length + 2 },
            });
          },
          type: "text",
          info: "Link to " + charmName,
        };
      });

      // Only show existing charms - no "Create" option
      // Enter will complete with exact match or create new charm
      return {
        from: backlink.from + 2, // Start after [[ (original behavior)
        options,
      };
    };
  }

  /**
   * Get filtered mentionable items based on query
   */
  private getFilteredMentionable(query: string): CellHandle<Mentionable>[] {
    if (!this.mentionable) {
      return [];
    }

    const rawMentionable = this.mentionable.get();
    const mentionableData = Array.isArray(rawMentionable)
      ? rawMentionable as MentionableArray
      : isCellHandle(rawMentionable)
      ? ((rawMentionable.get() ?? []) as MentionableArray)
      : [];

    if (mentionableData.length === 0) {
      return [];
    }

    const queryLower = query.toLowerCase();
    const matches: CellHandle<Mentionable>[] = [];

    for (let i = 0; i < mentionableData.length; i++) {
      const mention = mentionableData[i];
      if (
        mention &&
        mention[NAME]
          ?.toLowerCase()
          ?.includes(queryLower)
      ) {
        matches.push(this.mentionable.key(i) as CellHandle<Mentionable>);
      }
    }

    return matches;
  }

  /**
   * Find exact case-insensitive match in mentionable items
   */
  private _findExactMentionable(query: string): CellHandle<Mentionable> | null {
    if (!this.mentionable) return null;

    const rawMentionable = this.mentionable.get();
    const mentionableData = Array.isArray(rawMentionable)
      ? rawMentionable as MentionableArray
      : isCellHandle(rawMentionable)
      ? ((rawMentionable.get() ?? []) as MentionableArray)
      : [];

    const queryLower = query.toLowerCase();

    for (let i = 0; i < mentionableData.length; i++) {
      const mention = mentionableData[i];
      const name = mention?.[NAME] ?? "";
      if (name.toLowerCase() === queryLower) {
        return this.mentionable.key(i);
      }
    }

    return null;
  }

  /**
   * Complete a backlink by inserting the full [[Name (id)]] format
   */
  private _completeBacklinkWithId(
    view: EditorView,
    _queryText: string,
    charmName: string,
    charmId: string,
  ): void {
    // Find the [[ start position
    const pos = view.state.selection.main.head;
    const doc = view.state.doc.toString();
    const beforeCursor = doc.slice(0, pos);
    const bracketPos = beforeCursor.lastIndexOf("[[");

    if (bracketPos === -1) return;

    // Check if there are auto-closed brackets after cursor
    const afterCursor = doc.slice(pos, pos + 2);
    const hasAutoClose = afterCursor === "]]";

    // Build the complete backlink
    const fullBacklink = `[[${charmName} (${charmId})]]`;

    // Calculate replacement range
    const replaceFrom = bracketPos;
    const replaceTo = hasAutoClose ? pos + 2 : pos;

    view.dispatch({
      changes: { from: replaceFrom, to: replaceTo, insert: fullBacklink },
      selection: { anchor: replaceFrom + fullBacklink.length },
    });
  }

  /**
   * Complete a backlink as pending (just [[text]] without ID)
   */
  private _completeBacklinkText(view: EditorView): void {
    const pos = view.state.selection.main.head;
    const afterCursor = view.state.doc.sliceString(pos, pos + 2);

    if (afterCursor === "]]") {
      // Already has closing brackets - just move cursor past them
      view.dispatch({
        selection: { anchor: pos + 2 },
      });
    } else {
      // Insert ]] to complete the backlink
      view.dispatch({
        changes: { from: pos, to: pos, insert: "]]" },
        selection: { anchor: pos + 2 },
      });
    }
  }

  /**
   * Handle backlink clicks:
   * - Click on pill: navigate to linked charm
   * - Click when expanded (editing mode): places cursor normally
   */
  private createBacklinkClickHandler() {
    return EditorView.domEventHandlers({
      mousedown: (event, view) => {
        // Check if clicking on a collapsed pill (cm-backlink-pill)
        const target = event.target as HTMLElement;
        if (target.closest(".cm-backlink-pill")) {
          // Navigate to the backlink
          event.preventDefault();
          setTimeout(() => this.handlePillClick(view, event), 0);
          return true;
        }
        return false;
      },
    });
  }

  /**
   * Handle click on a collapsed backlink pill - navigate to the linked charm
   */
  private async handlePillClick(
    view: EditorView,
    event: MouseEvent,
  ): Promise<void> {
    // Get the position in the document from the click coordinates
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos === null) return;

    const doc = view.state.doc;
    const line = doc.lineAt(pos);
    const lineText = line.text;

    // Find all backlinks on this line
    const backlinkRegex = /\[\[([^\]]+)\]\]/g;
    let match;

    while ((match = backlinkRegex.exec(lineText)) !== null) {
      const matchStart = line.from + match.index;
      const _matchEnd = matchStart + match[0].length;
      const innerText = match[1];

      // Check if has ID
      const idMatch = innerText.match(/^(.+?)\s+\(([^)]+)\)$/);
      if (!idMatch) continue; // Skip incomplete backlinks

      const name = idMatch[1];
      const id = idMatch[2];
      const nameStart = matchStart + 2; // After [[
      const nameEnd = nameStart + name.length;

      // Check if click position is within the name portion (the visible pill)
      if (pos >= nameStart && pos <= nameEnd) {
        const runtime = this.pattern.runtime();
        const space = this.pattern.space();

        const cell = await runtime.getCell(space, id);
        this.emit("backlink-click", {
          id,
          text: innerText,
          charm: cell,
        });
        return;
      }
    }
  }
  /**
   * Handle backlink activation (Cmd/Ctrl+Click on a backlink)
   */
  private handleBacklinkActivation(
    view: EditorView,
    _event?: MouseEvent,
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
            charm,
          });
          return true;
        }

        // Only create new backlink if there's NO ID (text-only like [[Name]])
        if (!backlinkId && this.pattern) {
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
  private async createBacklinkFromPattern(
    backlinkText: string,
    navigate: boolean,
  ): Promise<void> {
    try {
      // Simple random ID generator for noteId (matches pattern used in note.tsx)
      const generateId = () =>
        `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
      const rt = this.pattern.runtime();
      const program = this.pattern.get();
      if (!program) return;
      const pattern = JSON.parse(program);

      // Provide mentionable list so the pattern can wire backlinks immediately
      const inputs: Record<string, unknown> = {
        title: backlinkText,
        content: "",
        noteId: generateId(), // Ensure notes created via [[mention]] have unique IDs
      };

      const page = await rt.createPage(pattern, inputs);
      if (!page) {
        throw new Error("Could not create charm.");
      }
      const charmId = page.id();

      // Insert the ID into the text if we have an editor
      if (this._editorView && charmId) {
        this._insertBacklinkId(backlinkText, charmId, navigate);
      }

      this.emit("backlink-create", {
        text: backlinkText,
        charmId,
        charm: page.cell(),
        navigate,
      });
    } catch (error) {
      console.error("Error creating backlink:", error);
    }
  }

  /**
   * Insert the ID into an incomplete backlink and position cursor appropriately.
   * Replaces [[text]] with [[text (id)]] and positions cursor after ]].
   */
  private _insertBacklinkId(
    backlinkText: string,
    id: string,
    navigate: boolean,
  ): void {
    if (!this._editorView) return;

    const view = this._editorView;
    const state = view.state;
    const doc = state.doc;
    const content = doc.toString();

    // Find the incomplete backlink: [[backlinkText]]
    const searchPattern = `[[${backlinkText}]]`;
    const index = content.indexOf(searchPattern);

    if (index === -1) return;

    // Replace with complete backlink including ID
    const replacement = `[[${backlinkText} (${id})]]`;
    const from = index;
    const to = index + searchPattern.length;

    view.dispatch({
      changes: { from, to, insert: replacement },
      selection: navigate
        ? undefined // Keep current selection if navigating away
        : { anchor: from + replacement.length }, // Position after ]] if staying
    });
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
  private findCharmById(id: string): CellHandle<Mentionable> | null {
    if (!this.mentionable) return null;

    const rawMentionable = this.mentionable.get();
    if (!rawMentionable) return null;
    const mentionableData = Array.isArray(rawMentionable)
      ? rawMentionable as MentionableArray
      : isCellHandle(rawMentionable)
      ? ((rawMentionable.get() ?? []) as MentionableArray)
      : [];

    if (mentionableData.length === 0) return null;

    for (let i = 0; i < mentionableData.length; i++) {
      const charmValue = mentionableData[i];
      if (!charmValue) continue;
      const charmCell = this.mentionable.key(i) as CellHandle<Mentionable>;
      const charmId = charmCell.id();
      if (charmId === id) {
        return charmCell;
      }
    }

    return null;
  }

  /**
   * Create a plugin to decorate backlinks with focus-aware styling.
   * - When cursor is outside: show as collapsed pill (hide brackets and ID)
   * - When cursor is adjacent/inside: show [[Name]] with visible brackets (ID never visible)
   * - Incomplete backlinks show as pending pills or [[text]] when editing
   *
   * The charm ID is never shown to the user - it's stored in the document
   * as [[Name (id)]] but displayed as [[Name]] when editing or just Name when collapsed.
   */
  private createBacklinkDecorationPlugin() {
    const editingMark = Decoration.mark({ class: "cm-backlink-editing" });
    const pillMark = Decoration.mark({ class: "cm-backlink-pill" });
    const pendingMark = Decoration.mark({ class: "cm-backlink-pending" });
    const hiddenReplace = Decoration.replace({});

    return ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;

        constructor(view: EditorView) {
          this.decorations = this.getBacklinkDecorations(view);
        }

        update(update: ViewUpdate) {
          // Update on doc changes, viewport changes, selection changes, OR focus changes
          if (
            update.docChanged || update.viewportChanged ||
            update.selectionSet || update.focusChanged
          ) {
            this.decorations = this.getBacklinkDecorations(update.view);
          }
        }

        getBacklinkDecorations(view: EditorView) {
          const decorations: Range<Decoration>[] = [];
          const doc = view.state.doc;
          const hasFocus = view.hasFocus;
          const cursorPos = view.state.selection.main.head;
          const selectionFrom = view.state.selection.main.from;
          const selectionTo = view.state.selection.main.to;

          // Use the StateField for backlink positions
          const backlinks = view.state.field(backlinkField);

          for (const bl of backlinks) {
            const { from: start, to: end, nameFrom, nameTo, id } = bl;
            const hasId = id !== "";

            // Safety: skip backlinks that span multiple lines (would cause decoration errors)
            const startLine = doc.lineAt(start).number;
            const endLine = doc.lineAt(end).number;
            if (startLine !== endLine) continue;

            // Check if cursor is anywhere within the backlink (including hidden areas)
            // This ensures editing mode triggers when cursor is adjacent to visible pill
            const cursorInBacklink = hasFocus && cursorPos >= start &&
              cursorPos <= end;
            // Check if selection overlaps with the entire backlink
            const selectionOverlaps = hasFocus && selectionFrom < end &&
              selectionTo > start;

            if (hasId && (cursorInBacklink || selectionOverlaps)) {
              // EDITING MODE: Show plain [[Name]] text, hide only the " (id)" portion
              // The closing ]] stays visible so user sees [[Name]]
              // Safety check: only hide if there's actually content between nameTo and end-2
              const idStart = nameTo;
              const idEnd = end - 2; // Position before ]]
              if (idEnd > idStart) {
                decorations.push(hiddenReplace.range(idStart, idEnd)); // Hide " (id)"
              }
            } else if (!hasId) {
              // Incomplete backlink - show as pending pill or full text when editing
              const cursorInside = hasFocus && cursorPos >= start &&
                cursorPos <= end;
              if (cursorInside || selectionOverlaps) {
                // Cursor inside or adjacent - show full [[mention]] with editing style
                decorations.push(editingMark.range(start, end));
              } else {
                // Cursor away - show as pending pill
                decorations.push(hiddenReplace.range(start, start + 2)); // Hide [[
                decorations.push(pendingMark.range(start + 2, end - 2)); // Style inner text
                decorations.push(hiddenReplace.range(end - 2, end)); // Hide ]]
              }
            } else {
              // Complete backlink, cursor outside - show as navigable pill
              decorations.push(hiddenReplace.range(start, start + 2)); // Hide [[
              decorations.push(pillMark.range(nameFrom, nameTo)); // Style name only
              decorations.push(hiddenReplace.range(nameTo, end)); // Hide (id)]]
            }
          }

          // Sort decorations by position (required by CodeMirror)
          decorations.sort((a, b) => a.from - b.from || a.to - b.to);

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
    if (!this._editorView) return;

    const newValue = this.getValue();
    // Guard against undefined - can happen when cell isn't bound yet
    if (newValue === undefined || newValue === null) return;

    const currentValue = this._editorView.state.doc.toString();

    // Skip if content already matches - handles Cell echoes.
    // This is the key check that prevents cursor jumping: if the editor
    // already has the content the Cell is trying to set, do nothing.
    if (newValue === currentValue) {
      return;
    }

    // External updates override local edits, so drop any pending debounced write.
    this._cellController.cancel();

    // Apply external update to editor, preserving cursor position.
    // Clamp cursor to new document length in case content is shorter.
    const currentSelection = this._editorView.state.selection.main;
    const newLength = newValue.length;
    const anchorPos = Math.min(currentSelection.anchor, newLength);
    const headPos = Math.min(currentSelection.head, newLength);

    this._editorView.dispatch({
      changes: {
        from: 0,
        to: this._editorView.state.doc.length,
        insert: newValue,
      },
      selection: { anchor: anchorPos, head: headPos },
      annotations: CTCodeEditor._cellSyncAnnotation.of(true),
    });

    // Ensure mentioned charms reflect external value changes
    this._updateMentionedFromContent();
  }

  private _cellSyncUnsub: (() => void) | null = null;

  private _setupCellSyncHandler(): void {
    // Create a custom Cell sync handler that integrates with the CellController
    // but provides the special CodeMirror synchronization logic
    const originalTriggerUpdate = this._cellController["options"].triggerUpdate;

    // Override the CellController's update mechanism to include CodeMirror sync
    this._cellController["options"].triggerUpdate = false; // Disable default updates

    // Set up our own Cell subscription that calls both update methods
    if (this._cellController.hasCell()) {
      const cell = this._cellController.getCell();
      if (cell) {
        this._cellSyncUnsub = cell.subscribe(() => {
          // First update the editor content
          this._updateEditorFromCellValue();
          // Then trigger component update if originally enabled
          if (originalTriggerUpdate) {
            this.requestUpdate();
          }
        });
      }
    }
  }

  private _cleanupCellSyncHandler(): void {
    if (this._cellSyncUnsub) {
      this._cellSyncUnsub();
      this._cellSyncUnsub = null;
    }
  }

  /**
   * Subscribe to mentionable changes to re-resolve mentioned charms when
   * the source list updates.
   */
  private _setupMentionableSyncHandler(): void {
    if (this._mentionableUnsub) {
      this._mentionableUnsub();
      this._mentionableUnsub = null;
    }

    if (!this.mentionable) return;
    const unsubscribe = this.mentionable
      .subscribe((_value) => {
        this._updateMentionedFromContent();
      });
    this._mentionableUnsub = unsubscribe;
  }

  /**
   * Subscribe to mentioned cell changes to handle external updates.
   * Unsubscribes from previous cell when binding changes.
   */
  private _setupMentionedSyncHandler(): void {
    if (this._mentionedUnsub) {
      this._mentionedUnsub();
      this._mentionedUnsub = null;
    }

    if (!this.mentioned) return;
    const unsubscribe = this.mentioned
      .subscribe((_value) => {
        // Re-sync charm name subscriptions when mentioned list changes externally
        this._setupCharmNameSubscriptions();
      });
    this._mentionedUnsub = unsubscribe;
  }

  private _cleanup(): void {
    this._cleanupCellSyncHandler();
    this._cleanupCharmNameSubscriptions();
    if (this._mentionableUnsub) {
      this._mentionableUnsub();
      this._mentionableUnsub = null;
    }
    if (this._mentionedUnsub) {
      this._mentionedUnsub();
      this._mentionedUnsub = null;
    }
    this._cleanupFns.forEach((fn) => fn());
    this._cleanupFns = [];
    if (this._editorView) {
      this._editorView.destroy();
      this._editorView = undefined;
    }
  }

  override willUpdate(changedProperties: Map<string, any>) {
    if (changedProperties.has("mentionable")) {
      if (this.mentionable) {
        this.mentionable = this.mentionable.asSchema(MentionableArraySchema);
      }
      this._setupMentionableSyncHandler();
      this._updateMentionedFromContent();
    }
    if (changedProperties.has("mentioned")) {
      if (this.mentioned) {
        this.mentioned = this.mentioned.asSchema(MentionableArraySchema);
      }
      this._setupMentionedSyncHandler();
      this._updateMentionedFromContent();
    }
  }

  override updated(changedProperties: Map<string, any>) {
    super.updated(changedProperties);

    // If the value property itself changed (e.g., switched to a different cell)
    if (changedProperties.has("value") || !this._cellController.hasCell()) {
      // Cancel pending debounced updates from old Cell to prevent race condition
      this._cellController.cancel();
      // Clean up old Cell subscription and set up new one
      this._cleanupCellSyncHandler();
      this._cellController.bind(this.value);
      this._setupCellSyncHandler();
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
    this._setupMentionedSyncHandler();
    this._updateMentionedFromContent();

    // Initialize backlink name tracking for sync detection
    this._initializeBacklinkNameTracking();

    // Set up subscriptions for bidirectional NAME sync
    this._setupCharmNameSubscriptions();
  }

  /**
   * Initialize the backlink name tracking map with current document state.
   * This establishes a baseline so we can detect subsequent name changes.
   */
  private _initializeBacklinkNameTracking(): void {
    if (!this._editorView) return;
    const backlinks = this._editorView.state.field(backlinkField);
    this._previousBacklinkNames.clear();
    for (const bl of backlinks) {
      if (bl.id) {
        this._previousBacklinkNames.set(bl.id, bl.name);
      }
    }
  }

  private _initializeEditor(): void {
    const editorElement = this.shadowRoot?.querySelector(
      ".code-editor",
    ) as HTMLElement;
    if (!editorElement) return;

    // Create editor extensions
    const extensions: Extension[] = [
      basicSetup,
      // Backlink protection: StateField + atomic ranges + edit filter
      backlinkField,
      atomicBacklinkRanges,
      backlinkEditFilter,
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
        // Only process user-initiated changes, not Cell-originated updates.
        // Check if any transaction has the Cell sync annotation - if so, skip.
        // This prevents the feedback loop: Cell → Editor → setValue → Cell...
        const isCellSync = update.transactions.some(
          (tr) => tr.annotation(CTCodeEditor._cellSyncAnnotation),
        );
        if (update.docChanged && !this.readonly && !isCellSync) {
          const value = update.state.doc.toString();
          this.setValue(value);
          // Keep $mentioned current as user types
          this._updateMentionedFromContent();
          // Sync name changes to linked charms
          this._detectAndSyncNameChanges();
          // Refresh subscriptions for any new backlinks
          this._setupCharmNameSubscriptions();
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
        defaultKeymap: true,
        // Don't auto-select first option - let user explicitly choose or press Enter
        selectOnOpen: false,
      }),
      // Force completion to stay open when inside [[ context
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        const query = this._currentBacklinkQuery(update.view);
        if (query !== null) {
          const status = completionStatus(update.state);
          if (status === null) {
            setTimeout(() => startCompletion(update.view), 0);
          }
        }
      }),
      // Enter: complete backlink OR exit editing mode (no newline inside backlinks)
      // Use Prec.highest to ensure this runs before autocompletion handlers
      Prec.highest(keymap.of([{
        key: "Enter",
        run: (view) => {
          const pos = view.state.selection.main.head;
          const backlinks = view.state.field(backlinkField);

          // Check if cursor is inside a complete backlink (from [[ up to but not after ]])
          // Enter inside backlink exits editing; Enter after ]] allows normal newline
          for (const bl of backlinks) {
            if (bl.id && pos >= bl.from && pos < bl.to) {
              // Cursor is inside the backlink - exit editing mode
              // Move cursor to after ]] without inserting newline
              view.dispatch({
                selection: { anchor: bl.to },
              });
              return true; // Consume Enter, no newline
            }
          }

          // If typing a new backlink like [[mention, complete it
          const query = this._currentBacklinkQuery(view);
          if (query != null) {
            const text = query.trim();
            if (text.length > 0) {
              // Check for exact match in mentionable
              const exactMatch = this._findExactMentionable(text);

              if (exactMatch) {
                // Found exact match - insert complete backlink with ID
                const charmId = exactMatch.id();
                const charmName = exactMatch.key(NAME).get() || text;
                this._completeBacklinkWithId(view, text, charmName, charmId);
              } else if (this.pattern) {
                // No exact match - create new charm without navigating
                // First complete the backlink text, then create the charm
                this._completeBacklinkText(view);
                // createBacklinkFromPattern will insert the ID and emit event
                this.createBacklinkFromPattern(text, false);
              }
              return true;
            }
          }

          return false;
        },
      }])),
      // Intercept Cmd/Ctrl+S when editor is focused
      keymap.of([{
        key: "Mod-s",
        run: () => true, // prevent default browser save
      }]),
    ];

    // Add placeholder extension if specified
    if (this.placeholder) {
      extensions.push(placeholder(this.placeholder));
    }

    // Create editor state
    const state = EditorState.create({
      doc: this.getValue() ?? "",
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

    // Extract IDs from content
    const newIds = this._extractMentionedIds(content);

    // Get current mentioned IDs by looking them up in mentionable
    const curIds = this._getCurrentMentionedIds();

    // Compare ID sets to avoid unnecessary writes
    if (newIds.size === curIds.size) {
      let same = true;
      for (const id of newIds) {
        if (!curIds.has(id)) {
          same = false;
          break;
        }
      }
      if (same) return; // No change
    }

    // Resolve IDs to Mentionable values and update the cell
    const newMentioned = this._extractMentionedCharms(content);
    this.mentioned.set(newMentioned);
    this._setupCharmNameSubscriptions();
  }

  /**
   * Extract unique charm IDs from content backlinks.
   */
  private _extractMentionedIds(content: string): Set<string> {
    const ids = new Set<string>();
    const regex = /\[\[[^\]]*?\(([^)]+)\)\]\]/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      const id = match[1];
      if (id) ids.add(id);
    }
    return ids;
  }

  /**
   * Get IDs of currently mentioned charms by looking them up in mentionable.
   */
  private _getCurrentMentionedIds(): Set<string> {
    const curIds = new Set<string>();
    if (!this.mentioned) return curIds;

    const rawMentioned = this.mentioned.get();
    if (!rawMentioned) return curIds;

    const currentSource = Array.isArray(rawMentioned)
      ? rawMentioned
      : isCellHandle(rawMentioned)
      ? ((rawMentioned.get() ?? []) as MentionableArray)
      : [];

    if (!this.mentionable) return curIds;

    const rawMentionable = this.mentionable.get();
    const mentionableData = Array.isArray(rawMentionable)
      ? rawMentionable as MentionableArray
      : isCellHandle(rawMentionable)
      ? ((rawMentionable.get() ?? []) as MentionableArray)
      : [];

    // For each current mentioned value, find its ID by matching in mentionable
    for (const mentionedValue of currentSource) {
      if (!mentionedValue) continue;
      for (let i = 0; i < mentionableData.length; i++) {
        if (mentionableData[i] === mentionedValue) {
          const charmCell = this.mentionable.key(i) as CellHandle<Mentionable>;
          const charmId = charmCell.id();
          if (charmId) curIds.add(charmId);
          break;
        }
      }
    }

    return curIds;
  }

  /**
   * Set up subscriptions to charm TITLE cells for bidirectional sync.
   * We subscribe to title (not NAME) because:
   * - We UPDATE title when user edits backlink in doc
   * - NAME is computed from title, so subscribing to NAME would cause feedback loops
   * - By subscribing to title with same changeGroup, our own edits are filtered out
   */
  private _setupCharmNameSubscriptions(): void {
    if (!this._editorView) return;

    const backlinks = this._editorView.state.field(backlinkField);
    const activeIds = new Set<string>();

    for (const bl of backlinks) {
      if (!bl.id) continue;
      activeIds.add(bl.id);

      // Skip if already subscribed
      if (this._charmNameSubscriptions.has(bl.id)) continue;

      const charmCell = this.findCharmById(bl.id);
      if (!charmCell) continue;

      // Subscribe to TITLE cell (not NAME) - this is what we update
      const titleCell = charmCell.key("title");
      const charmId = bl.id;

      // Subscribe with changeGroup so our own edits are filtered out
      const unsub = titleCell.subscribe(() => {
        this._handleExternalTitleChange(charmId, charmCell);
      });

      this._charmNameSubscriptions.set(charmId, unsub);
    }

    // Clean up subscriptions for charms no longer in document
    for (const [id, unsub] of this._charmNameSubscriptions) {
      if (!activeIds.has(id)) {
        unsub();
        this._charmNameSubscriptions.delete(id);
      }
    }
  }

  /**
   * Handle external title change from a charm - update the pill text in the document.
   * This is called when a charm's title field changes externally (not from our own edit).
   */
  private _handleExternalTitleChange(
    charmId: string,
    charmCell: CellHandle<Mentionable>,
  ): void {
    if (!this._editorView) return;

    // Get the charm's title (without emoji prefix)
    const title = charmCell.key("title").get() as string;
    if (!title) return;

    // Find backlink in document
    const backlinks = this._editorView.state.field(backlinkField);
    const bl = backlinks.find((b) => b.id === charmId);
    if (!bl) return;

    // Strip emoji from document name for comparison
    const docNameStripped = bl.name.replace(/^(?:📝|📓|📁|🗒️|🗒)\s*/, "");

    // Skip if stripped names match (no actual title change)
    if (docNameStripped === title) return;

    // Get the full NAME (with emoji) to insert into document
    const currentName = charmCell.key(NAME).get() as string;
    if (!currentName) return;

    // Update tracking map BEFORE dispatch so _detectAndSyncNameChanges doesn't
    // try to sync this change back to the charm (it runs synchronously during dispatch)
    this._previousBacklinkNames.set(charmId, currentName);

    // Update document with annotation to prevent updateListener from calling setValue
    this._editorView.dispatch({
      changes: { from: bl.nameFrom, to: bl.nameTo, insert: currentName },
      annotations: CTCodeEditor._cellSyncAnnotation.of(true),
    });

    // Update Cell value IMMEDIATELY (bypass debounce) so Cell sync doesn't revert
    const newDocValue = this._editorView.state.doc.toString();
    if (isCellHandle(this.value)) {
      this.value.set(newDocValue);
    }
  }

  /**
   * Clean up all charm NAME subscriptions.
   */
  private _cleanupCharmNameSubscriptions(): void {
    for (const unsub of this._charmNameSubscriptions.values()) {
      unsub();
    }
    this._charmNameSubscriptions.clear();
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
      const value = charm?.get();
      if (value) {
        result.push(value);
        seen.add(id);
      }
    }
    return result;
  }

  /**
   * Detect name changes in backlinks and sync them to linked charm's NAME property.
   * Called when document changes.
   */
  private _detectAndSyncNameChanges(): void {
    if (!this._editorView) return;

    const backlinks = this._editorView.state.field(backlinkField);
    const currentNames = new Map<string, string>();

    for (const bl of backlinks) {
      if (!bl.id) continue;
      currentNames.set(bl.id, bl.name);

      const previousName = this._previousBacklinkNames.get(bl.id);
      if (previousName !== undefined && previousName !== bl.name) {
        // Name changed! Update the charm's NAME property
        this._updateCharmName(bl.id, bl.name, previousName);
      }
    }

    this._previousBacklinkNames = currentNames;
  }

  /**
   * Update a charm's name when the backlink text changes.
   * Tries to update 'title' field first (for patterns where NAME is computed),
   * then falls back to NAME directly.
   */
  private _updateCharmName(
    charmId: string,
    newName: string,
    oldName: string,
  ): void {
    const charmCell = this.findCharmById(charmId);
    if (!charmCell) {
      console.warn(
        `[ct-code-editor] Cannot update name: charm ${charmId} not found`,
      );
      return;
    }

    // Strip common emoji prefixes to get the raw title
    // Use alternation instead of character class - emoji are multi-codepoint
    const titleValue = newName.replace(/^(?:📝|📓|📁|🗒️|🗒)\s*/, "");

    // Update 'title' field - for note patterns, NAME is computed from title
    // (NAME = `📝 ${title}`) so setting title will update NAME automatically
    charmCell.key("title").set(titleValue);

    this.emit("backlink-name-changed", {
      charmId,
      oldName,
      newName,
      charm: charmCell,
    });
  }
}

globalThis.customElements.define("ct-code-editor", CTCodeEditor);
