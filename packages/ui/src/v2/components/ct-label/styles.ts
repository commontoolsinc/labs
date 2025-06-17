/**
 * Styles for ct-label component
 */

export const labelStyles = `
  :host {
    display: inline-block;
    --label-font-size: 0.875rem;
    --label-font-weight: 500;
    --label-line-height: 1;
    --label-color: var(--foreground, #0f172a);
    --label-disabled-opacity: 0.7;
    --required-color: var(--destructive, #dc2626);
    
    /* Default color values if not provided */
    --background: #ffffff;
    --foreground: #0f172a;
    --destructive: #dc2626;
    --muted-foreground: #64748b;
  }

  .label {
    display: inline-flex;
    align-items: baseline;
    gap: 0.25rem;
    font-size: var(--label-font-size);
    font-weight: var(--label-font-weight);
    line-height: var(--label-line-height);
    color: var(--label-color);
    cursor: default;
    user-select: none;
    -webkit-user-select: none;
    font-family: inherit;
  }

  /* When label has a 'for' attribute, make it clickable */
  :host([for]) .label {
    cursor: pointer;
  }

  /* Disabled state */
  .label.disabled {
    cursor: not-allowed;
    opacity: var(--label-disabled-opacity);
  }

  :host([for][disabled]) .label {
    cursor: not-allowed;
  }

  /* Required indicator */
  .required-indicator {
    color: var(--required-color);
    font-weight: var(--label-font-weight);
    margin-left: 0.125rem;
  }

  /* Hover effect for clickable labels */
  :host([for]:not([disabled])) .label:hover {
    color: var(--muted-foreground, #64748b);
  }

  /* Focus-visible styles when label receives keyboard focus */
  :host(:focus-visible) {
    outline: none;
  }

  :host(:focus-visible) .label {
    outline: 2px solid var(--ring, #94a3b8);
    outline-offset: 2px;
    border-radius: 0.125rem;
  }

  /* Slot styles */
  ::slotted(*) {
    pointer-events: none;
  }

  /* Animation for required indicator */
  @keyframes pulse {
    0% {
      opacity: 1;
    }
    50% {
      opacity: 0.5;
    }
    100% {
      opacity: 1;
    }
  }

  :host([required]:focus-within) .required-indicator {
    animation: pulse 2s ease-in-out infinite;
  }
`;
