export const accordionItemStyles = `
  :host {
    display: block;
    width: 100%;
    border-bottom: 1px solid hsl(var(--border));
  }

  .accordion-item {
    position: relative;
  }

  .trigger {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 1rem 0;
    font-size: 0.875rem;
    font-weight: 500;
    text-align: left;
    background: transparent;
    border: none;
    cursor: pointer;
    transition: all 0.2s ease;
    color: inherit;
    font-family: inherit;
    line-height: 1.5;
  }

  .trigger:hover:not(:disabled) {
    text-decoration: underline;
  }

  .trigger:focus-visible {
    outline: 2px solid hsl(var(--ring));
    outline-offset: 2px;
  }

  .trigger:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  /* Chevron icon using CSS */
  .chevron {
    display: inline-block;
    width: 1rem;
    height: 1rem;
    position: relative;
    transition: transform 0.2s ease;
    flex-shrink: 0;
    margin-left: 0.5rem;
  }

  .chevron::before {
    content: '';
    position: absolute;
    width: 0.625rem;
    height: 0.625rem;
    border-right: 2px solid currentColor;
    border-bottom: 2px solid currentColor;
    top: 25%;
    left: 50%;
    transform: translateX(-50%) rotate(45deg);
    transition: transform 0.2s ease;
  }

  .accordion-item.expanded .chevron {
    transform: rotate(180deg);
  }

  /* Content wrapper for animation */
  .content-wrapper {
    overflow: hidden;
    transition: height 0.2s ease-out;
    height: 0;
  }

  .content {
    padding: 0 0 1rem 0;
    font-size: 0.875rem;
    line-height: 1.5;
  }

  /* Custom properties for theming */
  :host {
    --border: 214.3 31.8% 91.4%;
    --ring: 222.2 84% 4.9%;
  }

  /* Dark mode support */
  @media (prefers-color-scheme: dark) {
    :host {
      --border: 217.2 32.6% 17.5%;
      --ring: 212.7 26.8% 83.9%;
    }
  }

  /* Allow external customization */
  :host([data-theme="dark"]) {
    --border: 217.2 32.6% 17.5%;
    --ring: 212.7 26.8% 83.9%;
  }
`;
