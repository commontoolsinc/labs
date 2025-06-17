/**
 * Styles for ct-input component
 */

export const inputStyles = `
  :host {
    display: block;
    width: 100%;
    
    /* Default color values if not provided */
    --background: #ffffff;
    --foreground: #0f172a;
    --border: #e2e8f0;
    --ring: #94a3b8;
    --destructive: #dc2626;
    --muted: #f8fafc;
    --muted-foreground: #64748b;
    --placeholder: #94a3b8;
    
    /* Input dimensions */
    --input-height: 2.5rem;
    --input-padding-x: 0.75rem;
    --input-padding-y: 0.5rem;
    --input-font-size: 0.875rem;
    --input-border-radius: 0.375rem;
  }

  input {
    all: unset;
    box-sizing: border-box;
    width: 100%;
    height: var(--input-height);
    padding: var(--input-padding-y) var(--input-padding-x);
    font-size: var(--input-font-size);
    line-height: 1.25rem;
    font-family: inherit;
    color: var(--foreground);
    background-color: var(--background);
    border: 1px solid var(--border);
    border-radius: var(--input-border-radius);
    transition: all 150ms cubic-bezier(0.4, 0, 0.2, 1);
    display: flex;
    align-items: center;
  }

  input::placeholder {
    color: var(--placeholder);
    opacity: 1;
  }

  input::-webkit-input-placeholder {
    color: var(--placeholder);
    opacity: 1;
  }

  input::-moz-placeholder {
    color: var(--placeholder);
    opacity: 1;
  }

  input:-ms-input-placeholder {
    color: var(--placeholder);
    opacity: 1;
  }

  /* Focus state */
  input:focus {
    outline: 2px solid transparent;
    outline-offset: 2px;
    border-color: var(--ring);
    box-shadow: 0 0 0 3px rgba(148, 163, 184, 0.1);
  }

  input:focus-visible {
    outline: 2px solid transparent;
    outline-offset: 2px;
    border-color: var(--ring);
    box-shadow: 0 0 0 3px rgba(148, 163, 184, 0.1);
  }

  /* Disabled state */
  input:disabled {
    cursor: not-allowed;
    opacity: 0.5;
    background-color: var(--muted);
  }

  /* Readonly state */
  input:read-only {
    background-color: var(--muted);
    cursor: default;
  }

  /* Error state */
  input.error {
    border-color: var(--destructive);
  }

  input.error:focus,
  input.error:focus-visible {
    border-color: var(--destructive);
    box-shadow: 0 0 0 3px rgba(220, 38, 38, 0.1);
  }

  /* File input specific styles */
  input[type="file"] {
    font-size: var(--input-font-size);
    padding: calc(var(--input-padding-y) * 0.5) var(--input-padding-x);
  }

  input[type="file"]::-webkit-file-upload-button {
    all: unset;
    font-family: inherit;
    font-size: var(--input-font-size);
    font-weight: 500;
    padding: 0.25rem 0.75rem;
    margin-right: 0.5rem;
    background-color: var(--muted);
    color: var(--foreground);
    border: 1px solid var(--border);
    border-radius: calc(var(--input-border-radius) * 0.75);
    cursor: pointer;
    transition: all 150ms cubic-bezier(0.4, 0, 0.2, 1);
  }

  input[type="file"]::-webkit-file-upload-button:hover {
    background-color: var(--border);
  }

  input[type="file"]::file-selector-button {
    all: unset;
    font-family: inherit;
    font-size: var(--input-font-size);
    font-weight: 500;
    padding: 0.25rem 0.75rem;
    margin-right: 0.5rem;
    background-color: var(--muted);
    color: var(--foreground);
    border: 1px solid var(--border);
    border-radius: calc(var(--input-border-radius) * 0.75);
    cursor: pointer;
    transition: all 150ms cubic-bezier(0.4, 0, 0.2, 1);
  }

  input[type="file"]::file-selector-button:hover {
    background-color: var(--border);
  }

  /* Number input - hide spinners */
  input[type="number"]::-webkit-inner-spin-button,
  input[type="number"]::-webkit-outer-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }

  input[type="number"] {
    -moz-appearance: textfield;
  }

  /* Search input - hide clear button */
  input[type="search"]::-webkit-search-decoration,
  input[type="search"]::-webkit-search-cancel-button,
  input[type="search"]::-webkit-search-results-button,
  input[type="search"]::-webkit-search-results-decoration {
    -webkit-appearance: none;
  }

  /* Date/time inputs */
  input[type="date"],
  input[type="time"],
  input[type="datetime-local"],
  input[type="month"],
  input[type="week"] {
    position: relative;
  }

  input[type="date"]::-webkit-calendar-picker-indicator,
  input[type="time"]::-webkit-calendar-picker-indicator,
  input[type="datetime-local"]::-webkit-calendar-picker-indicator,
  input[type="month"]::-webkit-calendar-picker-indicator,
  input[type="week"]::-webkit-calendar-picker-indicator {
    cursor: pointer;
    opacity: 0.6;
    transition: opacity 150ms;
  }

  input[type="date"]::-webkit-calendar-picker-indicator:hover,
  input[type="time"]::-webkit-calendar-picker-indicator:hover,
  input[type="datetime-local"]::-webkit-calendar-picker-indicator:hover,
  input[type="month"]::-webkit-calendar-picker-indicator:hover,
  input[type="week"]::-webkit-calendar-picker-indicator:hover {
    opacity: 1;
  }

  /* Color input */
  input[type="color"] {
    padding: 0.25rem;
    cursor: pointer;
  }

  input[type="color"]::-webkit-color-swatch-wrapper {
    padding: 0;
  }

  input[type="color"]::-webkit-color-swatch {
    border: none;
    border-radius: calc(var(--input-border-radius) * 0.5);
  }

  input[type="color"]::-moz-color-swatch {
    border: none;
    border-radius: calc(var(--input-border-radius) * 0.5);
  }

  /* Autofill styles */
  input:-webkit-autofill,
  input:-webkit-autofill:hover,
  input:-webkit-autofill:focus {
    -webkit-text-fill-color: var(--foreground);
    -webkit-box-shadow: 0 0 0px 1000px var(--muted) inset;
    transition: background-color 5000s ease-in-out 0s;
  }

  /* Selection styles */
  input::selection {
    background-color: var(--ring);
    color: var(--background);
    opacity: 0.3;
  }

  input::-moz-selection {
    background-color: var(--ring);
    color: var(--background);
    opacity: 0.3;
  }
`;
