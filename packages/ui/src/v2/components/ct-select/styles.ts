/**
 * Styles for ct-select component
 *
 * This string can be imported and used alongside Lit's `unsafeCSS`
 * when composing styles externally, or referenced directly in
 * non-Lit environments.
 */

export const selectStyles = `
  :host {
    display: inline-block;
    width: 100%;
    --select-padding-y: 0.5rem;
    --select-padding-x: 0.75rem;
    --select-font-size: var(--ct-font-size-sm);
    --select-line-height: 1.25rem;
    --select-border-radius: var(--ct-border-radius-md);
    --select-border: var(--border, hsl(0, 0%, 89%));
    --select-border-hover: var(--border-hover, hsl(0, 0%, 78%));
    --select-foreground: var(--foreground, hsl(0, 0%, 9%));
    --select-background: var(--background, hsl(0, 0%, 100%));
    --select-ring: var(--ring, hsl(212, 100%, 47%));
    --select-ring-alpha: var(--ring-alpha, hsla(212, 100%, 47%, 0.1));
    --select-muted: var(--muted, hsl(0, 0%, 96%));
  }

  *,
  *::before,
  *::after {
    box-sizing: border-box;
  }

  select {
    width: 100%;
    padding: var(--select-padding-y) var(--select-padding-x);
    font-size: var(--select-font-size);
    line-height: var(--select-line-height);
    color: var(--select-foreground);
    background-color: var(--select-background);
    border: 1px solid var(--select-border);
    border-radius: var(--select-border-radius);
    transition: all var(--ct-transition-duration-fast) var(--ct-transition-timing-ease);
    font-family: inherit;
    appearance: none;
    -moz-appearance: none; /* Firefox */
    background-image: url("data:image/svg+xml,%3Csvg width='12' height='8' xmlns='http://www.w3.org/2000/svg' fill='%23666666'%3E%3Cpath d='M6 8 0 0h12L6 8Z'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 0.75rem center;
    background-size: 12px 8px;
  }

  select:hover:not(:disabled):not(:focus) {
    border-color: var(--select-border-hover);
  }

  select:focus {
    outline: none;
    border-color: var(--select-ring);
    box-shadow: 0 0 0 3px var(--select-ring-alpha);
  }

  select:disabled {
    cursor: not-allowed;
    opacity: 0.5;
    background-color: var(--select-muted);
  }

  /* Remove dropdown arrow when multiple is set */
  :host([multiple]) select {
    background-image: none;
  }

  /* Placeholder (disabled) option */
  option[disabled][hidden] {
    display: none;
  }
`;