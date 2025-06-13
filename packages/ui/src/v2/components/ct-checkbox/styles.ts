/**
 * Styles for ct-checkbox component
 */

export const checkboxStyles = `
  :host {
    display: inline-block;
    position: relative;
    cursor: pointer;
    line-height: 0;
    
    /* Default color values if not provided */
    --background: #ffffff;
    --foreground: #0f172a;
    --primary: #0f172a;
    --primary-foreground: #f8fafc;
    --border: #e2e8f0;
    --ring: #94a3b8;
  }

  :host([disabled]) {
    cursor: not-allowed;
    opacity: 0.5;
  }

  :host:focus {
    outline: none;
  }

  :host:focus-visible .checkbox {
    outline: 2px solid transparent;
    outline-offset: 2px;
    box-shadow: 0 0 0 2px var(--background, #fff), 0 0 0 4px var(--ring, #94a3b8);
  }

  .checkbox {
    position: relative;
    width: 1rem; /* size-4 */
    height: 1rem; /* size-4 */
    border: 1px solid var(--primary, #0f172a);
    border-radius: 0.25rem; /* rounded */
    background-color: var(--background, #fff);
    transition: all 150ms cubic-bezier(0.4, 0, 0.2, 1);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .checkbox.checked,
  .checkbox.indeterminate {
    background-color: var(--primary, #0f172a);
    border-color: var(--primary, #0f172a);
  }

  .checkbox.disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  /* Checkmark using CSS transforms */
  .checkmark {
    display: none;
    width: 10px;
    height: 6px;
    position: relative;
  }

  .checkbox.checked .checkmark {
    display: block;
  }

  .checkbox.checked .checkmark::after {
    content: '';
    position: absolute;
    left: 0;
    top: 2px;
    width: 4px;
    height: 7px;
    border: solid var(--primary-foreground, #f8fafc);
    border-width: 0 2px 2px 0;
    transform: rotate(45deg);
  }

  /* Indeterminate state - horizontal line */
  .checkbox.indeterminate .checkmark {
    display: block;
    width: 8px;
    height: 2px;
    background-color: var(--primary-foreground, #f8fafc);
  }

  .checkbox.indeterminate .checkmark::after {
    display: none;
  }

  /* Hidden native input for form compatibility */
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border-width: 0;
  }

  /* Hover state */
  :host(:not([disabled]):hover) .checkbox:not(.checked):not(.indeterminate) {
    border-color: var(--primary, #0f172a);
  }

  /* Animation for checkmark */
  .checkbox.checked .checkmark::after {
    animation: checkmark-animation 200ms ease-out;
  }

  @keyframes checkmark-animation {
    0% {
      transform: rotate(45deg) scale(0);
    }
    100% {
      transform: rotate(45deg) scale(1);
    }
  }
`;
