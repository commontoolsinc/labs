/**
 * ct-modal-provider - Modal stack manager
 *
 * Provides ModalManager context to descendant ct-modal components.
 * Manages modal stacking, z-index allocation, and global Escape key handling.
 *
 * @element ct-modal-provider
 *
 * @example
 * ```html
 * <ct-modal-provider>
 *   <my-app>
 *     <!-- Modals anywhere in the tree will coordinate through the provider -->
 *     <ct-modal $open={showModal}>...</ct-modal>
 *   </my-app>
 * </ct-modal-provider>
 * ```
 */
import { css, html, LitElement } from "lit";
import { provide } from "@lit/context";
import {
  modalContext,
  MODAL_BASE_Z_INDEX,
  MODAL_Z_INDEX_INCREMENT,
  type ModalManager,
  type ModalRegistration,
} from "../modal-context.ts";

export class CTModalProvider extends LitElement {
  static override styles = css`
    :host {
      display: contents;
    }
  `;

  /** Provide the modal manager to descendants */
  @provide({ context: modalContext })
  private _manager: ModalManager = this._createManager();

  /** Stack of registered modals (topmost is last) */
  private _stack: ModalRegistration[] = [];

  /** Counter for generating unique IDs */
  private _nextId = 1;

  /** Escape key handler reference for cleanup */
  private _escapeHandler: ((e: KeyboardEvent) => void) | null = null;

  /**
   * Create the ModalManager implementation
   */
  private _createManager(): ModalManager {
    return {
      register: (modal, dismissable) => this._register(modal, dismissable),
      unregister: (id) => this._unregister(id),
      isTopModal: (id) => this._isTopModal(id),
      getStackDepth: () => this._stack.length,
      requestCloseTop: () => this._requestCloseTop(),
    };
  }

  override connectedCallback() {
    super.connectedCallback();
    // Set up global Escape key handler
    this._escapeHandler = this._handleEscape.bind(this);
    document.addEventListener("keydown", this._escapeHandler);
  }

  override disconnectedCallback() {
    // Clean up Escape key handler
    if (this._escapeHandler) {
      document.removeEventListener("keydown", this._escapeHandler);
      this._escapeHandler = null;
    }
    super.disconnectedCallback();
  }

  /**
   * Handle global Escape key - close topmost dismissable modal
   */
  private _handleEscape(e: KeyboardEvent) {
    if (e.key === "Escape" && !e.defaultPrevented && this._stack.length > 0) {
      if (this._requestCloseTop()) {
        e.preventDefault();
        e.stopPropagation();
      }
    }
  }

  /**
   * Register a modal when it opens
   */
  private _register(
    modal: HTMLElement,
    dismissable: boolean,
  ): ModalRegistration {
    const id = `modal-${this._nextId++}`;
    const zIndex =
      MODAL_BASE_Z_INDEX + this._stack.length * MODAL_Z_INDEX_INCREMENT;
    const registration: ModalRegistration = {
      id,
      element: modal,
      dismissable,
      zIndex,
    };
    this._stack.push(registration);
    return registration;
  }

  /**
   * Unregister a modal when it closes
   */
  private _unregister(id: string): void {
    const index = this._stack.findIndex((r) => r.id === id);
    if (index >= 0) {
      this._stack.splice(index, 1);
    }
  }

  /**
   * Check if a modal is the topmost in the stack
   */
  private _isTopModal(id: string): boolean {
    return (
      this._stack.length > 0 && this._stack[this._stack.length - 1].id === id
    );
  }

  /**
   * Request close of the topmost dismissable modal
   * Returns true if a modal was closed
   */
  private _requestCloseTop(): boolean {
    // Find topmost dismissable modal (search from top)
    for (let i = this._stack.length - 1; i >= 0; i--) {
      if (this._stack[i].dismissable) {
        // Dispatch close event on the modal element
        this._stack[i].element.dispatchEvent(
          new CustomEvent("ct-modal-close", {
            detail: { reason: "escape" },
            bubbles: true,
            composed: true,
          }),
        );
        return true;
      }
    }
    return false;
  }

  override render() {
    return html`<slot></slot>`;
  }
}

customElements.define("ct-modal-provider", CTModalProvider);
