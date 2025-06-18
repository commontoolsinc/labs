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
    outline: 2px solid var(--ct-colors-primary-500);
    outline-offset: 2px;
  }
  
  :focus:not(:focus-visible) {
    outline: none;
  }
  
  :focus-visible {
    outline: 2px solid var(--ct-colors-primary-500);
    outline-offset: 2px;
  }
`;

/**
 * Button base styles
 */
export const buttonStyles = `
  button {
    font-family: var(--ct-font-family-sans);
    font-size: var(--ct-font-size-base);
    font-weight: var(--ct-font-weight-medium);
    line-height: var(--ct-line-height-normal);
    padding: var(--ct-spacing-2) var(--ct-spacing-4);
    border: none;
    border-radius: var(--ct-border-radius-md);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: all var(--ct-transition-duration-base) var(--ct-transition-timing-ease);
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
    font-family: var(--ct-font-family-sans);
    font-size: var(--ct-font-size-base);
    line-height: var(--ct-line-height-normal);
    padding: var(--ct-spacing-2) var(--ct-spacing-3);
    border: 1px solid var(--ct-colors-gray-300);
    border-radius: var(--ct-border-radius-md);
    background-color: white;
    transition: all var(--ct-transition-duration-fast) var(--ct-transition-timing-ease);
    width: 100%;
  }
  
  input:hover,
  textarea:hover,
  select:hover {
    border-color: var(--ct-colors-gray-400);
  }
  
  input:focus,
  textarea:focus,
  select:focus {
    outline: none;
    border-color: var(--ct-colors-primary-500);
    box-shadow: 0 0 0 3px var(--ct-colors-primary-100);
  }
  
  input:disabled,
  textarea:disabled,
  select:disabled {
    background-color: var(--ct-colors-gray-100);
    cursor: not-allowed;
    opacity: 0.6;
  }
`;
