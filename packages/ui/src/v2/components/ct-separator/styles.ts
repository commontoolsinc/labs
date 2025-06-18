/**
 * Styles for ct-separator component
 */

export const separatorStyles = `
  :host {
    display: block;
    
    /* Default color values if not provided */
    --border: #e2e8f0;
  }

  .separator {
    flex-shrink: 0;
    background-color: var(--border, #e2e8f0);
  }

  /* Horizontal orientation (default) */
  .separator.orientation-horizontal {
    height: 1px;
    width: 100%;
  }

  /* Vertical orientation */
  .separator.orientation-vertical {
    height: 100%;
    width: 1px;
  }

  /* When used in flex containers */
  :host([orientation="horizontal"]) {
    width: 100%;
    height: 1px;
  }

  :host([orientation="vertical"]) {
    width: 1px;
    height: 100%;
  }
`;
