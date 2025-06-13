/**
 * Styles for ct-badge component
 */

export const badgeStyles = `
  :host {
    display: inline-flex;
    
    /* Default color values if not provided */
    --background: #ffffff;
    --foreground: #0f172a;
    --primary: #0f172a;
    --primary-foreground: #f8fafc;
    --secondary: #f1f5f9;
    --secondary-foreground: #0f172a;
    --destructive: #dc2626;
    --destructive-foreground: #fef2f2;
    --border: #e2e8f0;
    --ring: #94a3b8;
  }

  .badge {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    border-radius: 0.375rem;
    border: 1px solid transparent;
    padding: 0.125rem 0.5rem;
    font-size: 0.75rem;
    font-weight: 600;
    line-height: 1;
    transition: all 150ms cubic-bezier(0.4, 0, 0.2, 1);
    white-space: nowrap;
    font-family: inherit;
  }

  /* Default variant */
  .badge.variant-default {
    background-color: var(--primary, #0f172a);
    color: var(--primary-foreground, #f8fafc);
  }

  /* Secondary variant */
  .badge.variant-secondary {
    background-color: var(--secondary, #f1f5f9);
    color: var(--secondary-foreground, #0f172a);
  }

  /* Destructive variant */
  .badge.variant-destructive {
    background-color: var(--destructive, #dc2626);
    color: var(--destructive-foreground, #fef2f2);
  }

  /* Outline variant */
  .badge.variant-outline {
    background-color: transparent;
    color: var(--foreground, #0f172a);
    border-color: var(--border, #e2e8f0);
  }

  /* Close button styles */
  .close-button {
    all: unset;
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    margin-left: 0.125rem;
    margin-right: -0.25rem;
    opacity: 0.7;
    transition: opacity 150ms cubic-bezier(0.4, 0, 0.2, 1);
    border-radius: 0.25rem;
    padding: 0;
    width: 14px;
    height: 14px;
  }

  .close-button:hover {
    opacity: 1;
  }

  .close-button:focus-visible {
    outline: 2px solid transparent;
    outline-offset: 2px;
    box-shadow: 0 0 0 2px var(--ring, #94a3b8);
  }

  .close-button svg {
    width: 14px;
    height: 14px;
  }

  /* Hover states for different variants */
  .badge.variant-default .close-button:hover {
    background-color: rgba(248, 250, 252, 0.2);
  }

  .badge.variant-secondary .close-button:hover,
  .badge.variant-outline .close-button:hover {
    background-color: rgba(15, 23, 42, 0.1);
  }

  .badge.variant-destructive .close-button:hover {
    background-color: rgba(254, 242, 242, 0.2);
  }

  /* Slot styles */
  ::slotted(*) {
    pointer-events: none;
  }
`;
