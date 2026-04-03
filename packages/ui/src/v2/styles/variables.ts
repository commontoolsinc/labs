/**
 * Design tokens as CSS variables for web components
 * This file exports the CSS variables for use in shadow DOM
 */

export const variablesCSS = `
  /* Colors - Primary */
  --ct-colors-primary-50: #e3f2fd;
  --ct-colors-primary-100: #bbdefb;
  --ct-colors-primary-200: #90caf9;
  --ct-colors-primary-300: #64b5f6;
  --ct-colors-primary-400: #42a5f5;
  --ct-colors-primary-500: #2196f3;
  --ct-colors-primary-600: #1e88e5;
  --ct-colors-primary-700: #1976d2;
  --ct-colors-primary-800: #1565c0;
  --ct-colors-primary-900: #0d47a1;

  /* Colors - Gray */
  --ct-colors-gray-50: #fafafa;
  --ct-colors-gray-100: #f5f5f5;
  --ct-colors-gray-200: #eeeeee;
  --ct-colors-gray-300: #e0e0e0;
  --ct-colors-gray-400: #bdbdbd;
  --ct-colors-gray-500: #9e9e9e;
  --ct-colors-gray-600: #757575;
  --ct-colors-gray-700: #616161;
  --ct-colors-gray-800: #424242;
  --ct-colors-gray-900: #212121;

  /* Colors - Semantic */
  --ct-colors-success: #4caf50;
  --ct-colors-warning: #ff9800;
  --ct-colors-error: #f44336;
  --ct-colors-info: #2196f3;

  /* Typography - Font Family */
  --ct-font-family-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --ct-font-family-mono: Consolas, Monaco, "Andale Mono", "Ubuntu Mono", monospace;

  /* Typography - Font Size */
  --ct-font-size-xs: 0.75rem;
  --ct-font-size-sm: 0.875rem;
  --ct-font-size-base: 1rem;
  --ct-font-size-lg: 1.125rem;
  --ct-font-size-xl: 1.25rem;
  --ct-font-size-2xl: 1.5rem;
  --ct-font-size-3xl: 1.875rem;
  --ct-font-size-4xl: 2.25rem;

  /* Typography - Font Weight */
  --ct-font-weight-light: 300;
  --ct-font-weight-normal: 400;
  --ct-font-weight-medium: 500;
  --ct-font-weight-semibold: 600;
  --ct-font-weight-bold: 700;

  /* Typography - Line Height */
  --ct-line-height-none: 1;
  --ct-line-height-tight: 1.25;
  --ct-line-height-snug: 1.375;
  --ct-line-height-normal: 1.5;
  --ct-line-height-relaxed: 1.625;
  --ct-line-height-loose: 2;

  /* Spacing */
  --ct-spacing-0: 0;
  --ct-spacing-1: 0.25rem;
  --ct-spacing-2: 0.5rem;
  --ct-spacing-3: 0.75rem;
  --ct-spacing-4: 1rem;
  --ct-spacing-5: 1.25rem;
  --ct-spacing-6: 1.5rem;
  --ct-spacing-8: 2rem;
  --ct-spacing-10: 2.5rem;
  --ct-spacing-12: 3rem;
  --ct-spacing-16: 4rem;
  --ct-spacing-20: 5rem;
  --ct-spacing-24: 6rem;

  /* Border Radius */
  --ct-border-radius-none: 0;
  --ct-border-radius-sm: 0.125rem;
  --ct-border-radius-base: 0.25rem;
  --ct-border-radius-md: 0.375rem;
  --ct-border-radius-lg: 0.5rem;
  --ct-border-radius-xl: 0.75rem;
  --ct-border-radius-2xl: 1rem;
  --ct-border-radius-3xl: 1.5rem;
  --ct-border-radius-full: 9999px;

  /* Shadows */
  --ct-shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
  --ct-shadow-base: 0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.06);
  --ct-shadow-md: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
  --ct-shadow-lg: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05);
  --ct-shadow-xl: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
  --ct-shadow-none: none;

  /* Transitions - Duration */
  --ct-transition-duration-fast: 150ms;
  --ct-transition-duration-base: 200ms;
  --ct-transition-duration-slow: 300ms;

  /* Transitions - Timing */
  --ct-transition-timing-ease: cubic-bezier(0.4, 0, 0.2, 1);
  --ct-transition-timing-ease-in: cubic-bezier(0.4, 0, 1, 1);
  --ct-transition-timing-ease-out: cubic-bezier(0, 0, 0.2, 1);
  --ct-transition-timing-ease-in-out: cubic-bezier(0.4, 0, 0.2, 1);

  /* Z-index */
  --ct-z-index-auto: auto;
  --ct-z-index-0: 0;
  --ct-z-index-10: 10;
  --ct-z-index-20: 20;
  --ct-z-index-30: 30;
  --ct-z-index-40: 40;
  --ct-z-index-50: 50;
  --ct-z-index-100: 100;
  --ct-z-index-1000: 1000;
`;
