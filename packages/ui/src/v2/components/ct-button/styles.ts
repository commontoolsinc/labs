/**
 * Styles for ct-button component
 */

export const buttonStyles = `
  :host {
    display: inline-block;
    --button-height: 2.5rem;
    --button-height-sm: 2.25rem;
    --button-height-lg: 2.75rem;
    --button-padding-x: var(--ct-spacing-4);
    --button-padding-x-sm: var(--ct-spacing-3);
    --button-padding-x-lg: var(--ct-spacing-5);
    --button-font-size: var(--ct-font-size-sm);
    --button-font-size-sm: var(--ct-font-size-sm);
    --button-font-size-lg: var(--ct-font-size-base);
    --button-icon-size: 2.5rem;
    
    /* Default color values if not provided */
    --background: #ffffff;
    --foreground: var(--ct-colors-gray-900);
    --primary: var(--ct-colors-primary-500);
    --primary-foreground: #ffffff;
    --secondary: var(--ct-colors-gray-100);
    --secondary-foreground: var(--ct-colors-gray-900);
    --destructive: var(--ct-colors-error);
    --destructive-foreground: #ffffff;
    --accent: var(--ct-colors-gray-100);
    --accent-foreground: var(--ct-colors-gray-900);
    --border: var(--ct-colors-gray-300);
    --ring: var(--ct-colors-primary-500);
  }

  button {
    all: unset;
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    white-space: nowrap;
    border-radius: var(--ct-border-radius-md);
    font-weight: var(--ct-font-weight-medium);
    transition: all var(--ct-transition-duration-fast) var(--ct-transition-timing-ease);
    cursor: pointer;
    user-select: none;
    -webkit-user-select: none;
    position: relative;
    font-family: inherit;
    line-height: 1;
    height: var(--button-height);
    padding: 0 var(--button-padding-x);
    font-size: var(--button-font-size);
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
  :host([size="sm"]) button {
    height: var(--button-height-sm);
    padding: 0 var(--button-padding-x-sm);
    font-size: var(--button-font-size-sm);
  }

  :host([size="lg"]) button {
    height: var(--button-height-lg);
    padding: 0 var(--button-padding-x-lg);
    font-size: var(--button-font-size-lg);
  }

  :host([size="icon"]) button {
    height: var(--button-icon-size);
    width: var(--button-icon-size);
    padding: 0;
  }

  /* Default variant */
  :host(:not([variant])) button,
  :host([variant="default"]) button {
    background-color: var(--primary, #0f172a);
    color: var(--primary-foreground, #f8fafc);
  }

  :host(:not([variant])) button:hover:not(:disabled),
  :host([variant="default"]) button:hover:not(:disabled) {
    background-color: var(--primary, #0f172a);
    opacity: 0.9;
  }

  /* Destructive variant */
  :host([variant="destructive"]) button {
    background-color: var(--destructive, #dc2626);
    color: var(--destructive-foreground, #fef2f2);
  }

  :host([variant="destructive"]) button:hover:not(:disabled) {
    background-color: var(--destructive, #dc2626);
    opacity: 0.9;
  }

  /* Outline variant */
  :host([variant="outline"]) button {
    border: 1px solid var(--border, #e2e8f0);
    background-color: var(--background, #fff);
    color: var(--foreground, #0f172a);
  }

  :host([variant="outline"]) button:hover:not(:disabled) {
    background-color: var(--accent, #f8fafc);
    color: var(--accent-foreground, #0f172a);
  }

  /* Secondary variant */
  :host([variant="secondary"]) button {
    background-color: var(--secondary, #f1f5f9);
    color: var(--secondary-foreground, #0f172a);
  }

  :host([variant="secondary"]) button:hover:not(:disabled) {
    background-color: var(--secondary, #f1f5f9);
    opacity: 0.8;
  }

  /* Ghost variant */
  :host([variant="ghost"]) button {
    background-color: transparent;
    color: var(--foreground, #0f172a);
  }

  :host([variant="ghost"]) button:hover:not(:disabled) {
    background-color: var(--accent, #f8fafc);
    color: var(--accent-foreground, #0f172a);
  }

  /* Link variant */
  :host([variant="link"]) button {
    background-color: transparent;
    color: var(--primary, #0f172a);
    text-decoration: underline;
    text-underline-offset: 4px;
    height: auto;
    padding: 0;
  }

  :host([variant="link"]) button:hover:not(:disabled) {
    text-decoration: underline;
  }

  /* Slot styles */
  ::slotted(*) {
    pointer-events: none;
  }
`;
