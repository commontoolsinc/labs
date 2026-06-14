/**
 * Shared styles for web components
 */

/**
 * CSS reset styles for shadow DOM
 */
export const resetStyles = `
  :host {
    box-sizing: border-box;
    display: block;
  }
  
  *,
  *::before,
  *::after {
    box-sizing: inherit;
  }
  
  * {
    margin: 0;
    padding: 0;
  }
`;

/**
 * Focus styles
 */
export const focusStyles = `
  :focus {
    outline: 2px solid var(--cf-colors-primary-500);
    outline-offset: 2px;
  }
  
  :focus:not(:focus-visible) {
    outline: none;
  }
  
  :focus-visible {
    outline: 2px solid var(--cf-colors-primary-500);
    outline-offset: 2px;
  }
`;

/**
 * Button base styles
 */
export const buttonStyles = `
  button {
    font-family: var(--cf-font-family-sans);
    font-size: var(--cf-font-size-base);
    font-weight: var(--cf-font-weight-medium);
    line-height: var(--cf-line-height-normal);
    padding: var(--cf-spacing-2) var(--cf-spacing-4);
    border: none;
    border-radius: var(--cf-border-radius-md);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: all var(--cf-transition-duration-base) var(--cf-transition-timing-ease);
    user-select: none;
  }
  
  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
`;

/**
 * Input base styles
 */
export const inputStyles = `
  input,
  textarea,
  select {
    font-family: var(--cf-font-family-sans);
    font-size: var(--cf-font-size-base);
    line-height: var(--cf-line-height-normal);
    padding: var(--cf-spacing-2) var(--cf-spacing-3);
    border: 1px solid var(--cf-colors-gray-300);
    border-radius: var(--cf-border-radius-md);
    background-color: white;
    transition: all var(--cf-transition-duration-fast) var(--cf-transition-timing-ease);
    width: 100%;
  }
  
  input:hover,
  textarea:hover,
  select:hover {
    border-color: var(--cf-colors-gray-400);
  }
  
  input:focus,
  textarea:focus,
  select:focus {
    outline: none;
    border-color: var(--cf-colors-primary-500);
    box-shadow: 0 0 0 3px var(--cf-colors-primary-100);
  }
  
  input:disabled,
  textarea:disabled,
  select:disabled {
    background-color: var(--cf-colors-gray-100);
    cursor: not-allowed;
    opacity: 0.6;
  }
`;
