/**
 * Styles for cf-message-input component
 *
 * These styles provide the base styling for the message input component
 * and can be imported separately if needed for customization.
 */

export const messageInputStyles = `
  :host {
    display: block;
    width: 100%;
    --cf-message-input-gap: var(--cf-spacing-2, 0.5rem);
    --cf-message-input-height: 2.5rem;
  }

  .container {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: var(--cf-message-input-gap);
    align-items: center;
  }

  /* Input styling */
  .container ::slotted(input),
  .container ::slotted(cf-input) {
    width: 100%;
    height: var(--cf-message-input-height);
  }

  /* Button styling */
  .container ::slotted(button),
  .container ::slotted(cf-button) {
    white-space: nowrap;
    height: var(--cf-message-input-height);
  }

  /* Disabled state */
  :host([disabled]) {
    opacity: 0.5;
    pointer-events: none;
  }

  /* Focus-within styling */
  :host(:focus-within) .container {
    --cf-message-input-ring: var(--ring, var(--cf-colors-primary-500));
  }

  /* Responsive adjustments */
  @media (max-width: 640px) {
    :host {
      --cf-message-input-gap: var(--cf-spacing-1, 0.25rem);
    }
  }
`;
