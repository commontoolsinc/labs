/**
 * Styles for cf-toggle component
 */

export const toggleStyles = `
  :host {
    --cf-toggle-height: 2.5rem;
    --cf-toggle-height-sm: 2.25rem;
    --cf-toggle-height-lg: 2.75rem;
    --cf-toggle-padding-x: 0.75rem;
    --cf-toggle-padding-x-sm: 0.625rem;
    --cf-toggle-padding-x-lg: 0.875rem;
    --cf-toggle-font-size: 0.875rem;
    --cf-toggle-font-size-sm: 0.875rem;
    --cf-toggle-font-size-lg: 1rem;

    /* Default color values if not provided */
    --cf-toggle-color-background: var(--cf-theme-color-background, #ffffff);
    --cf-toggle-color-foreground: var(--cf-theme-color-text, #0f172a);
    --cf-toggle-color-muted: var(--cf-theme-color-surface, #f8fafc);
    --cf-toggle-color-muted-foreground: var(--cf-theme-color-text-muted, #64748b);
    --cf-toggle-color-accent: var(--cf-theme-color-surface-hover, #f1f5f9);
    --cf-toggle-color-accent-foreground: var(--cf-theme-color-text, #0f172a);
    --cf-toggle-color-border: var(--cf-theme-color-border, #e2e8f0);
    --cf-toggle-color-ring: var(--cf-theme-color-primary, #94a3b8);

    display: inline-block;
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
    height: var(--cf-toggle-height);
    padding: 0 var(--cf-toggle-padding-x);
    font-size: var(--cf-toggle-font-size);
  }

  button:focus-visible {
    outline: 2px solid transparent;
    outline-offset: 2px;
    box-shadow: 0 0 0 2px var(--cf-toggle-color-background, #fff), 0 0 0 4px var(--cf-toggle-color-ring, #94a3b8);
  }

  button:disabled {
    pointer-events: none;
    opacity: 0.5;
  }

  /* Size variants */
  .size-sm {
    height: var(--cf-toggle-height-sm);
    padding: 0 var(--cf-toggle-padding-x-sm);
    font-size: var(--cf-toggle-font-size-sm);
  }

  .size-lg {
    height: var(--cf-toggle-height-lg);
    padding: 0 var(--cf-toggle-padding-x-lg);
    font-size: var(--cf-toggle-font-size-lg);
  }

  /* Default variant */
  .variant-default {
    background-color: transparent;
    color: var(--cf-toggle-color-foreground, #0f172a);
  }

  .variant-default:hover:not(:disabled) {
    background-color: var(--cf-toggle-color-muted, #f8fafc);
    color: var(--cf-toggle-color-foreground, #0f172a);
  }

  .variant-default.pressed {
    background-color: var(--cf-toggle-color-accent, #f1f5f9);
    color: var(--cf-toggle-color-accent-foreground, #0f172a);
  }

  .variant-default.pressed:hover:not(:disabled) {
    background-color: var(--cf-toggle-color-accent, #f1f5f9);
    opacity: 0.9;
  }

  /* Outline variant */
  .variant-outline {
    border: 1px solid var(--cf-toggle-color-border, #e2e8f0);
    background-color: transparent;
    color: var(--cf-toggle-color-foreground, #0f172a);
  }

  .variant-outline:hover:not(:disabled) {
    background-color: var(--cf-toggle-color-accent, #f1f5f9);
    color: var(--cf-toggle-color-accent-foreground, #0f172a);
  }

  .variant-outline.pressed {
    background-color: var(--cf-toggle-color-accent, #f1f5f9);
    color: var(--cf-toggle-color-accent-foreground, #0f172a);
  }

  .variant-outline.pressed:hover:not(:disabled) {
    background-color: var(--cf-toggle-color-accent, #f1f5f9);
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
