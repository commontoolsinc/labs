/**
 * Styles for ct-textarea component
 */

export const textareaStyles = `
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
    
    /* Textarea dimensions */
    --textarea-padding-x: 0.75rem;
    --textarea-padding-y: 0.5rem;
    --textarea-font-size: 0.875rem;
    --textarea-line-height: 1.25rem;
    --textarea-border-radius: 0.375rem;
    --textarea-min-height: 5rem;
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
    transition: all 150ms cubic-bezier(0.4, 0, 0.2, 1);
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
    box-shadow: 0 0 0 3px rgba(148, 163, 184, 0.1);
  }

  textarea:focus-visible {
    outline: 2px solid transparent;
    outline-offset: 2px;
    border-color: var(--ring);
    box-shadow: 0 0 0 3px rgba(148, 163, 184, 0.1);
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
    box-shadow: 0 0 0 3px rgba(220, 38, 38, 0.1);
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
    transition: background-color 150ms;
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
