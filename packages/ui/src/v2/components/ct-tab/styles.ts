/**
 * Styles for UI Tab component
 */

export const tabStyles = `
  :host {
    display: inline-block;
  }

  .tab {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    white-space: nowrap;
    cursor: pointer;
    user-select: none;
    padding: var(--ct-spacing-2) var(--ct-spacing-4);
    border: none;
    background: transparent;
    border-radius: var(--ct-border-radius-md);
    font-family: var(--ct-font-family-sans);
    font-size: var(--ct-font-size-sm);
    font-weight: var(--ct-font-weight-medium);
    line-height: var(--ct-line-height-normal);
    color: var(--ct-colors-gray-700);
    transition: all var(--ct-theme-animation-duration, 150ms)
      var(--ct-transition-timing-ease);
    outline: none;
    position: relative;
  }

  .tab:hover:not([data-disabled="true"]) {
    color: var(--ct-colors-gray-900);
    background-color: var(--ct-colors-gray-200);
  }

  .tab:focus-visible {
    box-shadow: 0 0 0 2px var(--ct-colors-primary-500);
  }

  .tab[data-selected="true"] {
    color: var(--ct-colors-gray-900);
    background-color: white;
    box-shadow: var(--ct-shadow-sm);
  }

  .tab[data-disabled="true"] {
    opacity: 0.5;
    cursor: not-allowed;
    color: var(--ct-colors-gray-500);
  }

  /* Vertical orientation adjustments */
  :host-context(ct-tab-list[orientation="vertical"]) .tab {
    width: 100%;
    justify-content: flex-start;
  }
`;
