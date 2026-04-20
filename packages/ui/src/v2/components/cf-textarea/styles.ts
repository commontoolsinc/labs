/**
 * Styles for cf-textarea component
 */

export const textareaStyles = `
  :host {
    display: block;
    width: 100%;
    
    /* Map to theme tokens */
    --background: var(--cf-theme-color-background, #ffffff);
    --foreground: var(--cf-theme-color-text, #0f172a);
    --border: var(--cf-theme-color-border, #e2e8f0);
    --ring: var(--cf-theme-color-primary, #3b82f6);
    --destructive: var(--cf-theme-color-error, #dc2626);
    --muted: var(--cf-theme-color-surface, #f8fafc);
    --muted-foreground: var(--cf-theme-color-text-muted, #64748b);
    --placeholder: var(--cf-theme-color-text-muted, #94a3b8);
    
    /* Textarea dimensions — default size M */
    --textarea-padding-x: var(--cf-size-m-padding-h, 8px);
    --textarea-padding-y: var(--cf-size-m-padding-v, 8px);
    --textarea-font-size: var(--cf-size-m-font-size, 12px);
    --textarea-line-height: var(--cf-size-m-line-height, 16px);
    --textarea-border-radius: var(--cf-size-m-radius, 8px);
    --textarea-min-height: 5rem;
  }

  :host([size="xs"]) {
    --textarea-padding-x: var(--cf-size-xs-padding-h, 4px);
    --textarea-padding-y: var(--cf-size-xs-padding-v, 2px);
    --textarea-font-size: var(--cf-size-xs-font-size, 9px);
    --textarea-line-height: var(--cf-size-xs-line-height, 12px);
    --textarea-border-radius: var(--cf-size-xs-radius, 4px);
  }

  :host([size="s"]) {
    --textarea-padding-x: var(--cf-size-s-padding-h, 6px);
    --textarea-padding-y: var(--cf-size-s-padding-v, 4px);
    --textarea-font-size: var(--cf-size-s-font-size, 11px);
    --textarea-line-height: var(--cf-size-s-line-height, 16px);
    --textarea-border-radius: var(--cf-size-s-radius, 5px);
  }

  :host([size="l"]) {
    --textarea-padding-x: var(--cf-size-l-padding-h, 12px);
    --textarea-padding-y: var(--cf-size-l-padding-v, 8px);
    --textarea-font-size: var(--cf-size-l-font-size, 16px);
    --textarea-line-height: var(--cf-size-l-line-height, 20px);
    --textarea-border-radius: var(--cf-size-l-radius, 9px);
  }

  :host([size="xl"]) {
    --textarea-padding-x: var(--cf-size-xl-padding-h, 16px);
    --textarea-padding-y: var(--cf-size-xl-padding-v, 12px);
    --textarea-font-size: var(--cf-size-xl-font-size, 18px);
    --textarea-line-height: var(--cf-size-xl-line-height, 24px);
    --textarea-border-radius: var(--cf-size-xl-radius, 10px);
  }

  textarea {
    all: unset;
    box-sizing: border-box;
    width: 100%;
    min-height: var(--textarea-min-height);
    padding: var(--textarea-padding-y) var(--textarea-padding-x);
    font-size: var(--textarea-font-size);
    line-height: var(--textarea-line-height);
    font-family: inherit;
    color: var(--foreground);
    background-color: var(--background);
    border: 1px solid var(--border);
    border-radius: var(--textarea-border-radius);
    transition: all var(--cf-theme-animation-duration, 150ms)
      var(--cf-transition-timing-ease);
    display: block;
    overflow: auto;
    word-wrap: break-word;
    white-space: pre-wrap;
  }

  /* Default resize behavior */
  textarea {
    resize: vertical;
  }

  /* Override resize when specified */
  textarea[style*="resize: none"] {
    resize: none !important;
  }

  textarea[style*="resize: horizontal"] {
    resize: horizontal !important;
  }

  textarea[style*="resize: both"] {
    resize: both !important;
  }

  textarea::placeholder {
    color: var(--placeholder);
    opacity: 1;
  }

  textarea::-webkit-input-placeholder {
    color: var(--placeholder);
    opacity: 1;
  }

  textarea::-moz-placeholder {
    color: var(--placeholder);
    opacity: 1;
  }

  textarea:-ms-input-placeholder {
    color: var(--placeholder);
    opacity: 1;
  }

  /* Focus state */
  textarea:focus {
    outline: 2px solid transparent;
    outline-offset: 2px;
    border-color: var(--ring);
    box-shadow: 0 0 0 3px var(--cf-theme-color-primary, rgba(59, 130, 246, 0.15));
  }

  textarea:focus-visible {
    outline: 2px solid transparent;
    outline-offset: 2px;
    border-color: var(--ring);
    box-shadow: 0 0 0 3px var(--cf-theme-color-primary, rgba(59, 130, 246, 0.15));
  }

  /* Disabled state */
  textarea:disabled {
    cursor: not-allowed;
    opacity: 0.5;
    background-color: var(--muted);
    resize: none;
  }

  /* Readonly state */
  textarea:read-only {
    background-color: var(--muted);
    cursor: default;
  }

  /* Error state */
  textarea.error {
    border-color: var(--destructive);
  }

  textarea.error:focus,
  textarea.error:focus-visible {
    border-color: var(--destructive);
    box-shadow: 0 0 0 3px var(--cf-theme-color-error, rgba(220, 38, 38, 0.1));
  }

  /* Scrollbar styling */
  textarea::-webkit-scrollbar {
    width: 0.5rem;
    height: 0.5rem;
  }

  textarea::-webkit-scrollbar-track {
    background-color: var(--muted);
    border-radius: calc(var(--textarea-border-radius) * 0.5);
  }

  textarea::-webkit-scrollbar-thumb {
    background-color: var(--border);
    border-radius: calc(var(--textarea-border-radius) * 0.5);
    transition: background-color var(--cf-theme-animation-duration, 150ms);
  }

  textarea::-webkit-scrollbar-thumb:hover {
    background-color: var(--muted-foreground);
  }

  /* Firefox scrollbar styling */
  textarea {
    scrollbar-width: thin;
    scrollbar-color: var(--border) var(--muted);
  }

  /* Autofill styles */
  textarea:-webkit-autofill,
  textarea:-webkit-autofill:hover,
  textarea:-webkit-autofill:focus {
    -webkit-text-fill-color: var(--foreground);
    -webkit-box-shadow: 0 0 0px 1000px var(--muted) inset;
    transition: background-color 5000s ease-in-out 0s;
  }

  /* Selection styles */
  textarea::selection {
    background-color: var(--ring);
    color: var(--background);
    opacity: 0.3;
  }

  textarea::-moz-selection {
    background-color: var(--ring);
    color: var(--background);
    opacity: 0.3;
  }

  /* Auto-resize specific styles */
  :host([auto-resize]) textarea {
    overflow-y: hidden;
  }
`;
