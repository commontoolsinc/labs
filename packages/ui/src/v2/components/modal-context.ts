/**
 * Modal manager context and types for ct-modal system
 *
 * Follows the KeyboardRouter pattern for cross-cutting UI coordination.
 * The ModalManager tracks open modals in a stack, allocates z-indices,
 * and coordinates Escape key handling so only the topmost dismissable
 * modal closes.
 */
import { createContext } from "@lit/context";

/**
 * Registration returned when a modal opens
 */
export interface ModalRegistration {
  /** Unique identifier for this modal instance */
  id: string;
  /** Reference to the modal element */
  element: HTMLElement;
  /** Whether the modal can be dismissed (backdrop click, Escape, X button) */
  dismissable: boolean;
  /** Allocated z-index for proper stacking */
  zIndex: number;
}

/**
 * Modal manager interface for coordinating modal stacking and dismissal
 */
export interface ModalManager {
  /**
   * Register a modal when it opens
   * @param modal - The modal element
   * @param dismissable - Whether the modal can be dismissed
   * @returns Registration with allocated z-index
   */
  register(modal: HTMLElement, dismissable: boolean): ModalRegistration;

  /**
   * Unregister a modal when it closes
   * @param id - The registration ID
   */
  unregister(id: string): void;

  /**
   * Check if a modal is the topmost in the stack
   * @param id - The registration ID
   * @returns true if this is the topmost modal
   */
  isTopModal(id: string): boolean;

  /**
   * Get the current modal stack depth
   * @returns Number of open modals
   */
  getStackDepth(): number;

  /**
   * Request close of the topmost dismissable modal (for Escape key)
   * @returns true if a modal was closed
   */
  requestCloseTop(): boolean;
}

/**
 * Context for sharing ModalManager across CT components
 */
export const modalContext = createContext<ModalManager | undefined>(
  Symbol("ct.modal-manager"),
);

/** Base z-index for modals (above ct-fab's 999) */
export const MODAL_BASE_Z_INDEX = 1000;

/** Z-index increment per stacked modal */
export const MODAL_Z_INDEX_INCREMENT = 10;
