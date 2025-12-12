import { css } from "lit";

export const styles = css`
  :host {
    display: block;
    min-height: 100px;
  }

  .richtext-editor {
    width: 100%;
    height: 100%;
    border: 1px solid var(--ct-border-color, #e0e0e0);
    border-radius: var(--ct-border-radius, 4px);
    overflow: hidden;
  }

  .richtext-editor:focus-within {
    outline: 2px solid var(--ct-focus-color, #4a90d9);
    outline-offset: -2px;
  }

  /* TipTap ProseMirror styles */
  .ProseMirror {
    padding: 12px 16px;
    min-height: inherit;
    outline: none;
    font-family: var(--ct-font-family, system-ui, sans-serif);
    font-size: var(--ct-font-size, 14px);
    line-height: 1.6;
  }

  .ProseMirror p {
    margin: 0 0 0.75em 0;
  }

  .ProseMirror p:last-child {
    margin-bottom: 0;
  }

  .ProseMirror h1,
  .ProseMirror h2,
  .ProseMirror h3,
  .ProseMirror h4,
  .ProseMirror h5,
  .ProseMirror h6 {
    margin: 1em 0 0.5em 0;
    font-weight: 600;
    line-height: 1.3;
  }

  .ProseMirror h1:first-child,
  .ProseMirror h2:first-child,
  .ProseMirror h3:first-child {
    margin-top: 0;
  }

  .ProseMirror h1 { font-size: 1.75em; }
  .ProseMirror h2 { font-size: 1.5em; }
  .ProseMirror h3 { font-size: 1.25em; }
  .ProseMirror h4 { font-size: 1.1em; }

  .ProseMirror ul,
  .ProseMirror ol {
    margin: 0.5em 0;
    padding-left: 1.5em;
  }

  .ProseMirror li {
    margin: 0.25em 0;
  }

  .ProseMirror blockquote {
    margin: 0.75em 0;
    padding-left: 1em;
    border-left: 3px solid var(--ct-border-color, #e0e0e0);
    color: var(--ct-text-muted, #666);
  }

  .ProseMirror code {
    background: var(--ct-code-bg, #f5f5f5);
    padding: 0.2em 0.4em;
    border-radius: 3px;
    font-family: var(--ct-mono-font, monospace);
    font-size: 0.9em;
  }

  .ProseMirror pre {
    background: var(--ct-code-bg, #f5f5f5);
    padding: 0.75em 1em;
    border-radius: 4px;
    overflow-x: auto;
  }

  .ProseMirror pre code {
    background: none;
    padding: 0;
  }

  .ProseMirror hr {
    border: none;
    border-top: 1px solid var(--ct-border-color, #e0e0e0);
    margin: 1em 0;
  }

  .ProseMirror a {
    color: var(--ct-link-color, #4a90d9);
    text-decoration: underline;
  }

  .ProseMirror strong {
    font-weight: 600;
  }

  .ProseMirror em {
    font-style: italic;
  }

  /* Placeholder */
  .ProseMirror p.is-editor-empty:first-child::before {
    content: attr(data-placeholder);
    color: var(--ct-placeholder-color, #aaa);
    pointer-events: none;
    float: left;
    height: 0;
  }

  /* Collaboration cursor styles */
  .collaboration-cursor__caret {
    position: relative;
    border-left: 2px solid currentColor;
    border-right: none;
    margin-left: -1px;
    margin-right: -1px;
    pointer-events: none;
    word-break: normal;
  }

  .collaboration-cursor__label {
    position: absolute;
    top: -1.4em;
    left: -1px;
    font-size: 11px;
    font-weight: 600;
    line-height: 1;
    padding: 2px 4px;
    border-radius: 3px 3px 3px 0;
    white-space: nowrap;
    user-select: none;
    pointer-events: none;
    color: white;
  }

  /* Disabled state */
  :host([disabled]) .ProseMirror {
    opacity: 0.6;
    pointer-events: none;
    background: var(--ct-disabled-bg, #f9f9f9);
  }

  /* Read-only state */
  :host([readonly]) .ProseMirror {
    background: var(--ct-readonly-bg, #fafafa);
  }
`;
