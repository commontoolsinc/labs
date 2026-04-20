/**
 * Design tokens as CSS variables for web components
 * This file exports the CSS variables for use in shadow DOM
 */

export const variablesCSS = `
  /* Colors - Primary (Figma blue ramp) */
  --cf-colors-primary-50: #eef2fe;
  --cf-colors-primary-100: #d5dffd;
  --cf-colors-primary-200: #b3c5fb;
  --cf-colors-primary-300: #8da8fa;
  --cf-colors-primary-400: #6b8ffa;
  --cf-colors-primary-500: #4979fa;
  --cf-colors-primary-600: #3e6af7;
  --cf-colors-primary-700: #376bf9;
  --cf-colors-primary-800: #2a54d4;
  --cf-colors-primary-900: #1e3faa;

  /* Colors - Gray (aligned to Figma slate) */
  --cf-colors-gray-50: #ffffff;
  --cf-colors-gray-100: #f2f3f6;
  --cf-colors-gray-200: #eceef1;
  --cf-colors-gray-300: #d5d7dd;
  --cf-colors-gray-400: #b3b6bc;
  --cf-colors-gray-500: #94979e;
  --cf-colors-gray-600: #5b5f65;
  --cf-colors-gray-700: #404349;
  --cf-colors-gray-800: #34373c;
  --cf-colors-gray-900: #16181d;

  /* Colors - Semantic */
  --cf-colors-success: #21c17b;
  --cf-colors-warning: #e5a126;
  --cf-colors-error: #ff6057;
  --cf-colors-info: #4979fa;

  /* Colors - Slate (Figma design system, canonical names) */
  --cf-colors-slate-000: #ffffff;
  --cf-colors-slate-100: #f2f3f6;
  --cf-colors-slate-150: #eceef1;
  --cf-colors-slate-300: #d5d7dd;
  --cf-colors-slate-400: #b3b6bc;
  --cf-colors-slate-450: #94979e;
  --cf-colors-slate-550: #5b5f65;
  --cf-colors-slate-600: #404349;
  --cf-colors-slate-700: #34373c;

  /* Colors - Named (Figma design system) */
  --cf-colors-blue: #4979fa;
  --cf-colors-blue-dark: #376bf9;
  --cf-colors-blue-a10: rgba(73, 121, 250, 0.1);
  --cf-colors-blue-a20: rgba(73, 121, 250, 0.15);
  --cf-colors-blue-a90: rgba(73, 121, 250, 0.9);

  --cf-colors-purple: #8952fd;
  --cf-colors-purple-dark: #632cda;
  --cf-colors-purple-a10: rgba(137, 82, 253, 0.1);
  --cf-colors-purple-a20: rgba(137, 82, 253, 0.15);

  --cf-colors-red: #ff6057;
  --cf-colors-red-dark: #eb4747;
  --cf-colors-red-a10: rgba(255, 96, 87, 0.1);
  --cf-colors-red-a20: rgba(255, 96, 87, 0.15);

  --cf-colors-green: #21c17b;
  --cf-colors-coral: #fc856d;
  --cf-colors-indigo: #5b53ff;

  /* Colors - Light alpha ramp */
  --cf-colors-alpha-00: rgba(13, 18, 24, 0);
  --cf-colors-alpha-03: rgba(37, 45, 54, 0.03);
  --cf-colors-alpha-06: rgba(46, 53, 64, 0.06);
  --cf-colors-alpha-10: rgba(54, 63, 74, 0.1);
  --cf-colors-alpha-20: rgba(79, 89, 103, 0.15);

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

  /* Backdrop Blur */
  --cf-backdrop-blur-sm: 4px;
  --cf-backdrop-blur-md: 8px;
  --cf-backdrop-blur-lg: 16px;
  --cf-backdrop-blur-xl: 24px;

  /* Translucent Surfaces */
  --cf-surface-translucent: rgba(255, 255, 255, 0.72);
  --cf-surface-translucent-strong: rgba(255, 255, 255, 0.88);
  --cf-overlay-dim: rgba(0, 0, 0, 0.4);

  /* Z-index — Semantic Layers */
  --cf-z-layer-sticky: 10;
  --cf-z-layer-fixed: 500;
  --cf-z-layer-fab: 900;
  --cf-z-layer-sheet: 950;
  --cf-z-layer-overlay: 1000;
  --cf-z-layer-toast: 1100;
`;
