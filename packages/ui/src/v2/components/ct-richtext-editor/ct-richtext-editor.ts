import { html, PropertyValues } from "lit";
import { BaseElement } from "../../core/base-element.ts";
import { styles } from "./styles.ts";

// TipTap imports
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCursor from "@tiptap/extension-collaboration-cursor";

// Yjs imports
// NOTE: These are imported statically for simplicity. The collaborative editing
// code paths are only executed when `collaborative={true}`. Modern bundlers
// with tree-shaking may optimize unused code. For further optimization,
// consider dynamic imports if bundle size becomes an issue.
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";

import { type Cell, getEntityId, isCell } from "@commontools/runner";
import { type InputTimingOptions } from "../../core/input-timing-controller.ts";
import { createStringCellController } from "../../core/cell-controller.ts";
import { createCollabAuthToken } from "../../core/collab-auth.ts";

/**
 * CTRichtextEditor - Rich text editor component with collaborative editing support
 *
 * @element ct-richtext-editor
 *
 * @attr {string|Cell<string>} value - Editor content as HTML (supports both plain string and Cell<string>)
 * @attr {boolean} disabled - Whether the editor is disabled
 * @attr {boolean} readonly - Whether the editor is read-only
 * @attr {string} placeholder - Placeholder text when empty
 * @attr {string} timingStrategy - Input timing strategy: "immediate" | "debounce" | "throttle" | "blur"
 * @attr {number} timingDelay - Delay in milliseconds for debounce/throttle (default: 500)
 * @attr {boolean} collaborative - Enable real-time collaborative editing (default: false).
 *   PRIVACY NOTE: When enabled, your cursor position and userName are visible to all
 *   other users in the same room. The distinctive colored cursors serve as the visual
 *   indicator that you are in a shared editing session. This follows the Google Docs
 *   model where presence visibility is intrinsic to collaboration.
 * @attr {string} roomId - Room ID for collaboration (defaults to Cell entity ID)
 * @attr {string} collabUrl - WebSocket URL for collaboration server
 * @attr {string} userName - User name shown to other collaborators (default: "Anonymous")
 * @attr {string} userColor - Cursor color shown to other collaborators (random if not set)
 *
 * @fires ct-change - Fired when content changes with detail: { value, oldValue }
 * @fires ct-focus - Fired on focus
 * @fires ct-blur - Fired on blur
 *
 * @example
 * <ct-richtext-editor placeholder="Enter rich text..."></ct-richtext-editor>
 *
 * @example Collaborative editing
 * <ct-richtext-editor
 *   .value=${noteCell}
 *   collaborative
 *   userName="Alice"
 *   userColor="#f783ac"
 * ></ct-richtext-editor>
 */
export class CTRichtextEditor extends BaseElement {
  static override styles = [BaseElement.baseStyles, styles];

  static override properties = {
    value: { type: String },
    disabled: { type: Boolean, reflect: true },
    readonly: { type: Boolean, reflect: true },
    placeholder: { type: String },
    timingStrategy: { type: String },
    timingDelay: { type: Number },
    // Collaborative editing props
    collaborative: { type: Boolean },
    roomId: { type: String },
    collabUrl: { type: String },
    userName: { type: String },
    userColor: { type: String },
  };

  declare value: Cell<string> | string;
  declare disabled: boolean;
  declare readonly: boolean;
  declare placeholder: string;
  declare timingStrategy: InputTimingOptions["strategy"];
  declare timingDelay: number;
  // Collaborative editing properties
  declare collaborative: boolean;
  declare roomId?: string;
  declare collabUrl?: string;
  declare userName?: string;
  declare userColor?: string;

  private _editor: Editor | undefined;
  // Yjs collaborative state
  private _ydoc?: Y.Doc;
  private _provider?: WebsocketProvider;
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
      });
    },
  });

  constructor() {
    super();
    this.value = "";
    this.disabled = false;
    this.readonly = false;
    this.placeholder = "";
    this.timingStrategy = "debounce";
    this.timingDelay = 500;
    // Collaborative editing defaults
    this.collaborative = false;
    this.roomId = undefined;
    this.collabUrl = undefined;
    this.userName = "Anonymous";
    this.userColor = this._generateUserColor();
  }

  /**
   * Generate a random color for cursor presence
   */
  private _generateUserColor(): string {
    const colors = [
      "#f783ac", "#da77f2", "#9775fa", "#748ffc",
      "#4dabf7", "#38d9a9", "#69db7c", "#ffd43b",
      "#ff922b", "#ff6b6b",
    ];
    return colors[Math.floor(Math.random() * colors.length)];
  }

  /**
   * Get the WebSocket URL for collaboration
   */
  private _getCollabUrl(): string {
    if (this.collabUrl) return this.collabUrl;
    // Default to toolshed on same host
    const protocol = globalThis.location?.protocol === "https:" ? "wss:" : "ws:";
    const host = globalThis.location?.host || "localhost:8000";
    return `${protocol}//${host}/api/collab`;
  }

  /**
   * Derive room ID from Cell entity ID if not provided
   */
  private _deriveRoomId(): string {
    if (this.roomId) return this.roomId;
    // Try to get entity ID from the Cell
    if (isCell(this.value)) {
      const entityId = getEntityId(this.value);
      const idValue = entityId?.["/"];
      if (idValue) return idValue;
    }
    // Fallback to a random ID
    return `room-${Math.random().toString(36).slice(2)}`;
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
    if (this._editor && !this.collaborative) {
      const newValue = this.getValue();
      const currentValue = this._editor.getHTML();
      if (newValue !== currentValue) {
        this._editor.commands.setContent(newValue, false);
      }
    }
  }

  private _setupCellSyncHandler(): void {
    // Create a custom Cell sync handler that integrates with the CellController
    const originalTriggerUpdate = this._cellController["options"].triggerUpdate;

    // Override the CellController's update mechanism
    this._cellController["options"].triggerUpdate = false;

    // Set up our own Cell subscription
    if (this._cellController.isCell()) {
      const cell = this._cellController.getCell();
      if (cell) {
        const unsubscribe = cell.sink(() => {
          this._updateEditorFromCellValue();
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
    // Clean up Yjs collaborative state
    if (this._provider) {
      this._provider.disconnect();
      this._provider.destroy();
      this._provider = undefined;
    }
    if (this._ydoc) {
      this._ydoc.destroy();
      this._ydoc = undefined;
    }
    if (this._editor) {
      this._editor.destroy();
      this._editor = undefined;
    }
  }

  override updated(changedProperties: Map<string, any>) {
    super.updated(changedProperties);

    // If the value property itself changed (e.g., switched to a different cell)
    if (changedProperties.has("value")) {
      this._cellController.bind(this.value);
      this._updateEditorFromCellValue();
    }

    // Update disabled state
    if (changedProperties.has("disabled") && this._editor) {
      this._editor.setEditable(!this.disabled && !this.readonly);
    }

    // Update readonly state
    if (changedProperties.has("readonly") && this._editor) {
      this._editor.setEditable(!this.disabled && !this.readonly);
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

    // Set up custom cell sync handler
    this._setupCellSyncHandler();
  }

  private async _initializeEditor(): Promise<void> {
    const editorElement = this.shadowRoot?.querySelector(
      ".richtext-editor",
    ) as HTMLElement;
    if (!editorElement) return;

    // Build extensions list
    const extensions: any[] = [
      StarterKit.configure({
        // Disable history when using collaboration (Yjs handles undo/redo)
        history: this.collaborative ? false : undefined,
      }),
    ];

    // Set up Yjs collaborative editing if enabled
    if (this.collaborative) {
      const roomId = this._deriveRoomId();
      console.log(`[ct-richtext-editor] Setting up collaboration for room: ${roomId}`);

      // Create Y.Doc
      this._ydoc = new Y.Doc();

      // Connect to collaboration server with auth if we have a Cell
      let collabUrl = this._getCollabUrl();

      // Sign auth token if we have a Cell value
      if (isCell(this.value)) {
        try {
          const authToken = await createCollabAuthToken(this.value, roomId);
          if (authToken) {
            // Append auth params to URL - y-websocket preserves query params when adding roomId
            const url = new URL(collabUrl);
            url.searchParams.set("payload", authToken.payload);
            url.searchParams.set("sig", authToken.signature);
            url.searchParams.set("did", authToken.did);
            collabUrl = url.toString();
            console.log(`[ct-richtext-editor] Auth token created for user: ${authToken.did}`);
          }
        } catch (error) {
          console.warn(`[ct-richtext-editor] Failed to create auth token:`, error);
        }
      }

      this._provider = new WebsocketProvider(collabUrl, roomId, this._ydoc);

      // Log connection status
      this._provider.on("status", (event: { status: string }) => {
        console.log(`[ct-richtext-editor] Collab status: ${event.status}`);
      });

      // Add collaboration extensions
      extensions.push(
        Collaboration.configure({
          document: this._ydoc,
        }),
        CollaborationCursor.configure({
          provider: this._provider,
          user: {
            name: this.userName || "Anonymous",
            color: this.userColor || this._generateUserColor(),
          },
        }),
      );
    }

    // Create TipTap editor
    this._editor = new Editor({
      element: editorElement,
      extensions,
      content: this.collaborative ? "" : this.getValue(),
      editable: !this.disabled && !this.readonly,
      onUpdate: ({ editor }) => {
        if (!this.readonly) {
          const htmlContent = editor.getHTML();
          this.setValue(htmlContent);
        }
      },
      onFocus: () => {
        this._cellController.onFocus();
        this.emit("ct-focus");
      },
      onBlur: () => {
        this._cellController.onBlur();
        this.emit("ct-blur");
      },
    });

    // Initialize content from Cell value for collaborative mode
    if (this.collaborative && this._provider) {
      this._provider.on("sync", (synced: boolean) => {
        if (synced && this._ydoc) {
          const fragment = this._ydoc.getXmlFragment("prosemirror");
          // If empty and we have initial content, insert it
          if (fragment.length === 0) {
            const initialValue = this.getValue();
            if (initialValue && this._editor) {
              this._editor.commands.setContent(initialValue, false);
            }
          }
        }
      });
    }
  }

  override render() {
    return html`
      <div class="richtext-editor"></div>
    `;
  }

  /**
   * Focus the editor programmatically
   */
  override focus(): void {
    this._editor?.commands.focus();
  }

  /**
   * Get the editor instance
   */
  get editor(): Editor | undefined {
    return this._editor;
  }

  /**
   * Get the HTML content
   */
  getHTMLContent(): string {
    return this._editor?.getHTML() || "";
  }

  /**
   * Get the plain text content
   */
  getTextContent(): string {
    return this._editor?.getText() || "";
  }

  /**
   * Set content programmatically
   */
  setContent(content: string, emitUpdate = true): void {
    this._editor?.commands.setContent(content, emitUpdate);
  }
}

globalThis.customElements.define("ct-richtext-editor", CTRichtextEditor);
