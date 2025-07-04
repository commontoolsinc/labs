import type { KeyboardContext, EditingKeyboardContext, OutlinerOperations, Node } from "./types.ts";
import { NodeUtils } from "./node-utils.ts";

/**
 * Pure utility functions for event handling
 * These functions create contexts and analyze events without side effects
 */
export const EventUtils = {
  /**
   * Create keyboard event context from component state
   */
  createKeyboardContext(
    event: KeyboardEvent,
    component: OutlinerOperations,
    focusedNode: Node | null
  ): KeyboardContext {
    const allNodes = component.getAllVisibleNodes();
    const currentIndex = focusedNode ? allNodes.indexOf(focusedNode) : -1;
    
    return {
      event,
      component,
      allNodes,
      currentIndex,
      focusedNode
    };
  },

  /**
   * Create editing keyboard context
   */
  createEditingKeyboardContext(
    event: KeyboardEvent,
    component: OutlinerOperations,
    editingNode: Node,
    editingContent: string,
    textarea: HTMLTextAreaElement
  ): EditingKeyboardContext {
    return {
      event,
      component,
      editingNode,
      editingContent,
      textarea
    };
  },

  /**
   * Check if key is a typing character (letter, number, punctuation)
   */
  isTypingKey(key: string, event: KeyboardEvent): boolean {
    return key.length === 1 && 
           !event.ctrlKey && 
           !event.metaKey && 
           !event.altKey;
  },

  /**
   * Check if event has modifier keys
   */
  hasModifiers(event: KeyboardEvent): boolean {
    return event.ctrlKey || event.metaKey || event.altKey || event.shiftKey;
  },

  /**
   * Check if event is a command key (cmd on Mac, ctrl on others)
   */
  isCommandKey(event: KeyboardEvent): boolean {
    return event.metaKey || event.ctrlKey;
  },

  /**
   * Check if key is a navigation key
   */
  isNavigationKey(key: string): boolean {
    return ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"].includes(key);
  },

  /**
   * Check if key is a special key (not printable)
   */
  isSpecialKey(key: string): boolean {
    return key.length > 1 || EventUtils.isNavigationKey(key);
  },

  /**
   * Get friendly key name for display
   */
  getKeyDisplayName(key: string, event: KeyboardEvent): string {
    const modifiers = [];
    
    if (event.ctrlKey) modifiers.push("Ctrl");
    if (event.metaKey) modifiers.push("Cmd");
    if (event.altKey) modifiers.push("Alt");
    if (event.shiftKey) modifiers.push("Shift");
    
    const keyName = key === " " ? "Space" : key;
    
    return modifiers.length > 0 
      ? `${modifiers.join("+")}+${keyName}`
      : keyName;
  },

  /**
   * Check if cursor is at text boundary in textarea
   */
  isCursorAtBoundary(textarea: HTMLTextAreaElement): {
    atStart: boolean;
    atEnd: boolean;
    atFirstLine: boolean;
    atLastLine: boolean;
  } {
    const { value, selectionStart, selectionEnd } = textarea;
    const textBeforeCursor = value.substring(0, selectionStart);
    const textAfterCursor = value.substring(selectionEnd);
    
    return {
      atStart: selectionStart === 0,
      atEnd: selectionEnd === value.length,
      atFirstLine: !textBeforeCursor.includes('\n'),
      atLastLine: !textAfterCursor.includes('\n')
    };
  },

  /**
   * Extract cursor position info from textarea
   */
  getCursorInfo(textarea: HTMLTextAreaElement): {
    position: number;
    line: number;
    column: number;
    selectedText: string;
    hasSelection: boolean;
  } {
    const { value, selectionStart, selectionEnd } = textarea;
    const textBeforeCursor = value.substring(0, selectionStart);
    const lines = textBeforeCursor.split('\n');
    
    return {
      position: selectionStart,
      line: lines.length - 1,
      column: lines[lines.length - 1].length,
      selectedText: value.substring(selectionStart, selectionEnd),
      hasSelection: selectionStart !== selectionEnd
    };
  }
};