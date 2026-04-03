/**
 * Styles for UI Tab Panel component
 */

export const tabPanelStyles = `
  :host {
    display: block;
    width: 100%;
  }

  :host([hidden]) {
    display: none !important;
  }

  .tab-panel {
    padding: var(--ct-spacing-6);
    background-color: white;
    border-radius: var(--ct-border-radius-md);
    width: 100%;
    animation: fadeIn var(--ct-transition-duration-base) var(--ct-transition-timing-ease);
  }

  @keyframes fadeIn {
    from {
      opacity: 0;
      transform: translateY(2px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  /* Focus styles for keyboard navigation */
  .tab-panel:focus {
    outline: 2px solid var(--ct-colors-primary-500);
    outline-offset: 2px;
  }

  /* Vertical orientation adjustments */
  :host-context(ct-tabs[orientation="vertical"]) .tab-panel {
    margin-left: var(--ct-spacing-4);
  }
`;
