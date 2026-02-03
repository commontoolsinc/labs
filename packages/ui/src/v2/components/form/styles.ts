/**
 * Styles for ct-form component
 */

export const formStyles = `
  :host {
    display: block;
    width: 100%;
    
    /* Default color values if not provided */
    --background: #ffffff;
    --foreground: #0f172a;
    --border: #e2e8f0;
    --ring: #94a3b8;
    
    /* Form spacing variables */
    --form-gap: 1.5rem;
    --form-field-gap: 0.5rem;
    --form-padding: 0;
  }

  form {
    display: flex;
    flex-direction: column;
    gap: var(--form-gap);
    padding: var(--form-padding);
    width: 100%;
  }

  /* Direct children spacing */
  ::slotted(*) {
    margin: 0;
  }

  /* Common form field patterns */
  ::slotted(ct-label) {
    margin-bottom: var(--form-field-gap);
  }

  /* Field groups (divs, fieldsets) */
  ::slotted(div),
  ::slotted(fieldset) {
    display: flex;
    flex-direction: column;
    gap: var(--form-field-gap);
    margin: 0;
    padding: 0;
    border: none;
  }

  /* Horizontal field groups */
  ::slotted(.form-row),
  ::slotted([data-orientation="horizontal"]) {
    flex-direction: row;
    align-items: center;
    gap: 1rem;
  }

  /* Form sections */
  ::slotted(.form-section) {
    display: flex;
    flex-direction: column;
    gap: var(--form-gap);
  }

  /* Button groups typically at form bottom */
  ::slotted(.form-actions),
  ::slotted(.form-buttons) {
    display: flex;
    gap: 0.75rem;
    margin-top: 0.5rem;
  }

  /* Responsive adjustments */
  @media (max-width: 640px) {
    ::slotted(.form-row),
    ::slotted([data-orientation="horizontal"]) {
      flex-direction: column;
      align-items: stretch;
    }
    
    ::slotted(.form-actions),
    ::slotted(.form-buttons) {
      flex-direction: column;
    }
    
    ::slotted(.form-actions) ct-button,
    ::slotted(.form-buttons) ct-button {
      width: 100%;
    }
  }
`;
