/**
 * Styles for ct-toggle component
 */

export const toggleStyles = `
  :host {
    display: inline-block;
    --toggle-height: 2.5rem;
    --toggle-height-sm: 2.25rem;
    --toggle-height-lg: 2.75rem;
    --toggle-padding-x: 0.75rem;
    --toggle-padding-x-sm: 0.625rem;
    --toggle-padding-x-lg: 0.875rem;
    --toggle-font-size: 0.875rem;
    --toggle-font-size-sm: 0.875rem;
    --toggle-font-size-lg: 1rem;
    
    /* Default color values if not provided */
    --background: #ffffff;
    --foreground: #0f172a;
    --muted: #f8fafc;
    --muted-foreground: #64748b;
    --accent: #f1f5f9;
    --accent-foreground: #0f172a;
    --border: #e2e8f0;
    --ring: #94a3b8;
  }

  button {
    all: unset;
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    white-space: nowrap;
    border-radius: 0.375rem;
    font-weight: 500;
    transition: all 150ms cubic-bezier(0.4, 0, 0.2, 1);
    cursor: pointer;
    user-select: none;
    -webkit-user-select: none;
    position: relative;
    font-family: inherit;
    line-height: 1;
    height: var(--toggle-height);
    padding: 0 var(--toggle-padding-x);
    font-size: var(--toggle-font-size);
  }

  button:focus-visible {
    outline: 2px solid transparent;
    outline-offset: 2px;
    box-shadow: 0 0 0 2px var(--background, #fff), 0 0 0 4px var(--ring, #94a3b8);
  }

  button:disabled {
    pointer-events: none;
    opacity: 0.5;
  }

  /* Size variants */
  .size-sm {
    height: var(--toggle-height-sm);
    padding: 0 var(--toggle-padding-x-sm);
    font-size: var(--toggle-font-size-sm);
  }

  .size-lg {
    height: var(--toggle-height-lg);
    padding: 0 var(--toggle-padding-x-lg);
    font-size: var(--toggle-font-size-lg);
  }

  /* Default variant */
  .variant-default {
    background-color: transparent;
    color: var(--foreground, #0f172a);
  }

  .variant-default:hover:not(:disabled) {
    background-color: var(--muted, #f8fafc);
    color: var(--foreground, #0f172a);
  }

  .variant-default.pressed {
    background-color: var(--accent, #f1f5f9);
    color: var(--accent-foreground, #0f172a);
  }

  .variant-default.pressed:hover:not(:disabled) {
    background-color: var(--accent, #f1f5f9);
    opacity: 0.9;
  }

  /* Outline variant */
  .variant-outline {
    border: 1px solid var(--border, #e2e8f0);
    background-color: transparent;
    color: var(--foreground, #0f172a);
  }

  .variant-outline:hover:not(:disabled) {
    background-color: var(--accent, #f1f5f9);
    color: var(--accent-foreground, #0f172a);
  }

  .variant-outline.pressed {
    background-color: var(--accent, #f1f5f9);
    color: var(--accent-foreground, #0f172a);
  }

  .variant-outline.pressed:hover:not(:disabled) {
    background-color: var(--accent, #f1f5f9);
    opacity: 0.9;
  }

  /* Host states */
  :host([disabled]) {
    pointer-events: none;
    opacity: 0.5;
  }

  /* Slot styles */
  ::slotted(*) {
    pointer-events: none;
  }
`;
