/**
 * Styles for ct-toggle-group component
 */

export const toggleGroupStyles = `
  :host {
    display: inline-flex;
    --group-gap: 0;
    --border: #e2e8f0;
    --background: #ffffff;
  }

  .toggle-group {
    display: inline-flex;
    align-items: center;
    justify-content: flex-start;
    gap: var(--group-gap);
    background-color: var(--background);
    border-radius: 0.375rem;
    padding: 0.25rem;
  }

  /* Direct children styling */
  ::slotted(ct-toggle) {
    border-radius: 0.25rem;
  }

  /* Variant: connected toggles (no gap) */
  :host([variant="connected"]) .toggle-group {
    gap: 0;
    border: 1px solid var(--border);
    padding: 0;
  }

  :host([variant="connected"]) ::slotted(ct-toggle) {
    border-radius: 0;
    border-right: 1px solid var(--border);
  }

  :host([variant="connected"]) ::slotted(ct-toggle:first-child) {
    border-top-left-radius: 0.375rem;
    border-bottom-left-radius: 0.375rem;
  }

  :host([variant="connected"]) ::slotted(ct-toggle:last-child) {
    border-top-right-radius: 0.375rem;
    border-bottom-right-radius: 0.375rem;
    border-right: none;
  }

  /* Disabled state */
  :host([disabled]) {
    pointer-events: none;
    opacity: 0.5;
  }

  /* Orientation variants */
  :host([orientation="vertical"]) {
    display: inline-flex;
  }

  :host([orientation="vertical"]) .toggle-group {
    flex-direction: column;
    align-items: stretch;
  }

  :host([orientation="vertical"][variant="connected"]) ::slotted(ct-toggle) {
    border-right: none;
    border-bottom: 1px solid var(--border);
  }

  :host([orientation="vertical"][variant="connected"]) ::slotted(ct-toggle:first-child) {
    border-top-left-radius: 0.375rem;
    border-top-right-radius: 0.375rem;
    border-bottom-left-radius: 0;
    border-bottom-right-radius: 0;
  }

  :host([orientation="vertical"][variant="connected"]) ::slotted(ct-toggle:last-child) {
    border-bottom-left-radius: 0.375rem;
    border-bottom-right-radius: 0.375rem;
    border-top-left-radius: 0;
    border-top-right-radius: 0;
    border-bottom: none;
  }
`;
