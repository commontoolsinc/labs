/**
 * Styles for ct-radio component
 */

export const radioStyles = `
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

  :host:focus-visible .radio {
    outline: 2px solid transparent;
    outline-offset: 2px;
    box-shadow: 0 0 0 2px var(--background, #fff), 0 0 0 4px var(--ring, #94a3b8);
  }

  .radio {
    position: relative;
    width: 1rem; /* size-4 */
    height: 1rem; /* size-4 */
    border: 1px solid var(--primary, #0f172a);
    border-radius: 50%; /* Full circle */
    background-color: var(--background, #fff);
    transition: all 150ms cubic-bezier(0.4, 0, 0.2, 1);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .radio.checked {
    border-color: var(--primary, #0f172a);
  }

  .radio.disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  /* Radio indicator - filled circle */
  .indicator {
    width: 0.5rem; /* Half the size of the radio */
    height: 0.5rem;
    border-radius: 50%;
    background-color: var(--primary, #0f172a);
    opacity: 0;
    transform: scale(0);
    transition: all 150ms cubic-bezier(0.4, 0, 0.2, 1);
  }

  .radio.checked .indicator {
    opacity: 1;
    transform: scale(1);
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
  :host(:not([disabled]):hover) .radio:not(.checked) {
    border-color: var(--primary, #0f172a);
  }

  /* Animation for indicator */
  .radio.checked .indicator {
    animation: indicator-animation 200ms ease-out;
  }

  @keyframes indicator-animation {
    0% {
      transform: scale(0);
    }
    50% {
      transform: scale(1.2);
    }
    100% {
      transform: scale(1);
    }
  }
`;
