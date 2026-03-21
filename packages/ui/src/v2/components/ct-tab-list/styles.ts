/**
 * Styles for UI Tab List component
 */

export const tabListStyles = `
  :host {
    display: block;
    width: 100%;
  }

  .tab-list {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.25rem;
    background-color: var(--ct-theme-color-surface, #F3F1EB);
    border-radius: 0.625rem;
  }

  .tab-list[data-orientation="horizontal"] {
    flex-direction: row;
    width: 100%;
  }

  .tab-list[data-orientation="vertical"] {
    flex-direction: column;
    align-items: stretch;
    width: max-content;
    min-width: 200px;
  }

  /* Remove default button spacing in vertical orientation */
  .tab-list[data-orientation="vertical"] ::slotted(ct-tab) {
    width: 100%;
  }
`;
