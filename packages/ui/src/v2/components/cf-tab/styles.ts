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
    padding: var(--cf-spacing-2) var(--cf-spacing-4);
    border: none;
    background: transparent;
    border-radius: var(--cf-border-radius-md);
    font-family: var(--cf-font-family-sans);
    font-size: var(--cf-font-size-sm);
    font-weight: var(--cf-font-weight-medium);
    line-height: var(--cf-line-height-normal);
    color: var(--cf-colors-gray-700);
    transition: all var(--cf-theme-animation-duration, 150ms)
      var(--cf-transition-timing-ease);
    outline: none;
    position: relative;
  }

  .tab:hover:not([data-disabled="true"]) {
    color: var(--cf-colors-gray-900);
    background-color: var(--cf-colors-gray-200);
  }

  .tab:focus-visible {
    box-shadow: 0 0 0 2px var(--cf-colors-primary-500);
  }

  .tab[data-selected="true"] {
    color: var(--cf-colors-gray-900);
    background-color: white;
    box-shadow: var(--cf-shadow-sm);
  }

  .tab[data-disabled="true"] {
    opacity: 0.5;
    cursor: not-allowed;
    color: var(--cf-colors-gray-500);
  }

  /* Vertical orientation adjustments */
  :host-context(cf-tab-list[orientation="vertical"]) .tab {
    width: 100%;
    justify-content: flex-start;
  }
`;
