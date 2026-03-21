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
    padding: 0.5rem 1rem;
    border: none;
    background: transparent;
    border-radius: 0.5rem;
    font-family: var(--ct-theme-font-family, inherit);
    font-size: 0.875rem;
    font-weight: 700;
    line-height: 1.5;
    color: var(--ct-theme-color-text-muted, #7A7D72);
    transition: all var(--ct-theme-animation-duration, 150ms)
      cubic-bezier(0.25, 0.1, 0.25, 1);
    outline: none;
    position: relative;
    -webkit-font-smoothing: antialiased;
  }

  .tab:hover:not([data-disabled="true"]) {
    color: var(--ct-theme-color-text, #2C3227);
    background-color: var(--ct-theme-color-surface-hover, #E8E6DD);
  }

  .tab:active:not([data-disabled="true"]) {
    transform: scale(0.97);
    transition-duration: 0.1s;
  }

  .tab:focus-visible {
    box-shadow:
      0 0 0 2px var(--ct-theme-color-background, #FDFCF9),
      0 0 0 4px var(--ct-theme-color-primary, #2D8C3C);
  }

  .tab[data-selected="true"] {
    color: var(--ct-theme-color-text, #2C3227);
    background-color: var(--ct-theme-color-background, #FDFCF9);
    box-shadow:
      0 1px 3px rgba(60, 70, 50, 0.1),
      0 1px 2px rgba(60, 70, 50, 0.06);
  }

  .tab[data-disabled="true"] {
    opacity: 0.4;
    cursor: not-allowed;
    color: var(--ct-theme-color-text-muted, #7A7D72);
  }

  /* Vertical orientation adjustments */
  :host-context(ct-tab-list[orientation="vertical"]) .tab {
    width: 100%;
    justify-content: flex-start;
  }
`;
