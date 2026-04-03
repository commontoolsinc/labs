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
    gap: var(--ct-spacing-1);
    padding: var(--ct-spacing-1);
    background-color: var(--ct-colors-gray-100);
    border-radius: var(--ct-border-radius-md);
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
