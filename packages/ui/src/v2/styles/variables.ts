/**
 * Design tokens as CSS variables for web components
 * This file exports the CSS variables for use in shadow DOM
 */

export const variablesCSS = `
  /* Colors - Primary */
  --cf-colors-primary-50: #e3f2fd;
  --cf-colors-primary-100: #bbdefb;
  --cf-colors-primary-200: #90caf9;
  --cf-colors-primary-300: #64b5f6;
  --cf-colors-primary-400: #42a5f5;
  --cf-colors-primary-500: #2196f3;
  --cf-colors-primary-600: #1e88e5;
  --cf-colors-primary-700: #1976d2;
  --cf-colors-primary-800: #1565c0;
  --cf-colors-primary-900: #0d47a1;

  /* Colors - Gray */
  --cf-colors-gray-50: #fafafa;
  --cf-colors-gray-100: #f5f5f5;
  --cf-colors-gray-200: #eeeeee;
  --cf-colors-gray-300: #e0e0e0;
  --cf-colors-gray-400: #bdbdbd;
  --cf-colors-gray-500: #9e9e9e;
  --cf-colors-gray-600: #757575;
  --cf-colors-gray-700: #616161;
  --cf-colors-gray-800: #424242;
  --cf-colors-gray-900: #212121;

  /* Colors - Semantic */
  --cf-colors-success: #4caf50;
  --cf-colors-warning: #ff9800;
  --cf-colors-error: #f44336;
  --cf-colors-info: #2196f3;

  /* Typography - Font Family */
  --cf-font-family-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --cf-font-family-mono: Consolas, Monaco, "Andale Mono", "Ubuntu Mono", monospace;

  /* Typography - Font Size */
  --cf-font-size-xs: 0.75rem;
  --cf-font-size-sm: 0.875rem;
  --cf-font-size-base: 1rem;
  --cf-font-size-lg: 1.125rem;
  --cf-font-size-xl: 1.25rem;
  --cf-font-size-2xl: 1.5rem;
  --cf-font-size-3xl: 1.875rem;
  --cf-font-size-4xl: 2.25rem;

  /* Typography - Font Weight */
  --cf-font-weight-light: 300;
  --cf-font-weight-normal: 400;
  --cf-font-weight-medium: 500;
  --cf-font-weight-semibold: 600;
  --cf-font-weight-bold: 700;

  /* Typography - Line Height */
  --cf-line-height-none: 1;
  --cf-line-height-tight: 1.25;
  --cf-line-height-snug: 1.375;
  --cf-line-height-normal: 1.5;
  --cf-line-height-relaxed: 1.625;
  --cf-line-height-loose: 2;

  /* Spacing */
  --cf-spacing-0: 0;
  --cf-spacing-1: 0.25rem;
  --cf-spacing-2: 0.5rem;
  --cf-spacing-3: 0.75rem;
  --cf-spacing-4: 1rem;
  --cf-spacing-5: 1.25rem;
  --cf-spacing-6: 1.5rem;
  --cf-spacing-8: 2rem;
  --cf-spacing-10: 2.5rem;
  --cf-spacing-12: 3rem;
  --cf-spacing-16: 4rem;
  --cf-spacing-20: 5rem;
  --cf-spacing-24: 6rem;

  /* Border Radius */
  --cf-border-radius-none: 0;
  --cf-border-radius-sm: 0.125rem;
  --cf-border-radius-base: 0.25rem;
  --cf-border-radius-md: 0.375rem;
  --cf-border-radius-lg: 0.5rem;
  --cf-border-radius-xl: 0.75rem;
  --cf-border-radius-2xl: 1rem;
  --cf-border-radius-3xl: 1.5rem;
  --cf-border-radius-full: 9999px;

  /* Shadows */
  --cf-shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
  --cf-shadow-base: 0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.06);
  --cf-shadow-md: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
  --cf-shadow-lg: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05);
  --cf-shadow-xl: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
  --cf-shadow-none: none;

  /* Transitions - Duration */
  --cf-transition-duration-fast: 150ms;
  --cf-transition-duration-base: 200ms;
  --cf-transition-duration-slow: 300ms;

  /* Transitions - Timing */
  --cf-transition-timing-ease: cubic-bezier(0.4, 0, 0.2, 1);
  --cf-transition-timing-ease-in: cubic-bezier(0.4, 0, 1, 1);
  --cf-transition-timing-ease-out: cubic-bezier(0, 0, 0.2, 1);
  --cf-transition-timing-ease-in-out: cubic-bezier(0.4, 0, 0.2, 1);

  /* Z-index */
  --cf-z-index-auto: auto;
  --cf-z-index-0: 0;
  --cf-z-index-10: 10;
  --cf-z-index-20: 20;
  --cf-z-index-30: 30;
  --cf-z-index-40: 40;
  --cf-z-index-50: 50;
  --cf-z-index-100: 100;
  --cf-z-index-1000: 1000;
`;
