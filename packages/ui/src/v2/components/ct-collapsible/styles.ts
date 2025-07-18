export const collapsibleStyles = `
  :host {
    display: block;
    width: 100%;
  }

  .collapsible {
    position: relative;
  }

  .trigger-wrapper {
    width: 100%;
  }

  /* Content wrapper for animation */
  .content-wrapper {
    overflow: hidden;
    transition: height 0.2s ease-out;
    height: 0;
    will-change: height;
  }

  .collapsible.open .content-wrapper {
    transition: height 0.2s ease-in;
  }

  .content {
    padding-top: 0.5rem;
  }

  /* Disabled state */
  .collapsible.disabled .trigger-wrapper {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* Slotted trigger styling hints */
  ::slotted([slot="trigger"]) {
    display: block;
    width: 100%;
    user-select: none;
    -webkit-user-select: none;
  }

  .collapsible.disabled ::slotted([slot="trigger"]) {
    pointer-events: none;
  }

  /* Focus styles for slotted triggers */
  ::slotted([slot="trigger"]:focus-visible) {
    outline: 2px solid hsl(var(--ring));
    outline-offset: 2px;
    border-radius: calc(var(--radius) - 2px);
  }

  /* Custom properties for theming */
  :host {
    --ring: 222.2 84% 4.9%;
    --radius: 0.5rem;
  }

  /* Dark mode support */
  @media (prefers-color-scheme: dark) {
    :host {
      --ring: 212.7 26.8% 83.9%;
    }
  }

  /* Allow external customization */
  :host([data-theme="dark"]) {
    --ring: 212.7 26.8% 83.9%;
  }

  /* Smooth height transitions */
  @media (prefers-reduced-motion: reduce) {
    .content-wrapper {
      transition: none;
    }
  }

  /* Additional accessibility styles */
  @media (prefers-contrast: high) {
    ::slotted([slot="trigger"]:focus-visible) {
      outline-width: 3px;
    }
  }
`;
