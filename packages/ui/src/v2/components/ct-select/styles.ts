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
  }

  *,
  *::before,
  *::after {
    box-sizing: border-box;
  }

  select {
    width: 100%;
    padding: 0.5rem 0.75rem;
    font-size: 0.875rem;
    line-height: 1.25rem;
    color: var(--ct-theme-color-text, #111827);
    background-color: var(--ct-theme-color-background, #ffffff);
    border: 1px solid var(--ct-theme-color-border, #e5e7eb);
    border-radius: var(--ct-theme-border-radius, 0.375rem);
    transition: all var(--ct-theme-animation-duration, 150ms)
      var(--ct-transition-timing-ease);
    font-family: var(--ct-theme-font-family, inherit);
    appearance: none;
    -moz-appearance: none; /* Firefox */
    background-image: url("data:image/svg+xml,%3Csvg width='12' height='8' xmlns='http://www.w3.org/2000/svg' fill='%23666666'%3E%3Cpath d='M6 8 0 0h12L6 8Z'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 0.75rem center;
    background-size: 12px 8px;
  }

  select:hover:not(:disabled):not(:focus) {
    border-color: var(--ct-theme-color-border, #d1d5db);
  }

  select:focus {
    outline: none;
    border-color: var(--ct-theme-color-primary, #3b82f6);
    box-shadow: 0 0 0 3px var(--ct-theme-color-primary, rgba(59, 130, 246, 0.15));
  }

  select:disabled {
    cursor: not-allowed;
    opacity: 0.5;
    background-color: var(--ct-theme-color-surface, #f1f5f9);
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
