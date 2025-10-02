import type { ReactiveController, ReactiveControllerHost } from "lit";
import { type Cell, getEntityId, NAME } from "@commontools/runner";
import {
  type Mentionable,
  type MentionableArray,
  mentionableArraySchema,
} from "./mentionable.ts";

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
  onInsert?: (markdown: string, mention: Mentionable) => void;

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

  hostConnected(): void {}
  hostDisconnected(): void {}

  /**
   * Set the mentionable items
   */
  setMentionable(mentionable: Cell<MentionableArray> | null): void {
    this._mentionable = mentionable;
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
  getFilteredMentions(): MentionableArray {
    if (!this._mentionable) {
      return [];
    }

    const mentionableArray = this._mentionable.asSchema(
      mentionableArraySchema,
    );
    const mentionableData = mentionableArray.get();
    if (!mentionableData || mentionableData.length === 0) {
      return [];
    }

    const query = this._state.query.toLowerCase();
    const matches: number[] = [];

    // Resolve each mentionable item and filter by query
    for (let i = 0; i < mentionableData.length; i++) {
      const mention = mentionableArray.key(i).get();
      if (mention && mention[NAME]?.toLowerCase()?.includes(query)) {
        matches.push(i);
      }
    }

    return matches.map((i) => mentionableArray.key(i).get());
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
        event.preventDefault();
        if (filteredMentions[this._state.selectedIndex]) {
          this.insertMention(filteredMentions[this._state.selectedIndex]);
        }
        return true;

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
  insertMention(mention: Mentionable): void {
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
  private encodeCharmAsMarkdown(charm: Mentionable): string {
    const name = charm[NAME] || "Unknown";
    const entityId = getEntityId(charm);
    const href = encodeURIComponent(JSON.stringify(entityId)) || "";
    return `[${name}](${href})`;
  }

  /**
   * Decode charm reference from href (entity ID)
   */
  decodeCharmFromHref(href: string | null): Mentionable | null {
    if (!href || !this._mentionable) return null;

    const mentionableArray = this._mentionable.asSchema(
      mentionableArraySchema,
    );
    const mentionableData = mentionableArray.get() || [];

    for (let i = 0; i < mentionableData.length; i++) {
      const mention = mentionableArray.key(i).get();
      if (mention) {
        const mentionEntityId = encodeURIComponent(
          JSON.stringify(getEntityId(mention)),
        );
        if (mentionEntityId === href) {
          return mention;
        }
      }
    }

    return null;
  }

  /**
   * Extract all mentions from markdown text
   * Returns array of Mentionable objects referenced in the text
   */
  extractMentionsFromText(text: string): Mentionable[] {
    if (!this._mentionable) return [];

    const mentions: Mentionable[] = [];
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
}
