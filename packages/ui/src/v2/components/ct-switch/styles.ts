/**
 * Styles for ct-switch component
 */

export const switchStyles = `
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
    --input: #e2e8f0;
  }

  :host([disabled]) {
    cursor: not-allowed;
    opacity: 0.5;
  }

  :host:focus {
    outline: none;
  }

  :host:focus-visible .switch {
    outline: 2px solid transparent;
    outline-offset: 2px;
    box-shadow: 0 0 0 2px var(--background, #fff), 0 0 0 4px var(--ring, #94a3b8);
  }

  .switch {
    position: relative;
    width: 2rem; /* w-8 */
    height: 1.15rem; /* h-[1.15rem] */
    border-radius: 9999px; /* rounded-full */
    background-color: var(--input, #e2e8f0);
    transition: all 200ms cubic-bezier(0.4, 0, 0.2, 1);
    display: flex;
    align-items: center;
  }

  .switch.checked {
    background-color: var(--primary, #0f172a);
  }

  .switch.disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  /* Thumb element */
  .thumb {
    position: absolute;
    left: 0.125rem; /* 2px */
    width: 0.875rem; /* 14px */
    height: 0.875rem; /* 14px */
    border-radius: 9999px;
    background-color: var(--background, #fff);
    transition: transform 200ms cubic-bezier(0.4, 0, 0.2, 1);
    box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.06);
  }

  .switch.checked .thumb {
    transform: translateX(0.875rem); /* 14px - move to the right */
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
  :host(:not([disabled]):hover) .switch:not(.checked) {
    background-color: var(--border, #e2e8f0);
  }

  :host(:not([disabled]):hover) .switch.checked {
    opacity: 0.9;
  }

  /* Animation for thumb */
  .thumb {
    will-change: transform;
  }

  /* Ensure smooth transition even when changing state rapidly */
  .switch,
  .thumb {
    -webkit-backface-visibility: hidden;
    backface-visibility: hidden;
    -webkit-perspective: 1000px;
    perspective: 1000px;
  }
`;
