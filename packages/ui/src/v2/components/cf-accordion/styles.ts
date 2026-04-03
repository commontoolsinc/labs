export const accordionStyles = `
  :host {
    display: block;
    width: 100%;
  }

  .accordion {
    display: flex;
    flex-direction: column;
    gap: var(--accordion-gap, 0);
  }

  /* Allow custom styling via CSS custom properties */
  :host {
    --accordion-gap: 0;
  }
`;
