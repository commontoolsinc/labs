/**
 * Styles for ct-toggle component
 */

export const toggleStyles = `
  :host {
    display: inline-block;
    --ct-toggle-height: 2.5rem;
    --ct-toggle-height-sm: 2.25rem;
    --ct-toggle-height-lg: 2.75rem;
    --ct-toggle-padding-x: 0.75rem;
    --ct-toggle-padding-x-sm: 0.625rem;
    --ct-toggle-padding-x-lg: 0.875rem;
    --ct-toggle-font-size: 0.875rem;
    --ct-toggle-font-size-sm: 0.875rem;
    --ct-toggle-font-size-lg: 1rem;

    /* Default color values if not provided */
    --ct-toggle-color-background: var(--ct-theme-color-background, #ffffff);
    --ct-toggle-color-foreground: var(--ct-theme-color-text, #0f172a);
    --ct-toggle-color-muted: var(--ct-theme-color-surface, #f8fafc);
    --ct-toggle-color-muted-foreground: var(--ct-theme-color-text-muted, #64748b);
    --ct-toggle-color-accent: var(--ct-theme-color-surface-hover, #f1f5f9);
    --ct-toggle-color-accent-foreground: var(--ct-theme-color-text, #0f172a);
    --ct-toggle-color-border: var(--ct-theme-color-border, #e2e8f0);
    --ct-toggle-color-ring: var(--ct-theme-color-primary, #94a3b8);
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
    height: var(--ct-toggle-height);
    padding: 0 var(--ct-toggle-padding-x);
    font-size: var(--ct-toggle-font-size);
  }

  button:focus-visible {
    outline: 2px solid transparent;
    outline-offset: 2px;
    box-shadow: 0 0 0 2px var(--ct-toggle-color-background, #fff), 0 0 0 4px var(--ct-toggle-color-ring, #94a3b8);
  }

  button:disabled {
    pointer-events: none;
    opacity: 0.5;
  }

  /* Size variants */
  .size-sm {
    height: var(--ct-toggle-height-sm);
    padding: 0 var(--ct-toggle-padding-x-sm);
    font-size: var(--ct-toggle-font-size-sm);
  }

  .size-lg {
    height: var(--ct-toggle-height-lg);
    padding: 0 var(--ct-toggle-padding-x-lg);
    font-size: var(--ct-toggle-font-size-lg);
  }

  /* Default variant */
  .variant-default {
    background-color: transparent;
    color: var(--ct-toggle-color-foreground, #0f172a);
  }

  .variant-default:hover:not(:disabled) {
    background-color: var(--ct-toggle-color-muted, #f8fafc);
    color: var(--ct-toggle-color-foreground, #0f172a);
  }

  .variant-default.pressed {
    background-color: var(--ct-toggle-color-accent, #f1f5f9);
    color: var(--ct-toggle-color-accent-foreground, #0f172a);
  }

  .variant-default.pressed:hover:not(:disabled) {
    background-color: var(--ct-toggle-color-accent, #f1f5f9);
    opacity: 0.9;
  }

  /* Outline variant */
  .variant-outline {
    border: 1px solid var(--ct-toggle-color-border, #e2e8f0);
    background-color: transparent;
    color: var(--ct-toggle-color-foreground, #0f172a);
  }

  .variant-outline:hover:not(:disabled) {
    background-color: var(--ct-toggle-color-accent, #f1f5f9);
    color: var(--ct-toggle-color-accent-foreground, #0f172a);
  }

  .variant-outline.pressed {
    background-color: var(--ct-toggle-color-accent, #f1f5f9);
    color: var(--ct-toggle-color-accent-foreground, #0f172a);
  }

  .variant-outline.pressed:hover:not(:disabled) {
    background-color: var(--ct-toggle-color-accent, #f1f5f9);
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
