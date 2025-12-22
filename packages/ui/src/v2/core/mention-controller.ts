import type { ReactiveController, ReactiveControllerHost } from "lit";
import { type Cell, getEntityId, isCell, NAME } from "@commontools/runner";
import { type Mentionable, type MentionableArray } from "./mentionable.ts";

/**
 * Configuration for the MentionController
 */
export interface MentionControllerConfig {
  /**
   * The trigger character for mentions (default: "@")
   */
  trigger?: string;

  /**
   * Callback when a mention is inserted
   */
  onInsert?: (markdown: string, mention: Cell<Mentionable>) => void;

  /**
   * Callback to get current cursor position in the input element
   */
  getCursorPosition?: () => number;

  /**
   * Callback to get the current editing content
   */
  getContent?: () => string;
}

/**
 * State for mention autocomplete
 */
export interface MentionState {
  showing: boolean;
  query: string;
  selectedIndex: number;
}

/**
 * MentionController - Reusable Lit controller for @-mention autocomplete
 *
 * Handles:
 * - Trigger detection (@)
 * - Query extraction and filtering
 * - Keyboard navigation (ArrowUp/Down, Enter, Escape)
 * - Mention insertion as markdown links [name](#entityId)
 *
 * Usage:
 * ```typescript
 * class MyComponent extends LitElement {
 *   private mentionController = new MentionController(this, {
 *     onInsert: (mention, markdown) => this.insertAtCursor(markdown),
 *     getCursorPosition: () => this.textarea.selectionStart,
 *     getContent: () => this.textarea.value
 *   });
 *
 *   // In your input handler:
 *   handleInput(e: Event) {
 *     this.mentionController.handleInput(e);
 *   }
 *
 *   // In your keydown handler:
 *   handleKeyDown(e: KeyboardEvent) {
 *     if (this.mentionController.handleKeyDown(e)) {
 *       return; // Mention controller handled it
 *     }
 *     // ... rest of your keyboard handling
 *   }
 * }
 * ```
 */
export class MentionController implements ReactiveController {
  private host: ReactiveControllerHost;
  private config: Required<MentionControllerConfig>;

  // Mention state
  private _state: MentionState = {
    showing: false,
    query: "",
    selectedIndex: 0,
  };

  // Mentionable items
  private _mentionable: Cell<MentionableArray> | null = null;
  private _mentionableUnsubscribe: (() => void) | null = null;

  constructor(
    host: ReactiveControllerHost,
    config: MentionControllerConfig = {},
  ) {
    this.host = host;
    this.config = {
      trigger: config.trigger ?? "@",
      onInsert: config.onInsert ?? (() => {}),
      getCursorPosition: config.getCursorPosition ?? (() => 0),
      getContent: config.getContent ?? (() => ""),
    };
    host.addController(this);
  }

  hostConnected(): void {
    this._setupMentionableSubscription();
  }

  hostDisconnected(): void {
    this._cleanupMentionableSubscription();
  }

  /**
   * Set the mentionable items
   */
  setMentionable(mentionable: Cell<MentionableArray> | null): void {
    // Clean up old subscription if it exists
    this._cleanupMentionableSubscription();

    this._mentionable = mentionable;

    // Set up new subscription
    this._setupMentionableSubscription();

    this.host.requestUpdate();
  }

  /**
   * Get current mention state
   */
  get state(): MentionState {
    return this._state;
  }

  /**
   * Check if mentions dropdown is showing
   */
  get isShowing(): boolean {
    return this._state.showing;
  }

  /**
   * Get filtered mentions based on current query
   */
  getFilteredMentions(): Cell<Mentionable>[] {
    if (!this._mentionable) {
      return [];
    }

    const mentionableArray = this._mentionable.get();
    if (!Array.isArray(mentionableArray) || mentionableArray.length === 0) {
      return [];
    }

    const query = this._state.query.toLowerCase();

    const filtered: Cell<Mentionable>[] = [];
    for (let i = 0; i < mentionableArray.length; i++) {
      // Use .key(i) to get Cell reference, preserving cell-ness
      const mentionCell = this._mentionable.key(i);

      // Only call .get() to read the name for filtering
      const name = mentionCell.get()?.[NAME];

      if (!query || name?.toLowerCase().includes(query)) {
        filtered.push(mentionCell);
      }
    }

    return filtered;
  }

  /**
   * Handle input event to detect @ trigger and update query
   */
  handleInput(_event: Event): void {
    const content = this.config.getContent();
    const cursorPos = this.config.getCursorPosition();
    const textBeforeCursor = content.substring(0, cursorPos);
    const lastTriggerIndex = textBeforeCursor.lastIndexOf(this.config.trigger);

    if (
      lastTriggerIndex !== -1 &&
      lastTriggerIndex === textBeforeCursor.length - 1
    ) {
      // Just typed trigger - cursor is right after it
      this._state.showing = true;
      this._state.query = "";
      this._state.selectedIndex = 0;
      this.host.requestUpdate();
    } else if (lastTriggerIndex !== -1) {
      // There's a trigger before cursor
      const query = textBeforeCursor.substring(lastTriggerIndex + 1);
      if (!query.includes(" ")) {
        // Valid query - show mentions with query
        this._state.showing = true;
        this._state.query = query;
        this._state.selectedIndex = 0;
        this.host.requestUpdate();
      } else {
        // Space in query - hide mentions
        this.hide();
      }
    } else {
      // No trigger before cursor - hide mentions if showing
      if (this._state.showing) {
        this.hide();
      }
    }
  }

  /**
   * Handle keyboard events for mention navigation
   * Returns true if the event was handled, false otherwise
   */
  handleKeyDown(event: KeyboardEvent): boolean {
    if (!this._state.showing) {
      return false;
    }

    const filteredMentions = this.getFilteredMentions();

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        this._state.selectedIndex = Math.min(
          this._state.selectedIndex + 1,
          filteredMentions.length - 1,
        );
        this.host.requestUpdate();
        return true;

      case "ArrowUp":
        event.preventDefault();
        this._state.selectedIndex = Math.max(this._state.selectedIndex - 1, 0);
        this.host.requestUpdate();
        return true;

      case "Enter":
        // Only intercept Enter if a mention will actually be inserted.
        if (filteredMentions[this._state.selectedIndex]) {
          event.preventDefault();
          this.insertMention(filteredMentions[this._state.selectedIndex]);
          return true;
        }
        // Let caller handle Enter when there are no matches.
        return false;

      case "Escape":
        event.preventDefault();
        this.hide();
        return true;

      default:
        return false;
    }
  }

  /**
   * Insert a mention at the current cursor position
   */
  insertMention(mention: Cell<Mentionable>): void {
    const markdown = this.encodeCharmAsMarkdown(mention);
    this.config.onInsert(markdown, mention);
    this.hide();
  }

  /**
   * Manually select a mention by index
   */
  selectMention(index: number): void {
    this._state.selectedIndex = index;
    this.host.requestUpdate();
  }

  /**
   * Hide the mentions dropdown
   */
  hide(): void {
    this._state.showing = false;
    this._state.query = "";
    this._state.selectedIndex = 0;
    this.host.requestUpdate();
  }

  /**
   * Encode a charm as markdown link [name](#entityId)
   */
  private encodeCharmAsMarkdown(charm: Cell<Mentionable>): string {
    // Only call .get() when we need the actual values
    const name = charm.get()?.[NAME] || "Unknown";
    const entityId = getEntityId(charm);
    const href = encodeURIComponent(JSON.stringify(entityId)) || "";
    return `[${name}](${href})`;
  }

  /**
   * Decode charm reference from href (entity ID)
   */
  decodeCharmFromHref(href: string | null): Cell<Mentionable> | null {
    if (!href) return null;

    const all = this.readMentionables();
    for (const mention of all) {
      // Only call getEntityId (which calls .get()) when comparing
      const mentionEntityId = encodeURIComponent(
        JSON.stringify(getEntityId(mention)),
      );
      if (mentionEntityId === href) {
        return mention;
      }
    }

    return null;
  }

  /**
   * Extract all mentions from markdown text
   * Returns array of Cell<Mentionable> objects referenced in the text
   */
  extractMentionsFromText(text: string): Cell<Mentionable>[] {
    const mentions: Cell<Mentionable>[] = [];
    const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
    let match;

    while ((match = linkRegex.exec(text)) !== null) {
      const href = match[2];
      const mention = this.decodeCharmFromHref(href);
      if (mention) {
        mentions.push(mention);
      }
    }

    return mentions;
  }

  private readMentionables(): Cell<Mentionable>[] {
    if (!this._mentionable) {
      return [];
    }

    const mentionableArray = this._mentionable.get();
    if (!Array.isArray(mentionableArray) || mentionableArray.length === 0) {
      return [];
    }

    // Use .key(i) to preserve cell-ness of items
    const mentions: Cell<Mentionable>[] = [];
    for (let i = 0; i < mentionableArray.length; i++) {
      const mentionCell = this._mentionable.key(i);
      if (mentionCell) {
        mentions.push(mentionCell);
      }
    }

    return mentions;
  }

  /**
   * Set up Cell subscription for mentionable array.
   * When the Cell's value changes, we need to re-render to show updated mentions.
   * @private
   */
  private _setupMentionableSubscription(): void {
    if (isCell(this._mentionable)) {
      this._mentionableUnsubscribe = this._mentionable.sink(() => {
        this.host.requestUpdate();
      });
    }
  }

  /**
   * Clean up Cell subscription for mentionable array.
   * @private
   */
  private _cleanupMentionableSubscription(): void {
    if (this._mentionableUnsubscribe) {
      this._mentionableUnsubscribe();
      this._mentionableUnsubscribe = null;
    }
  }
}
