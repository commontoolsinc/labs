/**
 * Styles for UI Tabs component
 */

export const tabsStyles = `
  :host {
    display: block;
    width: 100%;
  }

  .tabs {
    display: flex;
    flex-direction: column;
    width: 100%;
  }

  .tabs[data-orientation="horizontal"] {
    flex-direction: column;
  }

  .tabs[data-orientation="vertical"] {
    flex-direction: row;
  }

  /* Ensure proper layout for slotted content */
  ::slotted(ct-tab-list) {
    flex-shrink: 0;
  }

  ::slotted(ct-tab-panel) {
    flex: 1;
  }

  /* Handle vertical orientation */
  .tabs[data-orientation="vertical"] ::slotted(ct-tab-list) {
    flex-direction: column;
    height: 100%;
  }

  /* Ensure panels are properly hidden */
  ::slotted(ct-tab-panel[hidden]) {
    display: none !important;
  }
`;
