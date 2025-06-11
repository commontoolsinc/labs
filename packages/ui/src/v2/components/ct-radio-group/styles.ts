/**
 * Styles for ct-radio-group component
 */

export const radioGroupStyles = `
  :host {
    display: block;
    
    /* Default spacing values */
    --spacing: 0.5rem;
  }

  :host([disabled]) {
    cursor: not-allowed;
    opacity: 0.7;
  }

  .radio-group {
    display: flex;
    flex-direction: column;
    gap: var(--spacing, 0.5rem);
  }

  /* Support for horizontal layout if needed */
  :host([orientation="horizontal"]) .radio-group {
    flex-direction: row;
    flex-wrap: wrap;
  }

  /* Ensure proper spacing between radio buttons and their labels */
  ::slotted(ct-radio) {
    margin: 0;
  }

  /* When used with labels */
  ::slotted(label) {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
  }

  :host([disabled]) ::slotted(label) {
    cursor: not-allowed;
  }
`;
