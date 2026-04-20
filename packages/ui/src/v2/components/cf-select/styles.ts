/**
 * Styles for cf-select component
 *
 * This string can be imported and used alongside Lit's `unsafeCSS`
 * when composing styles externally, or referenced directly in
 * non-Lit environments.
 */

export const selectStyles = `
  :host {
    display: inline-block;
    width: 100%;

    /* Sizing scale defaults (size="m") */
    --select-height: var(--cf-size-m-height, 32px);
    --select-padding-x: var(--cf-size-m-padding-h, 8px);
    --select-padding-y: var(--cf-size-m-padding-v, 8px);
    --select-font-size: var(--cf-size-m-font-size, 12px);
    --select-border-radius: var(--cf-size-m-radius, 8px);
  }

  :host([size="xs"]) {
    --select-height: var(--cf-size-xs-height, 16px);
    --select-padding-x: var(--cf-size-xs-padding-h, 4px);
    --select-padding-y: var(--cf-size-xs-padding-v, 2px);
    --select-font-size: var(--cf-size-xs-font-size, 9px);
    --select-border-radius: var(--cf-size-xs-radius, 4px);
  }

  :host([size="s"]) {
    --select-height: var(--cf-size-s-height, 24px);
    --select-padding-x: var(--cf-size-s-padding-h, 6px);
    --select-padding-y: var(--cf-size-s-padding-v, 4px);
    --select-font-size: var(--cf-size-s-font-size, 11px);
    --select-border-radius: var(--cf-size-s-radius, 5px);
  }

  :host([size="l"]) {
    --select-height: var(--cf-size-l-height, 40px);
    --select-padding-x: var(--cf-size-l-padding-h, 12px);
    --select-padding-y: var(--cf-size-l-padding-v, 8px);
    --select-font-size: var(--cf-size-l-font-size, 16px);
    --select-border-radius: var(--cf-size-l-radius, 9px);
  }

  :host([size="xl"]) {
    --select-height: var(--cf-size-xl-height, 48px);
    --select-padding-x: var(--cf-size-xl-padding-h, 16px);
    --select-padding-y: var(--cf-size-xl-padding-v, 12px);
    --select-font-size: var(--cf-size-xl-font-size, 18px);
    --select-border-radius: var(--cf-size-xl-radius, 10px);
  }

  *,
  *::before,
  *::after {
    box-sizing: border-box;
  }

  select {
    width: 100%;
    height: var(--select-height);
    padding: var(--select-padding-y) var(--select-padding-x);
    font-size: var(--select-font-size);
    line-height: 1.25rem;
    color: var(--cf-theme-color-text, #111827);
    background-color: var(--cf-theme-color-background, #ffffff);
    border: 1px solid var(--cf-theme-color-border, #e5e7eb);
    border-radius: var(--select-border-radius);
    transition: all var(--cf-theme-animation-duration, 150ms)
      var(--cf-transition-timing-ease);
    font-family: var(--cf-theme-font-family, inherit);
    appearance: none;
    -moz-appearance: none; /* Firefox */
    background-image: url("data:image/svg+xml,%3Csvg width='12' height='8' xmlns='http://www.w3.org/2000/svg' fill='%23666666'%3E%3Cpath d='M6 8 0 0h12L6 8Z'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 0.75rem center;
    background-size: 12px 8px;
  }

  select:hover:not(:disabled):not(:focus) {
    border-color: var(--cf-theme-color-border, #d1d5db);
  }

  select:focus {
    outline: none;
    border-color: var(--cf-theme-color-primary, #3b82f6);
    box-shadow: 0 0 0 3px var(--cf-theme-color-primary, rgba(59, 130, 246, 0.15));
  }

  select:disabled {
    cursor: not-allowed;
    opacity: 0.5;
    background-color: var(--cf-theme-color-surface, #f1f5f9);
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
