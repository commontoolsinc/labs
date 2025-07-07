/**
 * Styles for ct-message-input component
 *
 * These styles provide the base styling for the message input component
 * and can be imported separately if needed for customization.
 */

export const messageInputStyles = `
  :host {
    display: block;
    width: 100%;
    --ct-message-input-gap: var(--ct-spacing-2, 0.5rem);
    --ct-message-input-height: 2.5rem;
  }

  .container {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: var(--ct-message-input-gap);
    align-items: center;
  }

  /* Input styling */
  .container ::slotted(input),
  .container ::slotted(ct-input) {
    width: 100%;
    height: var(--ct-message-input-height);
  }

  /* Button styling */
  .container ::slotted(button),
  .container ::slotted(ct-button) {
    white-space: nowrap;
    height: var(--ct-message-input-height);
  }

  /* Disabled state */
  :host([disabled]) {
    opacity: 0.5;
    pointer-events: none;
  }

  /* Focus-within styling */
  :host(:focus-within) .container {
    --ct-message-input-ring: var(--ring, var(--ct-colors-primary-500));
  }

  /* Responsive adjustments */
  @media (max-width: 640px) {
    :host {
      --ct-message-input-gap: var(--ct-spacing-1, 0.25rem);
    }
  }
`;
